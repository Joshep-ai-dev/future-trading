"""Research lab for the SuperTrend Scalper: step-by-step comparison, parameter search and walk-forward.

Data is split chronologically (after a warm-up) into train (60%), validation
(20%) and out-of-sample test (20%). The parameter search samples the user's
ranges at random, scores each set on *train only*, then checks the best ones
on validation; the test period is reported for the final choice only and is
never used to choose. Walk-forward repeats search-then-test on rolling
windows and joins the test pieces.

Score = expectancy in R x sqrt(trades): it rewards a positive average trade
that is also supported by enough trades; sets with fewer than ``min_trades``
or a drawdown worse than ``max_drawdown_pct`` score -inf. Win rate is
reported but never optimised on its own.
"""
from __future__ import annotations

import math
import threading
import time
import uuid
from dataclasses import replace

import numpy as np
import pandas as pd

from server.strategies.st_scalper import (VARIANTS, Settings, breakdown, entries, indicators, load_events, metrics,
                                          simulate, variant)

WARMUP_DAYS = 10
# Parameter -> (kind, low, high, step). The UI offers exactly these ranges.
SEARCH_SPACE = {
    'st_length': ('int', 7, 21, 1),
    'st_multiplier': ('float', 2., 5., .25),
    'adx_threshold': ('float', 20., 35., 1.),
    'rsi_long_min': ('float', 45., 60., 1.),
    'rsi_short_max': ('float', 40., 55., 1.),
    'stop_atr': ('float', 1., 2.5, .25),
    'target_atr': ('float', 1., 4., .25),
    'ema_fast_length': ('int', 20, 100, 5),
}
INDICATOR_KEYS = ('st_length', 'st_multiplier', 'ema_fast_length', 'adx_threshold', 'htf_timeframe', 'htf_ema_length',
                  'atr_window', 'atr_pct_min', 'atr_pct_max')


def splits(index: pd.DatetimeIndex) -> dict[str, tuple[pd.Timestamp, pd.Timestamp]]:
    start = index[0]+pd.Timedelta(days=WARMUP_DAYS)
    end = index[-1]+pd.Timedelta(minutes=5)
    span = end-start
    a, b = start+span*.6, start+span*.8
    return dict(train=(start, a), validation=(a, b), test=(b, end))


class Lab:
    """Holds one data set with cached indicators per indicator-affecting parameter set."""

    def __init__(self, frame: pd.DataFrame, costs: dict, events=None, bar_seconds: int = 300):
        self.frame = frame.dropna(subset=['open', 'high', 'low', 'close'])
        self.costs = costs
        self.events = load_events() if events is None else events
        self.bar_seconds = bar_seconds
        self.cache: dict[tuple, pd.DataFrame] = {}
        self.periods = splits(self.frame.index)

    def bars(self, s: Settings) -> pd.DataFrame:
        key = tuple(getattr(s, name) for name in INDICATOR_KEYS)
        if key not in self.cache:
            if len(self.cache) > 64:
                self.cache.clear()
            self.cache[key] = indicators(self.frame, s, self.bar_seconds)
        return self.cache[key]

    def run(self, s: Settings, period: str | tuple) -> dict:
        start, end = self.periods[period] if isinstance(period, str) else period
        bars = self.bars(s)
        return simulate(bars, entries(bars, s, self.bar_seconds, self.events), s, bar_seconds=self.bar_seconds,
                        start=start, end=end, **self.costs)

    def evaluate(self, s: Settings, period) -> dict:
        return metrics(self.run(s, period), s.initial_capital)


def score(m: dict, min_trades: int, max_drawdown_pct: float) -> float:
    if m['trades'] < min_trades or m['expectancyR'] is None or m['maxDrawdownPct'] < -abs(max_drawdown_pct):
        return -math.inf
    return float(m['expectancyR']*math.sqrt(m['trades']))


def compare(lab: Lab, base: Settings) -> dict:
    """The six variants on train / validation / test, plus session, regime, side and exit breakdowns over all data."""
    rows = []
    all_data = (lab.periods['train'][0], lab.periods['test'][1])
    details = {}
    for key, label, _ in VARIANTS:
        s = variant(base, key)
        row = dict(key=key, label=label, periods={name: lab.evaluate(s, name) for name in ('train', 'validation', 'test')})
        result = lab.run(s, all_data)
        row['all'] = metrics(result, s.initial_capital)
        rows.append(row)
        if key in ('baseline', 'full', 'atr_exits'):
            trades = result['trades']
            details[key] = dict(session=breakdown(trades, 'session'), regime=breakdown(trades, 'regime'),
                                side=breakdown(trades.assign(side=trades.direction.map({1: 'long', -1: 'short'})) if len(trades) else trades, 'side'),
                                exit=breakdown(trades, 'exit_reason'))
    return dict(periods={name: [str(a), str(b)] for name, (a, b) in lab.periods.items()}, variants=rows, details=details)


def _sample(rng: np.random.Generator, ranges: dict) -> dict:
    values = {}
    for name, (low, high) in ranges.items():
        kind, _, _, step = SEARCH_SPACE[name]
        count = int(round((high-low)/step))
        value = low+step*int(rng.integers(0, count+1))
        values[name] = int(round(value)) if kind == 'int' else round(float(value), 4)
    return values


def _valid(base: Settings, values: dict) -> Settings | None:
    try:
        s = replace(base, **values)
    except ValueError:
        return None
    return s


def optimize(lab: Lab, base: Settings, ranges: dict, *, trials: int = 100, min_trades: int = 30, max_drawdown_pct: float = 30.,
             seed: int = 7, top: int = 10, period=('train', 'validation'), progress=None) -> dict:
    """Random search on the train period; the best sets are re-checked on validation and for neighbour stability."""
    for name, bounds in ranges.items():
        if name not in SEARCH_SPACE:
            raise ValueError(f'Unknown search parameter: {name}')
        _, low, high, _ = SEARCH_SPACE[name]
        if not (low <= bounds[0] <= bounds[1] <= high):
            raise ValueError(f'{name} range must be within {low}..{high}')
    rng = np.random.default_rng(seed)
    train_period, valid_period = period
    seen, results = set(), []
    for attempt in range(trials*4):
        if len(results) >= trials:
            break
        values = _sample(rng, ranges)
        key = tuple(sorted(values.items()))
        if key in seen:
            continue
        seen.add(key)
        s = _valid(base, values)
        if s is None:
            continue
        m = lab.evaluate(s, train_period)
        results.append(dict(params=values, train=m, score=score(m, min_trades, max_drawdown_pct)))
        if progress:
            progress(len(results)/trials)
    # Neighbour stability: mean train score of sets within 20% of each range (scaled distance).
    spans = {name: max(1e-9, high-low) for name, (low, high) in ranges.items()}
    finite = [r for r in results if math.isfinite(r['score'])]
    for r in finite:
        near = [o['score'] for o in finite if o is not r and all(abs(o['params'][k]-r['params'][k])/spans[k] <= .2 for k in spans)]
        r['neighbourScore'] = float(np.mean(near)) if near else None
        r['neighbours'] = len(near)
    ranked = sorted(finite, key=lambda r: r['score'], reverse=True)[:top]
    for r in ranked:
        s = replace(base, **r['params'])
        r['validation'] = lab.evaluate(s, valid_period)
        r['validationScore'] = score(r['validation'], max(5, min_trades//3), max_drawdown_pct)
    # Choose on validation (not train), preferring sets whose neighbours also score well.
    def choice_key(r):
        stable = r['neighbourScore'] if r['neighbourScore'] is not None else -math.inf
        return (r['validationScore'], stable)
    best = max(ranked, key=choice_key) if ranked else None
    baseline_m = lab.evaluate(base, valid_period)
    out = dict(trials=len(results), feasible=len(finite), ranked=ranked, best=best, baselineValidation=baseline_m)
    if best is not None:
        out['bestTest'] = lab.evaluate(replace(base, **best['params']), 'test')
        out['baseTest'] = lab.evaluate(base, 'test')
    return out


def walk_forward(lab: Lab, base: Settings, ranges: dict, *, train_days: int = 60, test_days: int = 30, trials: int = 30,
                 min_trades: int = 20, max_drawdown_pct: float = 30., seed: int = 7, progress=None) -> dict:
    """Search on each rolling train window, trade the following test window with the chosen set, join the test results."""
    start = lab.frame.index[0]+pd.Timedelta(days=WARMUP_DAYS)
    end = lab.frame.index[-1]+pd.Timedelta(minutes=5)
    windows, cursor = [], start
    while cursor+pd.Timedelta(days=train_days+test_days) <= end+pd.Timedelta(days=1):
        windows.append((cursor, cursor+pd.Timedelta(days=train_days), min(end, cursor+pd.Timedelta(days=train_days+test_days))))
        cursor += pd.Timedelta(days=test_days)
    pieces, rows = [], []
    for n, (a, b, c) in enumerate(windows):
        found = optimize(lab, base, ranges, trials=trials, min_trades=min_trades, max_drawdown_pct=max_drawdown_pct,
                         seed=seed+n, top=5, period=((a, b), (a, b)))
        chosen = found['best']['params'] if found['best'] else {}
        s = replace(base, **chosen)
        result = lab.run(s, (b, c))
        pieces.append(result['trades'])
        rows.append(dict(train=[str(a), str(b)], test=[str(b), str(c)], params=chosen, test_metrics=metrics(result, s.initial_capital),
                         default_metrics=lab.evaluate(base, (b, c))))
        if progress:
            progress((n+1)/max(1, len(windows)))
    trades = pd.concat([p for p in pieces if len(p)], ignore_index=True) if any(len(p) for p in pieces) else pd.DataFrame()
    summary = None
    if len(trades):
        pnl = trades.pnl.to_numpy(float)
        summary = dict(trades=int(len(trades)), winRate=float((pnl > 0).mean()), netProfit=float(pnl.sum()),
                       expectancyR=float(trades.r_multiple.mean()),
                       profitFactor=float(pnl[pnl > 0].sum()/abs(pnl[pnl <= 0].sum())) if (pnl <= 0).any() else None)
    return dict(windows=rows, summary=summary)


# Background jobs (searches take tens of seconds to minutes).
_jobs: dict[str, dict] = {}
_lock = threading.Lock()


def start_job(owner: int, kind: str, work) -> str:
    job_id = uuid.uuid4().hex
    with _lock:
        for key in [k for k, v in _jobs.items() if v['finished'] and time.time()-v['finished'] > 3600]:
            del _jobs[key]
        _jobs[job_id] = dict(owner=owner, kind=kind, progress=0., result=None, error=None, started=time.time(), finished=None)

    def progress(value):
        _jobs[job_id]['progress'] = float(min(1., value))

    def runner():
        try:
            _jobs[job_id]['result'] = work(progress)
        except Exception as error:  # Reported to the UI; the server keeps running.
            _jobs[job_id]['error'] = str(error)
        finally:
            _jobs[job_id]['finished'] = time.time()
            _jobs[job_id]['progress'] = 1.

    threading.Thread(target=runner, name=f'lab-{kind}', daemon=True).start()
    return job_id


def job(owner: int, job_id: str) -> dict | None:
    item = _jobs.get(job_id)
    if item is None or item['owner'] != owner:
        return None
    return {k: v for k, v in item.items() if k != 'owner'}

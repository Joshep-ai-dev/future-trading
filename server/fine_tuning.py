"""Bounded, deterministic search for BB reversal settings with walk-forward scoring."""
from dataclasses import replace

import numpy as np
import pandas as pd
from sklearn.ensemble import (ExtraTreesRegressor, HistGradientBoostingRegressor,
                              RandomForestRegressor, VotingRegressor)
from sklearn.model_selection import ParameterSampler

from .bb_outer_reversal import Settings, calculate, run_backtest
from .data import TIMEFRAMES
from .strategy import seconds


TRIALS = 24
ADAPTIVE_TRIALS = 8
SHORTLIST = 5
PARAMETERS = ('initial_sl', 'trail_trigger', 'trail_distance',
              'adx_threshold', 'min_bb_width_pct')


def _candidate_space(base):
    factors = (.65, .8, 1., 1.2, 1.4)
    def scaled(value, minimum=.01):
        return sorted({round(max(minimum, value*factor), 4) for factor in factors})
    def around(value, step, minimum=0., maximum=100.):
        return sorted({round(min(maximum, max(minimum, value+offset)), 4)
                       for offset in (-2*step, -step, 0., step, 2*step)})
    return {
        'initial_sl': scaled(base.initial_sl),
        'trail_trigger': scaled(base.trail_trigger),
        'trail_distance': scaled(base.trail_distance),
        'adx_threshold': around(base.adx_threshold, max(2., base.adx_threshold*.15)),
        'min_bb_width_pct': around(base.min_bb_width_pct,
                                   max(.1, base.min_bb_width_pct*.2), maximum=100.),
    }


def _parameter_key(params):
    return tuple(round(float(params[key]), 6) for key in PARAMETERS)


def _candidate_set(base, count, seed, excluded=()):
    space = _candidate_space(base)
    original = dict(initial_sl=base.initial_sl, trail_trigger=base.trail_trigger,
                    trail_distance=base.trail_distance, adx_threshold=base.adx_threshold,
                    min_bb_width_pct=base.min_bb_width_pct)
    seen = set(excluded)
    candidates = []
    target = count
    if not excluded:
        candidates.append(original)
        seen.add(_parameter_key(original))
        target = max(0, count-1)
    total = int(np.prod([len(values) for values in space.values()]))
    for params in ParameterSampler(space, n_iter=min(total, max(target*8, target)),
                                   random_state=seed):
        key = _parameter_key(params)
        if key in seen:
            continue
        seen.add(key)
        candidates.append(params)
        if len(candidates) == target+(1 if not excluded else 0):
            break
    return candidates


def _fit_ensemble(rows):
    features = np.asarray([[_parameter_key(params)[i] for i in range(len(PARAMETERS))]
                           for params, _ in rows], dtype=float)
    scores = np.asarray([metrics['score'] for _, metrics in rows], dtype=float)
    model = VotingRegressor(estimators=[
        ('random_forest', RandomForestRegressor(n_estimators=120, min_samples_leaf=2,
                                               random_state=1729, n_jobs=1)),
        ('extra_trees', ExtraTreesRegressor(n_estimators=120, min_samples_leaf=2,
                                            random_state=1733, n_jobs=1)),
        ('hist_gradient_boosting', HistGradientBoostingRegressor(max_iter=100,
                                                                 max_leaf_nodes=7,
                                                                 l2_regularization=1.,
                                                                 random_state=1741)),
    ])
    model.fit(features, scores)
    return model


def _score(result, capital):
    trades = result['trades']
    count = len(trades)
    pnl = trades.pnl.to_numpy(dtype=float) if count else np.array([], dtype=float)
    wins = int((pnl > 0).sum())
    losses = pnl[pnl < 0]
    win_rate = wins/count*100 if count else 0.
    net_pnl = float(pnl.sum())
    return_pct = net_pnl/capital*100
    values = result['bars'].equity.to_numpy(dtype=float)
    peak, drawdown = capital, 0.
    for value in values:
        peak = max(peak, value)
        if peak > 0:
            drawdown = min(drawdown, (value/peak-1)*100)
    average_loss_pct = float(abs(losses.mean())/capital*100) if len(losses) else 0.
    profit_component = min(100., max(0., 50.+return_pct/2))
    drawdown_component = max(0., 100.-abs(drawdown))
    loss_component = max(0., 100.-average_loss_pct)
    score = (0.35*win_rate + 0.35*profit_component +
             0.20*drawdown_component + 0.10*loss_component)
    # Avoid treating tiny samples as strong candidates.
    score *= min(1., count/20)
    return dict(score=round(score, 3), trades=count, wins=wins,
                losses=int((pnl < 0).sum()), winRate=round(win_rate, 2),
                netPnl=round(net_pnl, 4), returnPct=round(return_pct, 3),
                maxDrawdownPct=round(drawdown, 3), averageLossPct=round(average_loss_pct, 3))


def fine_tune(frame, request):
    """Search stop/filter values on train, shortlist on validation, report untouched holdout."""
    duration = TIMEFRAMES[request.entry_timeframe]
    start = pd.Timestamp(seconds(request.start_date), unit='s', tz='UTC')
    end = pd.Timestamp(seconds(request.end_date)+86400, unit='s', tz='UTC')
    clean = frame.dropna(subset=['open', 'high', 'low', 'close'])
    clean = clean.loc[clean.index+pd.Timedelta(seconds=duration) <= end]
    if len(clean.loc[clean.index >= start]) < 300:
        raise ValueError('Fine tuning needs at least 300 complete candles in the selected date range.')

    base = replace(Settings(**request.bb_reversal), initial_capital=request.capital,
                   min_tick=request.tick_size, min_tick_unit='price', trade_mode='Both',
                   leverage=request.max_leverage)
    prepared = calculate(clean, base, bar_seconds=duration)
    prepared = prepared.loc[prepared.index >= start]
    train_end = int(len(prepared)*.6)
    validation_end = int(len(prepared)*.8)
    segments = (prepared.iloc[:train_end], prepared.iloc[train_end:validation_end],
                prepared.iloc[validation_end:])
    if any(segment.empty for segment in segments):
        raise ValueError('Selected range is too short to make train, validation and forward-test periods.')

    evaluated = {}
    def evaluate(params):
        config = replace(base, **params)
        result = run_backtest(segments[0], config, close_at_end=True,
                              prepared_bars=segments[0])
        evaluated[_parameter_key(params)] = (params, _score(result, request.capital))

    initial_candidates = _candidate_set(base, TRIALS, seed=1729)
    for params in initial_candidates:
        evaluate(params)

    first_model = _fit_ensemble(list(evaluated.values()))
    first_pool = _candidate_set(base, 256, seed=2731, excluded=evaluated)
    adaptive_evaluated = 0
    if first_pool:
        features = np.asarray([_parameter_key(params) for params in first_pool], dtype=float)
        predictions = first_model.predict(features)
        proposals = sorted(zip(predictions, first_pool), key=lambda item:item[0], reverse=True)
        for _, params in proposals[:ADAPTIVE_TRIALS]:
            evaluate(params)
            adaptive_evaluated += 1

    model = _fit_ensemble(list(evaluated.values()))
    final_pool = _candidate_set(base, 512, seed=3739, excluded=evaluated)
    ranked = list(evaluated.values())
    if final_pool:
        features = np.asarray([_parameter_key(params) for params in final_pool], dtype=float)
        predictions = model.predict(features)
        ranked.extend((params, {'score':float(score), 'netPnl':0., 'maxDrawdownPct':0.})
                       for score, params in zip(predictions, final_pool))
    ranked.sort(key=lambda item: (item[1]['score'], item[1]['netPnl'],
                                  item[1]['maxDrawdownPct']), reverse=True)
    shortlist = []
    seen_shortlist = set()
    for params, _ in ranked:
        key = _parameter_key(params)
        if key not in seen_shortlist:
            seen_shortlist.add(key)
            shortlist.append(params)
        if len(shortlist) == SHORTLIST:
            break

    for params in shortlist:
        if _parameter_key(params) not in evaluated:
            evaluate(params)

    validated = []
    for params in shortlist:
        train_metrics = evaluated.get(_parameter_key(params), (params, {'score':0.,'trades':0,
            'wins':0,'losses':0,'winRate':0.,'netPnl':0.,'returnPct':0.,
            'maxDrawdownPct':0.,'averageLossPct':0.}))[1]
        config = replace(base, **params)
        result = run_backtest(segments[1], config, close_at_end=True,
                              prepared_bars=segments[1])
        validated.append((_score(result, request.capital), train_metrics, params))
    validated.sort(key=lambda item: (item[0]['score'], item[0]['netPnl'],
                                     item[0]['maxDrawdownPct']), reverse=True)
    validation_metrics, train_metrics, best_params = validated[0]
    best = replace(base, **best_params)
    forward_result = run_backtest(segments[2], best, close_at_end=True,
                                  prepared_bars=segments[2])
    timestamps = [int(segment.index[0].timestamp()) for segment in segments]
    return dict(
        bestSettings=request.model_copy(update={'bb_reversal':{**request.bb_reversal, **best_params}}).model_dump(mode='json'),
        bestParameters=best_params,
        model='scikit-learn VotingRegressor: RandomForestRegressor + ExtraTreesRegressor + HistGradientBoostingRegressor',
        objective='35% win rate, 35% profit, 20% drawdown control, 10% average loss control; small samples are discounted.',
        candidatesEvaluated=len(evaluated), seedCandidates=len(initial_candidates),
        adaptiveCandidatesEvaluated=adaptive_evaluated,
        shortlisted=len(validated),
        periods=dict(train=dict(start=timestamps[0],end=timestamps[1],metrics=train_metrics),
                     validation=dict(start=timestamps[1],end=timestamps[2],metrics=validation_metrics),
                     forwardTest=dict(start=timestamps[2],end=int(segments[2].index[-1].timestamp()),
                                      metrics=_score(forward_result,request.capital))),
    )

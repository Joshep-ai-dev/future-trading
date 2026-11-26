"""SuperTrend Scalper for XAG/USDT 5-minute candles (backtest and paper only).

Signal (all evaluated on the *completed* 5m candle; nothing repaints):

* SuperTrend(ATR ``st_length``, factor 1.5 by default) flips bullish / bearish
  and Wilder ATR is strictly above 0.03 in price units by default.

Optional entry filters (off by default):

* Trend: the last *completed* 15m candle closes above / below its EMA 200
  (a 15m candle is known only at its close), and the 5m close is above /
  below EMA 50.
* ADX(14) > threshold; RSI(14) inside the long / short band.
* Volatility: ATR/close percentile over a rolling window inside [min, max].
* Session: the entry candle's UTC session is enabled.
* News: no high / medium importance US release (CPI, NFP, FOMC, ...) inside
  the exclusion window around the fill time.
* Regime: strong bullish trend for longs, strong bearish for shorts.

Execution: entries fill at the *next* candle's open (= signal close time)
plus half the spread and slippage, never at the signal close. Stops and
targets come from ATR at the signal candle. Intrabar, a candle that touches
both stop and target counts as a stop; an opening gap through a level fills
at the open. Break-even (+``breakeven_atr``) and trailing (+``trail_atr``,
``trail_distance_atr`` behind the best price) only move the stop at a candle
close, so they apply from the next candle. Time exit after ``max_hold_bars``
candles at the close; an opposite SuperTrend flip exits at the next open.
Fees, spread, slippage and funding are charged on every fill. Size risks
``risk_pct`` of equity on the initial stop (capped by leverage).

With ``use_atr_exits`` off, an opposite flip exits the position. A reversal
also requires the new entry to pass the ATR minimum and enabled filters.
"""
from __future__ import annotations

from dataclasses import dataclass, fields, replace

import numpy as np
import pandas as pd

from server.strategies.ml.features import _dmi, _rsi, _supertrend, _true_range, _wilder

SESSIONS = {'asia': (0, 7), 'london': (7, 12), 'overlap': (12, 16), 'newyork': (16, 21), 'late': (21, 24)}  # UTC hours
SESSION_LABELS = {'asia': 'Asia', 'london': 'London', 'overlap': 'London-NY overlap', 'newyork': 'New York', 'late': 'Late US'}
REGIMES = ('strong_bull', 'strong_bear', 'ranging', 'low_vol', 'extreme_vol')
HTF_SECONDS = {'15m': 900, '30m': 1800, '1h': 3600}
# News groups by importance (see server.news.calendar.GROUPS).
HIGH_IMPACT = frozenset({'cpi', 'nfp', 'rate', 'press'})
MEDIUM_IMPACT = frozenset({'ppi', 'retail', 'gdp_pce', 'minutes'})


@dataclass(frozen=True)
class Settings:
    # Signal
    st_length: int = 10
    st_multiplier: float = 1.5
    htf_timeframe: str = '15m'
    htf_ema_length: int = 200
    ema_fast_length: int = 50
    adx_length: int = 14
    adx_threshold: float = 25.
    rsi_length: int = 14
    rsi_long_min: float = 50.
    rsi_long_max: float = 70.
    rsi_short_min: float = 30.
    rsi_short_max: float = 50.
    atr_length: int = 14
    atr_min: float = .03
    atr_window: int = 2000  # ~7 days of 5m candles for the ATR percentile
    atr_pct_min: float = 10.
    atr_pct_max: float = 95.
    volume_sma: int = 20
    volume_mult: float = 1.
    sessions: tuple = ('london', 'overlap', 'newyork')
    news_high_before: int = 15  # minutes
    news_high_after: int = 30
    news_medium_before: int = 10
    news_medium_after: int = 15
    # Filters (each can be switched off for the step-by-step comparison)
    use_trend_filter: bool = False
    use_adx_filter: bool = False
    use_rsi_filter: bool = False
    use_volatility_filter: bool = False
    use_session_filter: bool = False
    use_news_filter: bool = False
    use_regime_filter: bool = False
    use_volume_filter: bool = False
    # Exits and risk
    use_atr_exits: bool = True
    stop_atr: float = 1.5
    target_atr: float = 2.
    breakeven_atr: float = 1.  # 0 disables
    trail_atr: float = 1.5  # 0 disables
    trail_distance_atr: float = 1.
    max_hold_bars: int = 12
    exit_on_flip: bool = True
    risk_pct: float = .5
    trade_mode: str = 'Both'
    # Filled from the request
    initial_capital: float = 2000.
    leverage: float = 1.
    min_tick: float = .01

    def __post_init__(self):
        ints = dict(st_length=(2, 200), htf_ema_length=(2, 1000), ema_fast_length=(2, 500), adx_length=(2, 200),
                    rsi_length=(2, 200), atr_length=(2, 200), atr_window=(50, 20000), volume_sma=(2, 500),
                    max_hold_bars=(1, 500), news_high_before=(0, 600), news_high_after=(0, 600),
                    news_medium_before=(0, 600), news_medium_after=(0, 600))
        for name, (low, high) in ints.items():
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
                raise ValueError(f'{name} must be an integer between {low} and {high}')
        floats = dict(st_multiplier=(.1, 20), adx_threshold=(0, 100), rsi_long_min=(0, 100), rsi_long_max=(0, 100),
                      rsi_short_min=(0, 100), rsi_short_max=(0, 100), atr_pct_min=(0, 100), atr_pct_max=(0, 100),
                      volume_mult=(0, 20), stop_atr=(.1, 20), target_atr=(.1, 50), breakeven_atr=(0, 50),
                      trail_atr=(0, 50), trail_distance_atr=(.1, 50), risk_pct=(.01, 10))
        for name, (low, high) in floats.items():
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not np.isfinite(value) or not low <= value <= high:
                raise ValueError(f'{name} must be between {low} and {high}')
        if isinstance(self.atr_min, bool) or not isinstance(self.atr_min, (int, float)) or not np.isfinite(self.atr_min) or self.atr_min < 0:
            raise ValueError('atr_min must be a finite nonnegative number')
        if self.rsi_long_min >= self.rsi_long_max or self.rsi_short_min >= self.rsi_short_max:
            raise ValueError('RSI band minimum must be below its maximum')
        if self.atr_pct_min >= self.atr_pct_max:
            raise ValueError('ATR percentile minimum must be below the maximum')
        if self.htf_timeframe not in HTF_SECONDS:
            raise ValueError(f'htf_timeframe must be one of {", ".join(HTF_SECONDS)}')
        if self.trade_mode not in ('Both', 'Long Only', 'Short Only'):
            raise ValueError('trade_mode must be Both, Long Only or Short Only')
        if not set(self.sessions) <= set(SESSIONS):
            raise ValueError(f'sessions must be among {", ".join(SESSIONS)}')

    @classmethod
    def from_dict(cls, values: dict, **overrides) -> 'Settings':
        known = {f.name for f in fields(cls)}
        unknown = sorted(set(values)-known)
        if unknown:
            raise ValueError(f'Unknown SuperTrend Scalper settings: {", ".join(unknown)}')
        merged = {**values, **overrides}
        if 'sessions' in merged:
            merged['sessions'] = tuple(merged['sessions'])
        return cls(**merged)


def session_names(index: pd.DatetimeIndex) -> np.ndarray:
    hours = index.hour
    names = np.empty(len(index), dtype=object)
    for name, (start, end) in SESSIONS.items():
        names[(hours >= start) & (hours < end)] = name
    return names


def _htf_trend(bars: pd.DataFrame, s: Settings, bar_seconds: int) -> tuple[pd.Series, pd.Series]:
    """Close and EMA of the last *completed* higher-timeframe candle known at each entry candle's close."""
    seconds = HTF_SECONDS[s.htf_timeframe]
    rule = pd.Timedelta(seconds=seconds)
    grouped = bars[['close']].resample(rule, label='left', closed='left').agg(close=('close', 'last'), count=('close', 'count'))
    complete = grouped[grouped['count'] >= max(1, seconds//bar_seconds)].copy()
    complete['ema'] = complete.close.ewm(span=s.htf_ema_length, adjust=False, min_periods=s.htf_ema_length).mean()
    complete['known'] = complete.index+rule
    closes = pd.DataFrame({'known': bars.index+pd.Timedelta(seconds=bar_seconds)}, index=bars.index)
    merged = pd.merge_asof(closes.reset_index(), complete[['known', 'close', 'ema']].rename(columns={'close': 'htf_close'}),
                           on='known', direction='backward').set_index(closes.index.name or 'index')
    merged.index = bars.index
    return merged.htf_close, merged.ema


def news_blocked(times: np.ndarray, events: list[tuple[int, str]] | None, s: Settings) -> np.ndarray:
    """True where a fill time (UTC seconds) falls inside an exclusion window around a high / medium release."""
    blocked = np.zeros(len(times), bool)
    for released, group in events or []:
        if group in HIGH_IMPACT:
            before, after = s.news_high_before*60, s.news_high_after*60
        elif group in MEDIUM_IMPACT:
            before, after = s.news_medium_before*60, s.news_medium_after*60
        else:
            continue
        left, right = np.searchsorted(times, released-before), np.searchsorted(times, released+after, side='right')
        blocked[left:right] = True
    return blocked


def load_events(start: int | None = None) -> list[tuple[int, str]]:
    """(release time, group) of stored US calendar events; empty when the news store is unavailable."""
    try:
        from server.news.store import NewsStore
        return sorted({(int(row['released']), row['grp']) for row in NewsStore().events(since=start)})
    except Exception:
        return []


def indicators(frame: pd.DataFrame, s: Settings, bar_seconds: int) -> pd.DataFrame:
    """All indicator, regime and session columns (current and past candles only)."""
    bars = frame[['open', 'high', 'low', 'close']+(['volume'] if 'volume' in frame else [])].copy()
    line, direction = _supertrend(bars, s.st_length, s.st_multiplier)
    bars['st_line'], bars['st_direction'] = line, direction
    previous = bars.st_direction.shift()
    valid = previous.notna() & previous.ne(0) & bars.st_direction.ne(0)
    bars['flip_up'] = valid & (bars.st_direction == 1) & (previous == -1)
    bars['flip_down'] = valid & (bars.st_direction == -1) & (previous == 1)
    bars['ema_fast'] = bars.close.ewm(span=s.ema_fast_length, adjust=False, min_periods=s.ema_fast_length).mean()
    bars['htf_close'], bars['htf_ema'] = _htf_trend(bars, s, bar_seconds)
    plus_di, minus_di, adx = _dmi(bars, s.adx_length, s.adx_length)
    bars['plus_di'], bars['minus_di'], bars['adx'] = plus_di, minus_di, adx
    bars['rsi'] = _rsi(bars.close, s.rsi_length)
    bars['atr'] = _wilder(_true_range(bars), s.atr_length)
    ratio = bars.atr/bars.close
    bars['atr_pct'] = ratio.rolling(s.atr_window, min_periods=max(50, s.atr_window//4)).rank(pct=True)*100
    if 'volume' in bars:
        bars['volume_avg'] = bars.volume.rolling(s.volume_sma, min_periods=s.volume_sma).mean()
    # EMA slope in ATR per candle over 10 candles: direction and steepness of the short-term trend.
    bars['ema_slope'] = (bars.ema_fast-bars.ema_fast.shift(10))/(10*bars.atr)
    regime = np.full(len(bars), 'ranging', dtype=object)
    bull = (adx >= s.adx_threshold) & (plus_di > minus_di) & (bars.ema_slope > .05) & (bars.htf_close > bars.htf_ema)
    bear = (adx >= s.adx_threshold) & (minus_di > plus_di) & (bars.ema_slope < -.05) & (bars.htf_close < bars.htf_ema)
    regime[bull.to_numpy()] = 'strong_bull'
    regime[bear.to_numpy()] = 'strong_bear'
    regime[(bars.atr_pct < s.atr_pct_min).to_numpy()] = 'low_vol'
    regime[(bars.atr_pct > s.atr_pct_max).to_numpy()] = 'extreme_vol'
    bars['regime'] = regime
    # The fill happens at the next open = this candle's close; its session decides the session filter.
    bars['session'] = session_names(bars.index+pd.Timedelta(seconds=bar_seconds))
    return bars


def entries(bars: pd.DataFrame, s: Settings, bar_seconds: int, events: list[tuple[int, str]] | None = None) -> pd.DataFrame:
    """entry_long / entry_short and one boolean column per filter (True = passes)."""
    out = pd.DataFrame(index=bars.index)
    ready = np.isfinite(bars.st_line) & np.isfinite(bars.atr) & (bars.atr > s.atr_min)
    long_ok, short_ok = bars.flip_up & ready, bars.flip_down & ready
    checks_long, checks_short = {}, {}
    if s.use_trend_filter:
        checks_long['trend'] = (bars.htf_close > bars.htf_ema) & (bars.close > bars.ema_fast)
        checks_short['trend'] = (bars.htf_close < bars.htf_ema) & (bars.close < bars.ema_fast)
    if s.use_adx_filter:
        checks_long['adx'] = checks_short['adx'] = bars.adx > s.adx_threshold
    if s.use_rsi_filter:
        checks_long['rsi'] = bars.rsi.between(s.rsi_long_min, s.rsi_long_max)
        checks_short['rsi'] = bars.rsi.between(s.rsi_short_min, s.rsi_short_max)
    if s.use_volatility_filter:
        checks_long['volatility'] = checks_short['volatility'] = bars.atr_pct.between(s.atr_pct_min, s.atr_pct_max)
    if s.use_session_filter:
        checks_long['session'] = checks_short['session'] = pd.Series(np.isin(bars.session, s.sessions), index=bars.index)
    if s.use_news_filter:
        fill_times = (bars.index.asi8//10**9)+bar_seconds
        checks_long['news'] = checks_short['news'] = pd.Series(~news_blocked(fill_times, events, s), index=bars.index)
    if s.use_regime_filter:
        checks_long['regime'] = bars.regime.eq('strong_bull')
        checks_short['regime'] = bars.regime.eq('strong_bear')
    if s.use_volume_filter and 'volume_avg' in bars:
        checks_long['volume'] = checks_short['volume'] = bars.volume > bars.volume_avg*s.volume_mult
    for name, check in checks_long.items():
        out[f'long_{name}'] = check.fillna(False).astype(bool)
        long_ok = long_ok & out[f'long_{name}']
    for name, check in checks_short.items():
        out[f'short_{name}'] = check.fillna(False).astype(bool)
        short_ok = short_ok & out[f'short_{name}']
    out['entry_long'] = long_ok.astype(bool) & (s.trade_mode != 'Short Only')
    out['entry_short'] = short_ok.astype(bool) & (s.trade_mode != 'Long Only')
    return out


def simulate(bars: pd.DataFrame, signals: pd.DataFrame, s: Settings, *, bar_seconds: int, start=None, end=None,
             close_at_end: bool = True, fee_bps: float = 0., slippage: float = 0., spread: float = 0.,
             funding_bps: float = 0.) -> dict:
    """Next-open execution of ``signals`` (see module docstring). Returns dict(bars, trades, open_position, cash)."""
    if not all(np.isfinite(v) for v in (fee_bps, slippage, spread, funding_bps)) or min(fee_bps, slippage, spread) < 0:
        raise ValueError('Execution costs must be finite; fees, slippage and spread must be nonnegative')
    keep = np.ones(len(bars), bool)
    if start is not None:
        keep &= bars.index >= start
    if end is not None:
        keep &= bars.index < end
    view = bars.loc[keep]
    sig = signals.loc[keep]
    times = view.index
    o, h, l, c = (view[col].to_numpy(float) for col in ('open', 'high', 'low', 'close'))
    atr, st_dir = view.atr.to_numpy(float), view.st_direction.to_numpy(float)
    regime, session = view.regime.to_numpy(), view.session.to_numpy()
    long_sig, short_sig = sig.entry_long.to_numpy(bool), sig.entry_short.to_numpy(bool)
    secs = (times.asi8//10**9).astype(np.int64)
    contiguous = np.r_[False, np.diff(secs) == bar_seconds]  # bar i directly follows bar i-1
    adverse = slippage+spread/2
    cash = float(s.initial_capital)
    position = None
    trades, equity, stops, positions = [], np.empty(len(view)), np.full(len(view), np.nan), np.zeros(len(view))
    pending_entry, pending_exit = 0, False

    def fund(now):
        nonlocal cash
        charge = position['entry_price']*position['quantity']*funding_bps/10000*position['direction']*max(0, now-position['funding_time'])/(8*3600)
        cash -= charge
        position['funding'] += charge
        position['funding_time'] = now

    def close(i, price, reason, stamp_index):
        """Exit fill at ``price`` (before costs); ``stamp_index`` is the candle whose close is the fill moment."""
        nonlocal cash, position
        p = position
        fund(int(secs[i]))
        d, q = p['direction'], p['quantity']
        fill = price-d*adverse
        fee = abs(fill*q)*fee_bps/10000
        gross = (fill-p['entry_price'])*d*q
        cash += gross-fee
        pnl = gross-p['entry_fee']-fee-p['funding']
        trades.append(dict(
            reference_entry=p['reference_entry'], entry_fee=p['entry_fee'], funding=p['funding'], funding_time=p['funding_time'],
            direction=d, entry_time=p['entry_time'], entry_price=p['entry_price'], quantity=q, stop=p['stop'],
            initial_stop=p['initial_stop'], target=p['target'], extreme=p['extreme'], trailing_active=p['trailing_active'],
            trail_trigger=p['trail_trigger'], trail_distance=p['trail_distance'], stop_history=p['stop_history'],
            exit_time=times[stamp_index], exit_price=float(fill), exit_reason=reason, pnl=float(pnl),
            gross_pnl=float((price-p['reference_entry'])*d*q), fees=float(p['entry_fee']+fee),
            execution_cost=float((price-p['reference_entry'])*d*q-gross), risk=p['risk'],
            r_multiple=float(pnl/p['risk']) if p['risk'] > 0 else 0., bars_held=int(i-p['entry_index']+1),
            mfe_atr=float(p['mfe']/p['atr']) if p['atr'] else 0., mae_atr=float(p['mae']/p['atr']) if p['atr'] else 0.,
            regime=p['regime'], session=p['session'], breakeven=p['breakeven']))
        position = None

    for i in range(len(view)):
        if i and not contiguous[i]:
            if position is not None:
                close(i, o[i], 'data_gap', i-1)
            pending_entry, pending_exit = 0, False
        # 1) Orders queued at the previous close fill at this open.
        if pending_exit and position is not None:
            close(i, o[i], 'supertrend_flip', i-1)
        pending_exit = False
        if pending_entry and position is not None and position['direction'] != pending_entry:
            close(i, o[i], 'reversal', i-1)
        if pending_entry and position is None and cash > 0 and np.isfinite(atr[i-1]):
            d, a = pending_entry, atr[i-1]
            entry = o[i]+d*adverse
            stop_distance = max(s.min_tick, s.stop_atr*a)
            unit_risk = stop_distance+2*adverse+2*entry*fee_bps/10000
            quantity = min(cash*s.risk_pct/100/unit_risk, cash*s.leverage/entry)
            if quantity > 0:
                fee = abs(entry*quantity)*fee_bps/10000
                cash -= fee
                stop = entry-d*stop_distance if s.use_atr_exits else (-np.inf if d == 1 else np.inf)
                target = entry+d*max(s.min_tick, s.target_atr*a) if s.use_atr_exits else d*np.inf
                position = dict(reference_entry=float(o[i]), entry_fee=fee, funding=0., funding_time=int(secs[i]),
                                direction=d, entry_time=times[i-1], entry_price=float(entry), quantity=float(quantity),
                                stop=float(stop), initial_stop=float(entry-d*stop_distance), target=float(target),
                                extreme=float(entry), trailing_active=False, trail_trigger=float(s.trail_atr*a),
                                trail_distance=float(s.trail_distance_atr*a), breakeven=False, entry_index=i, atr=float(a),
                                risk=float(quantity*unit_risk), mfe=0., mae=0., regime=regime[i-1], session=session[i-1],
                                stop_history=[dict(time=int(secs[i-1]), price=float(entry-d*stop_distance), reason='initial')])
        pending_entry = 0
        # 2) Intrabar stop / target on this candle (stop first when both are touched; gaps fill at the open).
        if position is not None:
            p, d = position, position['direction']
            p['mfe'] = max(p['mfe'], (h[i]-p['entry_price']) if d == 1 else (p['entry_price']-l[i]))
            p['mae'] = max(p['mae'], (p['entry_price']-l[i]) if d == 1 else (h[i]-p['entry_price']))
            stop, target = p['stop'], p['target']
            if d*(o[i]-stop) < 0:  # opened beyond the stop: fills at the worse open
                close(i, o[i], 'stop_gap', i)
            elif (l[i] <= stop) if d == 1 else (h[i] >= stop):
                close(i, stop, 'trailing_stop' if p['trailing_active'] else 'breakeven' if p['breakeven'] else 'stop', i)
            elif d*(o[i]-target) >= 0:
                close(i, o[i], 'take_profit', i)
            elif (h[i] >= target) if d == 1 else (l[i] <= target):
                close(i, target, 'take_profit', i)
        # 3) At the close: time exit, then break-even / trailing updates that apply from the next candle.
        if position is not None:
            p, d = position, position['direction']
            if s.use_atr_exits and i-p['entry_index']+1 >= s.max_hold_bars:
                close(i, c[i], 'time_exit', i)
            else:
                p['extreme'] = max(p['extreme'], h[i]) if d == 1 else min(p['extreme'], l[i])
                favourable = d*(p['extreme']-p['entry_price'])
                new_stop = p['stop']
                # A stop is only moved to a level still on the safe side of this close (an exchange would
                # reject a sell stop above the market); otherwise it waits for a later candle.
                safe = lambda level: d*(c[i]-level) >= s.min_tick  # noqa: E731
                if s.use_atr_exits and s.breakeven_atr and not p['breakeven'] and favourable >= s.breakeven_atr*p['atr'] and safe(p['entry_price']):
                    p['breakeven'] = True
                    new_stop = max(new_stop, p['entry_price']) if d == 1 else min(new_stop, p['entry_price'])
                if s.use_atr_exits and s.trail_atr and favourable >= p['trail_trigger']:
                    candidate = p['extreme']-d*p['trail_distance']
                    if safe(candidate):
                        p['trailing_active'] = True
                        new_stop = max(new_stop, candidate) if d == 1 else min(new_stop, candidate)
                if new_stop != p['stop']:
                    p['stop'] = float(new_stop)
                    p['stop_history'].append(dict(time=int(secs[i]), price=float(new_stop),
                                                  reason='trailing' if p['trailing_active'] else 'breakeven'))
        # 4) Signals at this close: queue the next open.
        want = 1 if long_sig[i] else -1 if short_sig[i] else 0
        if position is not None and (s.exit_on_flip or not s.use_atr_exits) and st_dir[i] == -position['direction'] and want != -position['direction']:
            pending_exit = True
        if want and (position is None or position['direction'] != want):
            pending_entry = want
        unrealized = 0. if position is None else (c[i]-position['entry_price'])*position['direction']*position['quantity']
        equity[i] = cash+unrealized
        positions[i] = 0 if position is None else position['direction']
        stops[i] = np.nan if position is None or not np.isfinite(position['stop']) else position['stop']
    if close_at_end and position is not None and len(view):
        close(len(view)-1, c[-1], 'period_end', len(view)-1)
        equity[-1], positions[-1], stops[-1] = cash, 0, np.nan
    out = view.join(signals.loc[keep])
    out['equity'], out['position'], out['stop'] = equity, positions, stops
    out['long_signal'], out['short_signal'] = long_sig, short_sig
    out['trailing_active'] = False
    open_position = None if position is None else {k: v for k, v in position.items() if k != 'entry_index'}
    return dict(bars=out, trades=pd.DataFrame(trades), open_position=open_position, cash=float(cash))


def run_backtest(frame: pd.DataFrame, s: Settings, *, bar_seconds: int | None = None, start=None, end=None,
                 close_at_end: bool = True, events: list[tuple[int, str]] | None = None, **costs) -> dict:
    bar_seconds = bar_seconds or int(pd.Series(frame.index).diff().dt.total_seconds().median() or 300)
    bars = indicators(frame, s, bar_seconds)
    if s.use_news_filter and events is None:
        events = load_events()
    signals = entries(bars, s, bar_seconds, events)
    return simulate(bars, signals, s, bar_seconds=bar_seconds, start=start, end=end, close_at_end=close_at_end, **costs)


def metrics(result: dict, capital: float) -> dict:
    """Performance summary of one simulation (all money values after costs)."""
    trades = result['trades']
    equity = result['bars']['equity'] if len(result['bars']) else pd.Series(dtype=float)
    out = dict(trades=int(len(trades)))
    if trades.empty:
        return {**out, 'winRate': None, 'profitFactor': None, 'netProfit': 0., 'expectancy': None, 'expectancyR': None,
                'avgWin': None, 'avgLoss': None, 'maxDrawdownPct': 0., 'sharpe': None, 'sortino': None, 'maxConsecutiveLosses': 0,
                'longs': 0, 'shorts': 0}
    pnl = trades.pnl.to_numpy(float)
    wins, losses = pnl[pnl > 0], pnl[pnl <= 0]
    streak = longest = 0
    for value in pnl:
        streak = streak+1 if value <= 0 else 0
        longest = max(longest, streak)
    peak = equity.cummax()
    daily = equity.resample('1D').last().dropna().pct_change().dropna()
    downside = daily[daily < 0]
    return {**out,
            'winRate': float(len(wins)/len(pnl)), 'profitFactor': float(wins.sum()/abs(losses.sum())) if losses.sum() else None,
            'netProfit': float(pnl.sum()), 'returnPct': float(pnl.sum()/capital*100), 'expectancy': float(pnl.mean()),
            'expectancyR': float(trades.r_multiple.mean()), 'avgWin': float(wins.mean()) if len(wins) else None,
            'avgLoss': float(losses.mean()) if len(losses) else None,
            'maxDrawdownPct': float(((equity-peak)/peak).min()*100) if len(equity) else 0.,
            'sharpe': float(daily.mean()/daily.std()*np.sqrt(365)) if len(daily) > 2 and daily.std() > 0 else None,
            'sortino': float(daily.mean()/downside.std()*np.sqrt(365)) if len(downside) > 2 and downside.std() > 0 else None,
            'maxConsecutiveLosses': int(longest), 'longs': int((trades.direction == 1).sum()), 'shorts': int((trades.direction == -1).sum()),
            'avgBarsHeld': float(trades.bars_held.mean()), 'costs': float((trades.fees+trades.execution_cost+trades.funding).sum())}


def breakdown(trades: pd.DataFrame, column: str) -> list[dict]:
    """Trades, win rate, net profit and expectancy (R) per value of ``column`` (session, regime, direction, exit_reason)."""
    if trades.empty:
        return []
    rows = []
    for key, group in trades.groupby(column):
        rows.append(dict(key=str(key), trades=int(len(group)), winRate=float((group.pnl > 0).mean()),
                         netProfit=float(group.pnl.sum()), expectancyR=float(group.r_multiple.mean())))
    return sorted(rows, key=lambda row: -row['trades'])


def readiness(bar, signal_row, s: Settings) -> dict:
    """Long / short checklist at the latest completed candle for the bot status panel."""
    def side(sign):
        prefix = 'long' if sign == 1 else 'short'
        flip = bool(bar.flip_up if sign == 1 else bar.flip_down)
        checks = [dict(label='SuperTrend flip this candle', passed=flip, value=float(bar.st_direction), threshold=sign)]
        atr = float(bar.atr)
        checks.append(dict(label=f'ATR > {s.atr_min:g}', passed=bool(np.isfinite(atr) and atr > s.atr_min),
                           value=atr if np.isfinite(atr) else None, threshold=s.atr_min))
        for name, label in (('trend', '15m EMA 200 and 5m EMA 50'), ('adx', f'ADX > {s.adx_threshold:g}'), ('rsi', 'RSI in band'),
                            ('volatility', 'ATR percentile in range'), ('session', 'Session enabled'), ('news', 'No news window'),
                            ('regime', 'Strong trend regime'), ('volume', 'Volume above average')):
            column = f'{prefix}_{name}'
            if column in signal_row:
                checks.append(dict(label=label, passed=bool(signal_row[column]), value=None, threshold=None))
        return checks

    long_checks, short_checks = side(1), side(-1)
    score = lambda checks: round(100*sum(c['passed'] for c in checks)/len(checks))  # noqa: E731
    values = dict(atr=float(bar.atr), session=str(bar.session))
    if s.use_adx_filter:
        values['adx'] = float(bar.adx)
    if s.use_rsi_filter:
        values['rsi'] = float(bar.rsi)
    if s.use_regime_filter:
        values['regime'] = str(bar.regime)
    return dict(longChecks=long_checks, shortChecks=short_checks, longReadiness=score(long_checks), shortReadiness=score(short_checks),
                indicators=values)


# Step-by-step comparison (the user's six variants).
VARIANTS = (
    ('baseline', 'SuperTrend + ATR minimum (stop and reverse)', dict(use_trend_filter=False, use_adx_filter=False, use_rsi_filter=False,
                                                         use_volatility_filter=False, use_session_filter=False, use_news_filter=False,
                                                         use_regime_filter=False, use_atr_exits=False)),
    ('ema', '+ EMA trend filter', dict(use_trend_filter=True, use_adx_filter=False, use_rsi_filter=False, use_volatility_filter=False,
                                       use_session_filter=False, use_news_filter=False, use_regime_filter=False, use_atr_exits=False)),
    ('adx', '+ ADX', dict(use_trend_filter=True, use_adx_filter=True, use_rsi_filter=False, use_volatility_filter=False, use_session_filter=False, use_news_filter=False,
                          use_regime_filter=False, use_atr_exits=False)),
    ('rsi', '+ RSI', dict(use_trend_filter=True, use_adx_filter=True, use_rsi_filter=True, use_volatility_filter=False, use_session_filter=False, use_news_filter=False,
                          use_regime_filter=False, use_atr_exits=False)),
    ('atr_exits', '+ ATR exits (SL / TP / BE / trail / time)', dict(use_trend_filter=True, use_adx_filter=True, use_rsi_filter=True,
                                                                  use_volatility_filter=False, use_session_filter=False,
                                                                  use_news_filter=False, use_regime_filter=False, use_atr_exits=True)),
    ('full', '+ regime, volatility, session and news filters', dict(use_trend_filter=True, use_adx_filter=True, use_rsi_filter=True,
                                                                   use_volatility_filter=True, use_session_filter=True,
                                                                   use_news_filter=True, use_regime_filter=True, use_atr_exits=True)),
)


def variant(s: Settings, key: str) -> Settings:
    return replace(s, **dict((k, v) for name, _, changes in VARIANTS if name == key for k, v in changes.items()))

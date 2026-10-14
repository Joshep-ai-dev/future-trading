"""Python migration of BB Outer Band Reversal + Trailing SL (Pine v6).

Usage: result = run_backtest(ohlc_frame, Settings())
Input: chronological, completed OHLC candles in a pandas DataFrame.
Output: bars (indicators/signals/equity), closed trades, and any open position.
Market entries/reversals fill at close. Previously submitted stops fill intrabar,
at open on gaps. Trailing stops calculated at close apply from that close onward;
if already crossed they fill at close. No commission, slippage or margin model.
Prices/distances are in instrument price units; quantity defaults to one unit.
Missing candles are rejected. No weekend/session filter is added by this strategy.
"""
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .indicators import atr


@dataclass(frozen=True)
class Settings:
    trade_mode: str = 'Both'
    bb_length: int = 20
    bb_mult: float = 3.0
    min_bb_width_pct: float = 0.8
    atr_length: int = 14
    min_atr: float = 0.03
    adx_length: int = 14
    adx_threshold: float = 20.0
    pullback_bars: int = 3
    initial_sl: float = 0.50
    trail_trigger: float = 0.60
    trail_distance: float = 0.30
    trail_multiplier: float = 2.0
    sma_length: int = 30
    use_sma_trend_adjustment: bool = True
    sma_slope_bars: int = 3
    counter_profit_pct: float = 75.0
    counter_sl_pct: float = 75.0
    min_tick: float = 0.01
    initial_capital: float = 10000.0
    quantity: float = 1.0
    leverage: float | None = None

    def __post_init__(self):
        if self.leverage is not None and (not np.isfinite(self.leverage) or not 1 <= self.leverage <= 100):
            raise ValueError('leverage must be between 1 and 100')
        if not isinstance(self.use_sma_trend_adjustment, bool):
            raise ValueError('use_sma_trend_adjustment must be a boolean')
        if self.trade_mode not in ('Both', 'Long Only', 'Short Only'):
            raise ValueError('Invalid trade_mode')
        for name in ('bb_length', 'atr_length', 'adx_length', 'pullback_bars',
                     'sma_length', 'sma_slope_bars'):
            value = getattr(self, name)
            if not isinstance(value, int) or isinstance(value, bool) or value < 1:
                raise ValueError(f'{name} must be a positive integer')
        for name in ('bb_mult', 'min_bb_width_pct', 'min_atr', 'adx_threshold',
                     'initial_sl', 'trail_trigger', 'trail_distance',
                     'trail_multiplier', 'counter_profit_pct', 'counter_sl_pct',
                     'min_tick', 'initial_capital', 'quantity'):
            if not np.isfinite(getattr(self, name)):
                raise ValueError(f'{name} must be finite')
        if self.min_bb_width_pct < 0 or not 0 <= self.adx_threshold <= 100:
            raise ValueError('Invalid width or ADX threshold')
        if any(getattr(self, k) <= 0 for k in ('min_tick', 'quantity', 'initial_capital')):
            raise ValueError('Tick, quantity and capital must be positive')
        if min(self.initial_sl, self.trail_trigger, self.trail_distance) < 0.01:
            raise ValueError('Stop and trailing distances must be >= 0.01')
        if self.trail_multiplier < 1:
            raise ValueError('trail_multiplier must be >= 1')
        if not all(1 <= v <= 100 for v in (self.counter_profit_pct, self.counter_sl_pct)):
            raise ValueError('Countertrend percentages must be between 1 and 100')


def _rma(values, length):
    """Pine-style Wilder smoothing, seeded by the first length valid samples."""
    output = np.full(len(values), np.nan)
    seed, average = [], None
    for i, value in enumerate(values):
        if not np.isfinite(value):
            continue
        if average is None:
            seed.append(value)
            if len(seed) == length:
                average = float(np.mean(seed))
        else:
            average += (value - average) / length
        if average is not None:
            output[i] = average
    return output


def calculate(frame, settings=None, *, bar_seconds=None):
    """Calculate BB (population deviation), ATR, Wilder DMI/ADX and SMA slope."""
    s = settings or Settings()
    if bar_seconds and len(frame) and isinstance(frame.index, pd.DatetimeIndex):
        groups = (frame.index.to_series().diff().dt.total_seconds() > bar_seconds).cumsum()
        if groups.max() > 0:
            return pd.concat([calculate(part, s) for _, part in frame.groupby(groups)])
    if not frame.index.is_monotonic_increasing or not frame.index.is_unique:
        raise ValueError('Candles must have a unique chronological index')
    data = frame[['open', 'high', 'low', 'close']].astype(float)
    if not np.isfinite(data.to_numpy()).all():
        raise ValueError('OHLC candles must be finite')
    if ((data.high < data[['open', 'close', 'low']].max(axis=1)) |
            (data.low > data[['open', 'close', 'high']].min(axis=1))).any():
        raise ValueError('Invalid OHLC candle bounds')
    result = data.copy()
    basis = data.close.rolling(s.bb_length).mean()
    deviation = s.bb_mult * data.close.rolling(s.bb_length).std(ddof=0)
    result['bb_basis'] = basis
    result['bb_upper'] = basis + deviation
    result['bb_lower'] = basis - deviation
    result['bb_width_pct'] = 200 * deviation / basis.abs().replace(0, np.nan)
    result['atr'] = atr(data, s.atr_length)
    up, down = data.high.diff(), -data.low.diff()
    plus = np.where((up > down) & (up > 0), up, 0.).astype(float)
    minus = np.where((down > up) & (down > 0), down, 0.).astype(float)
    tr = pd.concat([data.high-data.low, (data.high-data.close.shift()).abs(),
                    (data.low-data.close.shift()).abs()], axis=1).max(axis=1).to_numpy()
    if len(data):
        # ta.dmi uses ta.tr (first bar undefined), unlike ta.atr's ta.tr(true).
        plus[0] = minus[0] = tr[0] = np.nan
    smooth_tr = _rma(tr, s.adx_length)
    with np.errstate(divide='ignore', invalid='ignore'):
        plus_di = 100 * _rma(plus, s.adx_length) / smooth_tr
        minus_di = 100 * _rma(minus, s.adx_length) / smooth_tr
    plus_di = pd.Series(plus_di).ffill().to_numpy()
    minus_di = pd.Series(minus_di).ffill().to_numpy()
    total = plus_di + minus_di
    dx = np.abs(plus_di-minus_di) / np.where(total == 0, 1, total)
    result['adx'] = 100 * _rma(dx, s.adx_length)
    result['trend_sma'] = data.close.rolling(s.sma_length).mean() if s.use_sma_trend_adjustment else np.nan
    previous = result.trend_sma.shift(s.sma_slope_bars)
    result['sma_ready'] = previous.notna()
    result['sma_uptrend'] = result.trend_sma > previous
    result['sma_downtrend'] = result.trend_sma < previous
    return result


def run_backtest(frame, settings=None, *, start=None, close_at_end=False, bar_seconds=None):
    """Run completed bars; retain open positions at the end (as Pine does).

    Does not reproduce TradingView margin liquidation, bar magnifier, or tick
    rounding. Set min_tick to the instrument's syminfo.mintick equivalent.
    """
    s = settings or Settings()
    bars = calculate(frame, s, bar_seconds=bar_seconds)
    if start is not None:
        bars = bars.loc[bars.index >= start]
    trades, records = [], []
    position = None
    cash, last_direction = s.initial_capital, 0
    lower_touch = upper_touch = None

    def close_position(time, price, reason):
        nonlocal cash, position
        pnl = (price-position['entry_price']) * position['direction'] * position['quantity']
        cash += pnl
        trades.append(dict(**position, exit_time=time, exit_price=float(price),
                           exit_reason=reason, pnl=float(pnl)))
        position = None

    for i, (time, bar) in enumerate(bars.iterrows()):
        if bar_seconds and i and (time-bars.index[i-1]).total_seconds() > bar_seconds:
            if position is not None:
                close_position(bars.index[i-1], bars.close.iloc[i-1], 'data_gap')
            lower_touch = upper_touch = None
        if position is not None:
            stop, direction = position['stop'], position['direction']
            if direction == 1 and bar.low <= stop:
                close_position(time, min(bar.open, stop), 'stop')
            elif direction == -1 and bar.high >= stop:
                close_position(time, max(bar.open, stop), 'stop')

        if bar.low <= bar.bb_lower:
            lower_touch = i
        if bar.high >= bar.bb_upper:
            upper_touch = i
        if lower_touch is not None and i-lower_touch >= s.pullback_bars:
            lower_touch = None
        if upper_touch is not None and i-upper_touch >= s.pullback_bars:
            upper_touch = None
        inside = bar.bb_lower < bar.close < bar.bb_upper
        long_rebound = lower_touch is not None and bar.close > bar.open and inside
        short_rebound = upper_touch is not None and bar.close < bar.open and inside
        if long_rebound:
            lower_touch = None
        if short_rebound:
            upper_touch = None
        allowed = (cash > 0 and (not s.use_sma_trend_adjustment or bar.sma_ready) and bar.atr >= s.min_atr and
                   bar.bb_width_pct >= s.min_bb_width_pct and bar.adx > s.adx_threshold)
        direction = 0
        if allowed and long_rebound and last_direction != 1 and s.trade_mode != 'Short Only':
            direction = 1
        elif allowed and short_rebound and last_direction != -1 and s.trade_mode != 'Long Only':
            direction = -1
        activated = False
        if direction:
            if position is not None:
                close_position(time, bar.close, 'reversal')
            if cash <= 0:
                direction = 0
        if direction:
            counter = s.use_sma_trend_adjustment and (bar.sma_downtrend if direction == 1 else bar.sma_uptrend)
            sl = max(s.min_tick, s.initial_sl * (s.counter_sl_pct/100 if counter else 1))
            scale = s.counter_profit_pct/100 if counter else 1
            quantity = s.quantity if s.leverage is None else cash*s.leverage/bar.close
            position = dict(direction=direction, entry_time=time, entry_price=float(bar.close), quantity=float(quantity),
                            stop=float(bar.close-direction*sl), extreme=float(bar.close),
                            trailing_active=False, countertrend=bool(counter),
                            trail_trigger=max(s.min_tick, s.trail_trigger*s.trail_multiplier*scale),
                            trail_distance=max(s.min_tick, s.trail_distance*s.trail_multiplier*scale))
            last_direction = direction
        elif position is not None:
            p = position
            d = p['direction']
            p['extreme'] = max(p['extreme'], bar.high) if d == 1 else min(p['extreme'], bar.low)
            if not p['trailing_active'] and d*(p['extreme']-p['entry_price']) >= p['trail_trigger']:
                p['trailing_active'] = activated = True
            if p['trailing_active']:
                candidate = p['extreme']-d*p['trail_distance']
                p['stop'] = max(p['stop'], candidate) if d == 1 else min(p['stop'], candidate)
                if d*(bar.close-p['stop']) <= 0:
                    close_position(time, bar.close, 'trailing_stop_at_close')
        unrealized = 0 if position is None else (bar.close-position['entry_price'])*position['direction']*position['quantity']
        records.append(dict(long_signal=direction == 1, short_signal=direction == -1,
                            trailing_activated=activated, position=0 if position is None else position['direction'],
                            stop=np.nan if position is None else position['stop'],
                            trailing_active=False if position is None else position['trailing_active'],
                            equity=float(cash+unrealized)))
    if close_at_end and position is not None and len(bars):
        close_position(bars.index[-1], bars.close.iloc[-1], 'period_end')
        records[-1].update(position=0, stop=np.nan, trailing_active=False, equity=float(cash))
    diagnostics = pd.DataFrame(records, index=bars.index)
    return dict(bars=bars.join(diagnostics), trades=pd.DataFrame(trades),
                open_position=None if position is None else position.copy(), cash=float(cash))

"""Python migration of BB Outer Band Reversal + Trailing SL (Pine v6).

Usage: result = run_backtest(ohlc_frame, Settings())
Input: chronological, completed OHLC candles in a pandas DataFrame.
Output: bars (indicators/signals/equity), closed trades, and any open position.
Market entries/reversals fill at close. Previously submitted stops fill intrabar,
at open on gaps. Trailing stops calculated at close apply from that close onward;
if already crossed they fill at close. Configurable commission, adverse fills and prorated funding; no margin model.
Prices/distances are in instrument price units; quantity defaults to one unit.
Missing candles are rejected. No weekend/session filter is added by this strategy.
"""
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .indicators import atr, rsi


@dataclass(frozen=True)
class Settings:
    reward_risk: float = 0.0
    risk_per_trade_pct: float = 0.5
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
    min_tick_unit: str = 'price'
    initial_capital: float = 10000.0
    quantity: float = 1.0
    leverage: float | None = None
    amount_per_trade: float = 100.0
    amount_unit: str = 'percent'
    rsi_exit_enabled: bool = False
    rsi_exit_length: int = 14
    rsi_exit_move: float = 0.30
    rsi_exit_short: float = 15.
    rsi_exit_long: float = 85.

    def __post_init__(self):
        if not np.isfinite(self.reward_risk) or not 0 <= self.reward_risk <= 10:
            raise ValueError('Reward/risk must be between 0 and 10')
        if not np.isfinite(self.risk_per_trade_pct) or not 0 < self.risk_per_trade_pct <= 5:
            raise ValueError('Risk per trade must be between 0 and 5 percent')
        if not isinstance(self.rsi_exit_enabled, bool):
            raise ValueError('RSI exit enabled must be boolean')
        if isinstance(self.rsi_exit_length, bool) or not isinstance(self.rsi_exit_length, int) or not 1 <= self.rsi_exit_length <= 500:
            raise ValueError('RSI exit length must be an integer between 1 and 500')
        if not np.isfinite(self.rsi_exit_move) or self.rsi_exit_move < 0:
            raise ValueError('RSI exit price move must be finite and nonnegative')
        if not all(np.isfinite(v) and 0 <= v <= 100 for v in (self.rsi_exit_short, self.rsi_exit_long)):
            raise ValueError('RSI exit thresholds must be between 0 and 100')
        if self.amount_unit not in ('price', 'percent'):
            raise ValueError('amount_unit must be price ($) or percent')
        if not np.isfinite(self.amount_per_trade) or self.amount_per_trade <= 0:
            raise ValueError('Amount per trade must be positive and finite')
        if self.amount_unit == 'percent' and self.amount_per_trade > 100:
            raise ValueError('Amount per trade cannot exceed 100% of balance')
        if self.min_tick_unit not in ('price', 'percent'):
            raise ValueError('min_tick_unit must be price or percent')
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
    result['exit_rsi'] = rsi(data, s.rsi_exit_length) if s.rsi_exit_enabled else np.nan
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


def run_backtest(frame, settings=None, *, start=None, close_at_end=False, bar_seconds=None,
                prepared_bars=None, fee_bps=0., slippage=0., spread=0., funding_bps=0.):
    """Run completed bars; retain open positions at the end (as Pine does).

    Does not reproduce TradingView margin liquidation, bar magnifier, or tick
    rounding. Set min_tick to the instrument's syminfo.mintick equivalent.
    """
    if not all(np.isfinite(v) for v in (fee_bps, slippage, spread, funding_bps)) or min(fee_bps, slippage, spread) < 0:
        raise ValueError('Execution costs must be finite; fees, slippage and spread must be nonnegative')
    s = settings or Settings()
    adverse = slippage+spread/2
    bars = prepared_bars if prepared_bars is not None else calculate(frame, s, bar_seconds=bar_seconds)
    if start is not None:
        bars = bars.loc[bars.index >= start]
    trades, records = [], []
    position = None
    cash, last_direction = s.initial_capital, 0
    lower_touch = upper_touch = None

    def accrue_funding(time):
        nonlocal cash
        if position is None:
            return
        stamp = float(time.timestamp()) if hasattr(time, 'timestamp') else float(time)
        elapsed = stamp-position['funding_time']
        charge = position['entry_price']*position['quantity']*funding_bps/10000*position['direction']*max(0, elapsed)/(8*3600)
        cash -= charge
        position['funding'] += charge
        position['funding_time'] = stamp

    def close_position(time, price, reason):
        nonlocal cash, position
        accrue_funding(time)
        d, q = position['direction'], position['quantity']
        fill = price-d*adverse
        exit_fee = abs(fill*q)*fee_bps/10000
        filled_gross = (fill-position['entry_price'])*d*q
        fees = position['entry_fee']+exit_fee
        pnl = filled_gross-fees-position['funding']
        cash += filled_gross-exit_fee
        gross = (price-position['reference_entry'])*d*q
        trades.append(dict(**position, exit_time=time, exit_price=float(fill),
                           exit_reason=reason, pnl=float(pnl), gross_pnl=float(gross),
                           fees=float(fees), execution_cost=float(gross-filled_gross)))
        position = None

    for i, bar in enumerate(bars.itertuples()):
        time = bar.Index
        if bar_seconds and i and (time-bars.index[i-1]).total_seconds() > bar_seconds:
            if position is not None:
                close_position(bars.index[i-1], bars.close.iloc[i-1], 'data_gap')
            lower_touch = upper_touch = None
        if position is not None:
            accrue_funding(time)
            stop, direction = position['stop'], position['direction']
            if direction == 1 and bar.low <= stop:
                close_position(time, min(bar.open, stop), 'stop')
            elif direction == -1 and bar.high >= stop:
                close_position(time, max(bar.open, stop), 'stop')

        if position is not None and s.reward_risk > 0:
            target = position['target']
            if (position['direction'] == 1 and bar.high >= target) or (position['direction'] == -1 and bar.low <= target):
                close_position(time, target, 'profit_target')

        if position is not None and s.rsi_exit_enabled and s.reward_risk == 0:
            exit_rsi = getattr(bar, 'exit_rsi', np.nan)
            # User-defined upward price difference for BOTH sides, not directional profit.
            price_condition = bar.close > position['entry_price']+s.rsi_exit_move
            rsi_condition = (exit_rsi < s.rsi_exit_short if position['direction'] == -1
                             else exit_rsi > s.rsi_exit_long)
            if price_condition and np.isfinite(exit_rsi) and rsi_condition:
                close_position(time, bar.close, 'rsi_price_exit')

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
        if position is not None and s.reward_risk > 0:
            direction = 0
        activated = False
        if direction:
            if position is not None:
                close_position(time, bar.close, 'reversal')
            if cash <= 0:
                direction = 0
        if direction:
            counter = s.use_sma_trend_adjustment and (bar.sma_downtrend if direction == 1 else bar.sma_uptrend)
            minimum = s.min_tick if s.min_tick_unit == 'price' else bar.close*s.min_tick/100
            sl = max(minimum, s.initial_sl * (s.counter_sl_pct/100 if counter else 1))
            scale = s.counter_profit_pct/100 if counter else 1
            amount = cash*s.amount_per_trade/100 if s.amount_unit == 'percent' else min(s.amount_per_trade, cash)
            quantity = s.quantity if s.leverage is None else amount*s.leverage/bar.close
            entry = float(bar.close)+direction*adverse
            if s.reward_risk > 0:
                quantity = min(quantity, cash*s.risk_per_trade_pct/100/(sl+2*adverse+2*abs(entry)*fee_bps/10000))
            entry_fee = abs(entry*quantity)*fee_bps/10000
            cash -= entry_fee
            position = dict(reference_entry=float(bar.close), entry_fee=entry_fee, funding=0., funding_time=float(time.timestamp()) if hasattr(time, 'timestamp') else float(time),
                            target=(entry+direction*(s.reward_risk*sl+2*adverse+2*abs(entry)*fee_bps/10000)) if s.reward_risk > 0 else None,
                            direction=direction, entry_time=time, entry_price=entry, quantity=float(quantity),
                            stop=float(entry-direction*sl), initial_stop=float(entry-direction*sl), extreme=float(bar.close),
                            trailing_active=False, countertrend=bool(counter),
                            trail_trigger=max(minimum, s.trail_trigger*s.trail_multiplier*scale),
                            trail_distance=max(minimum, s.trail_distance*s.trail_multiplier*scale))
            position['stop_history'] = [dict(time=int(time.timestamp()) if hasattr(time, 'timestamp') else int(time),
                                             price=position['stop'], reason='initial')]
            last_direction = direction
        elif position is not None and s.reward_risk == 0:
            p = position
            d = p['direction']
            p['extreme'] = max(p['extreme'], bar.high) if d == 1 else min(p['extreme'], bar.low)
            if not p['trailing_active'] and d*(p['extreme']-p['entry_price']) >= p['trail_trigger']:
                p['trailing_active'] = activated = True
            if p['trailing_active']:
                previous_stop = p['stop']
                candidate = p['extreme']-d*p['trail_distance']
                p['stop'] = max(p['stop'], candidate) if d == 1 else min(p['stop'], candidate)
                if activated or p['stop'] != previous_stop:
                    p['stop_history'].append(dict(time=int(time.timestamp()) if hasattr(time, 'timestamp') else int(time),
                                                  price=p['stop'], reason='activation' if activated else 'trailing'))
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

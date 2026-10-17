"""Signal-driven position simulator shared by non-BB strategies.

Given per-bar entry signals (+1 long, -1 short, 0 none) and per-bar stop and
target distances, it reproduces the BB engine's execution rules: entries fill
at the completed candle close, stops and targets use OHLC with adverse gap
fills, a bar touching both is resolved stop-first, and fees, spread, slippage
and prorated funding are charged. Output matches ``bb_outer_reversal.run_backtest``
so the dashboard adapter, paper trading and charts can consume either engine.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd


@dataclass(frozen=True)
class ExecutionSettings:
    initial_capital: float = 2000.
    leverage: float = 1.
    amount_per_trade: float = 100.
    amount_unit: str = 'percent'
    max_hold_bars: int = 12
    reverse_on_signal: bool = True
    min_tick: float = .01


def _seconds(time) -> float:
    return float(time.timestamp()) if hasattr(time, 'timestamp') else float(time)


def run_signal_backtest(bars: pd.DataFrame, signals: np.ndarray, stop_distance: np.ndarray, target_distance: np.ndarray,
                        settings: ExecutionSettings, *, start=None, close_at_end=False, bar_seconds=None,
                        fee_bps=0., slippage=0., spread=0., funding_bps=0.,
                        trail_activation: np.ndarray | None = None, trail_distance: np.ndarray | None = None):
    """Simulate trades. Optional per-bar trailing: after price moves ``trail_activation`` in favour,
    the stop follows the best price at ``trail_distance`` and never loosens (NaN disables trailing)."""
    if not all(np.isfinite(v) for v in (fee_bps, slippage, spread, funding_bps)) or min(fee_bps, slippage, spread) < 0:
        raise ValueError('Execution costs must be finite; fees, slippage and spread must be nonnegative')
    signals = np.asarray(signals, float)
    n_all = len(signals)
    trail_activation = np.full(n_all, np.nan) if trail_activation is None else np.asarray(trail_activation, float)
    trail_distance = np.full(n_all, np.nan) if trail_distance is None else np.asarray(trail_distance, float)
    if start is not None:
        keep = bars.index >= start
        bars, signals = bars.loc[keep], signals[keep]
        stop_distance, target_distance = np.asarray(stop_distance)[keep], np.asarray(target_distance)[keep]
        trail_activation, trail_distance = trail_activation[keep], trail_distance[keep]
    adverse = slippage+spread/2
    cash, position, trades, records = float(settings.initial_capital), None, [], []

    def accrue_funding(time):
        nonlocal cash
        if position is None:
            return
        stamp = _seconds(time)
        charge = position['entry_price']*position['quantity']*funding_bps/10000*position['direction']*max(0., stamp-position['funding_time'])/(8*3600)
        cash -= charge
        position['funding'] += charge
        position['funding_time'] = stamp

    def close_position(time, price, reason):
        nonlocal cash, position
        accrue_funding(time)
        direction, quantity = position['direction'], position['quantity']
        fill = price-direction*adverse
        exit_fee = abs(fill*quantity)*fee_bps/10000
        filled_gross = (fill-position['entry_price'])*direction*quantity
        cash += filled_gross-exit_fee
        gross = (price-position['reference_entry'])*direction*quantity
        trades.append(dict(**position, exit_time=time, exit_price=float(fill), exit_reason=reason,
                           pnl=float(filled_gross-position['entry_fee']-exit_fee-position['funding']),
                           gross_pnl=float(gross), fees=float(position['entry_fee']+exit_fee),
                           execution_cost=float(gross-filled_gross)))
        position = None

    def open_position(time, close, direction, stop, target, index, activation=np.nan, distance=np.nan):
        nonlocal cash, position
        amount = cash*settings.amount_per_trade/100 if settings.amount_unit == 'percent' else min(settings.amount_per_trade, cash)
        quantity = amount*settings.leverage/close
        if quantity <= 0:
            return
        entry = float(close)+direction*adverse
        entry_fee = abs(entry*quantity)*fee_bps/10000
        cash -= entry_fee
        stop_price = float(entry-direction*max(settings.min_tick, stop))
        target_price = float(entry+direction*max(settings.min_tick, target)) if np.isfinite(target) else direction*np.inf
        position = dict(reference_entry=float(close), entry_fee=entry_fee, funding=0., funding_time=_seconds(time),
                        direction=direction, entry_time=time, entry_price=entry, quantity=float(quantity),
                        stop=stop_price, initial_stop=stop_price, target=target_price,
                        trailing_active=False, entry_index=index, extreme=float(close),
                        trail_trigger=float(activation) if np.isfinite(activation) else 0.,
                        trail_distance=float(distance) if np.isfinite(distance) and np.isfinite(activation) else np.nan,
                        stop_history=[dict(time=int(_seconds(time)), price=stop_price, reason='initial')])

    index = bars.index
    for i, bar in enumerate(bars.itertuples()):
        time = bar.Index
        if bar_seconds and i and (time-index[i-1]).total_seconds() > bar_seconds and position is not None:
            close_position(index[i-1], bars.close.iloc[i-1], 'data_gap')
        if position is not None:
            accrue_funding(time)
            direction, stop, target = position['direction'], position['stop'], position['target']
            stop_hit = bar.low <= stop if direction == 1 else bar.high >= stop
            target_hit = bar.high >= target if direction == 1 else bar.low <= target
            if stop_hit:
                close_position(time, min(bar.open, stop) if direction == 1 else max(bar.open, stop), 'stop')
            elif target_hit:
                close_position(time, max(bar.open, target) if direction == 1 else min(bar.open, target), 'take_profit')
            elif i-position['entry_index'] >= settings.max_hold_bars:
                close_position(time, bar.close, 'time_exit')
            elif np.isfinite(position['trail_distance']):
                p = position
                p['extreme'] = max(p['extreme'], bar.high) if direction == 1 else min(p['extreme'], bar.low)
                activated = not p['trailing_active'] and direction*(p['extreme']-p['entry_price']) >= p['trail_trigger']
                p['trailing_active'] = p['trailing_active'] or activated
                if p['trailing_active']:
                    previous = p['stop']
                    candidate = p['extreme']-direction*p['trail_distance']
                    p['stop'] = max(previous, candidate) if direction == 1 else min(previous, candidate)
                    if activated or p['stop'] != previous:
                        p['stop_history'].append(dict(time=int(_seconds(time)), price=p['stop'],
                                                      reason='activation' if activated else 'trailing'))
                    if direction*(bar.close-p['stop']) <= 0:
                        close_position(time, bar.close, 'trailing_stop_at_close')
        signal = int(signals[i]) if np.isfinite(signals[i]) else 0
        valid = signal and np.isfinite(stop_distance[i]) and not np.isnan(target_distance[i])
        if valid and position is not None and position['direction'] != signal and settings.reverse_on_signal:
            close_position(time, bar.close, 'reversal')
        if valid and position is None and cash > 0:
            open_position(time, bar.close, signal, stop_distance[i], target_distance[i], i, trail_activation[i], trail_distance[i])
            signal = signal if position is not None else 0
        else:
            signal = 0  # Already positioned this way, blocked, or no valid signal: no new entry.
        unrealized = 0. if position is None else (bar.close-position['entry_price'])*position['direction']*position['quantity']
        records.append(dict(long_signal=signal == 1, short_signal=signal == -1,
                            position=0 if position is None else position['direction'],
                            stop=np.nan if position is None else position['stop'],
                            target=np.nan if position is None or not np.isfinite(position['target']) else position['target'],
                            trailing_active=False if position is None else position['trailing_active'],
                            equity=float(cash+unrealized)))
    if close_at_end and position is not None and len(bars):
        close_position(index[-1], bars.close.iloc[-1], 'period_end')
        records[-1].update(position=0, stop=np.nan, target=np.nan, equity=float(cash))
    # "No take-profit" is infinite internally; publish it as None so JSON (API, MySQL) stays valid.
    for trade in trades:
        trade.pop('entry_index', None)
        if not np.isfinite(trade['target']):
            trade['target'] = None
    open_copy = None if position is None else {k: v for k, v in position.items() if k != 'entry_index'}
    if open_copy is not None and not np.isfinite(open_copy['target']):
        open_copy['target'] = None
    diagnostics = pd.DataFrame(records, index=bars.index)
    return dict(bars=bars.join(diagnostics), trades=pd.DataFrame(trades), open_position=open_copy, cash=float(cash))

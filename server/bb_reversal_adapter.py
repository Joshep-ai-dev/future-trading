"""Map the Pine strategy into the dashboard's periods, ledger and chart schema."""
from dataclasses import replace
from datetime import timedelta

import numpy as np
import pandas as pd

from .bb_outer_reversal import Settings, run_backtest
from .data import TIMEFRAMES
from .strategy import metrics, seconds


def run_bb_reversal_backtest(frame, settings):
    duration = TIMEFRAMES[settings.entry_timeframe]
    config = replace(Settings(**settings.bb_reversal), initial_capital=settings.capital,
                     min_tick=settings.tick_size, min_tick_unit='price', trade_mode='Both', leverage=settings.max_leverage)
    start, end = (seconds(settings.start_date),
                         seconds(settings.end_date+timedelta(days=1)))
    clean = frame.dropna(subset=['open', 'high', 'low', 'close'])
    clean = clean.loc[clean.index + pd.Timedelta(seconds=duration) <= pd.Timestamp(end, unit='s', tz='UTC')]

    def period(left, right, name):
        subset = clean.loc[clean.index + pd.Timedelta(seconds=duration) <= pd.Timestamp(right, unit='s', tz='UTC')]
        result = run_backtest(subset, config, start=pd.Timestamp(left, unit='s', tz='UTC'),
                              close_at_end=True, bar_seconds=duration)
        trades, balance = [], settings.capital
        for i, trade in enumerate(result['trades'].to_dict('records')):
            balance += trade['pnl']
            initial_stop = trade['initial_stop']
            risk = abs(trade['entry_price']-initial_stop)*trade['quantity']
            entry_time, exit_time = int(trade['entry_time'].timestamp()), int(trade['exit_time'].timestamp())
            history = trade['stop_history']
            trades.append(dict(id=i+1, direction=trade['direction'], signalTime=entry_time,
                entryTime=entry_time, exitTime=exit_time, entry=trade['entry_price'], exit=trade['exit_price'],
                stop=initial_stop, initialStop=initial_stop, finalStop=trade['stop'], stopHistory=history,
                trailActivationPrice=trade['entry_price']+trade['direction']*trade['trail_trigger'],
                initialRisk=risk, target=None, trigger=None, sweepLevel=None, quantity=trade['quantity'],
                riskBudget=risk, plannedRisk=risk, netPnl=trade['pnl'], grossPnl=trade['pnl'],
                fees=0., funding=0., executionCost=0., netR=trade['pnl']/risk, balance=balance,
                exitReason=trade['exit_reason'], session='continuous', ambiguous=False, obstacle=None,
                signalLabel='BB outer-band rebound', signalCloseTime=entry_time+duration,
                swingHighs=[], swingLows=[], period=name))
        equity = [dict(time=int(t.timestamp()), value=float(v)) for t, v in result['bars'].equity.items()] if len(result['bars']) else []
        if not equity or equity[0]['time'] > left:
            equity.insert(0, dict(time=left, value=settings.capital))
        count = int(result['bars'][['long_signal', 'short_signal']].to_numpy().sum()) if len(result['bars']) else 0
        return dict(name=name, start=left, end=right, trades=trades, equity=equity,
            summary=metrics(trades, equity, settings.capital),
            status='complete' if len(result['bars']) else 'no_complete_bars',
            diagnostics=dict(signals=count, sweeps=0, invalidEntries=0, blockedByLevel=0,
                             expiredOrders=0, cancelledOrders=0, ambiguousBars=0))

    from .bb_outer_reversal import calculate
    calculated = calculate(clean, config, bar_seconds=duration)
    displayed = calculated.loc[calculated.index >= pd.Timestamp(start, unit='s', tz='UTC')]
    candles, points = [], []
    for stamp, bar in displayed.iterrows():
        t = int(stamp.timestamp())
        candles.append(dict(time=t, **{key:float(bar[key]) for key in ('open','high','low','close')}))
        point = dict(time=t, ema20=None, ema50=None, rsi20=None)
        for key, source in [('bbBasis','bb_basis'), ('bbUpper','bb_upper'), ('bbLower','bb_lower'),
                            ('trendSma','trend_sma'), ('adx','adx'), ('atr','atr'), ('bbWidthPct','bb_width_pct')]:
            point[key] = float(bar[source]) if np.isfinite(bar[source]) else None
        points.append(point)
    return dict(settings=settings.model_dump(mode='json'), strategyName='BB Outer Band Reversal + Trailing SL',
        executionTimeframe=settings.entry_timeframe, barSeconds=duration,
        backtest=period(start,end,'Backtest'), candles=candles, indicators=points)

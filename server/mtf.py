"""Completed-candle EMA/RSI confirmations. Indicator warmup restarts after gaps."""
from datetime import timedelta

import numpy as np
import pandas as pd

from .data import TIMEFRAMES
from .indicators import indicators, atr
from .strategy import seconds, simulate


def active_stages(settings):
    return [(stage, getattr(settings, f'{stage}_timeframe'))
            for stage in ('direction', 'setup', 'entry') if getattr(settings, f'{stage}_active')]


def execution_stage(settings):
    stages = active_stages(settings)
    if not stages:
        raise ValueError('Activate at least one timeframe for the EMA + RSI strategy.')
    return stages[-1]



def alignment(values, use_rsi=True, threshold=50):
    fast, slow, rsi = values
    if not np.isfinite(fast) or not np.isfinite(slow) or (use_rsi and not np.isfinite(rsi)):
        return 0
    if fast > slow and (not use_rsi or rsi > threshold):
        return 1
    if fast < slow and (not use_rsi or rsi < threshold):
        return -1
    return 0


def build_orders(frames, settings, calculated=None):
    stages = active_stages(settings)
    signal_stage, timeframe = execution_stage(settings)
    calculated = calculated if calculated is not None else {tf: indicators(frames[tf], settings.ema_fast, settings.ema_slow, settings.rsi_period) for _, tf in stages}
    frame = frames[timeframe]
    atr_values = atr(frame, settings.atr_period) if settings.atr_active else None
    bar_seconds = TIMEFRAMES[timeframe]
    closes = frame.index.asi8//10**9 + bar_seconds
    arrays = {tf: calculated[tf].to_numpy() for _, tf in stages}
    times = {tf: frames[tf].index.asi8//10**9 + TIMEFRAMES[tf] for _, tf in stages}
    aligned_indices = {tf: np.searchsorted(times[tf], closes, side='right')-1 for _, tf in stages}
    orders, previous_signal = {}, 0
    prices = frame[['open','high','low','close']].to_numpy()
    for i, close_time in enumerate(closes):
        signal = alignment(arrays[timeframe][i], use_rsi=settings.rsi_active and signal_stage != 'direction', threshold=settings.rsi_threshold)
        fresh = signal != 0 and signal != previous_signal
        previous_signal = signal
        if not fresh or not np.isfinite(prices[i]).all():
            continue
        confirmations = []
        for stage, tf in stages:
            j = int(aligned_indices[tf][i])
            # Never use an unfinished bar, or carry stale confirmations across missing bars.
            if j < 0 or close_time-times[tf][j] >= TIMEFRAMES[tf]:
                break
            values = arrays[tf][j]
            if alignment(values, use_rsi=settings.rsi_active and stage != 'direction', threshold=settings.rsi_threshold) != signal:
                break
            confirmations.append(dict(stage=stage, timeframe=tf, closeTime=int(times[tf][j]),
                                      ema20=float(values[0]), ema50=float(values[1]),
                                      rsi20=float(values[2]) if settings.rsi_active and stage != 'direction' else None))
        if len(confirmations) != len(stages):
            continue
        if atr_values is not None and (not np.isfinite(atr_values[i]) or atr_values[i] <= 0):
            continue
        stop = float(prices[i, 2] if signal == 1 else prices[i, 1])
        orders[i] = dict(direction=signal, orderType='market', trigger=None, stop=stop,
                         sweepLevel=None, obstacle=None, blocked=False, swingHighs=[], swingLows=[],
                         confirmations=confirmations, signalLabel='EMA alignment' if signal_stage == 'direction' or not settings.rsi_active else 'EMA + RSI',
                         signalCloseTime=int(close_time))
        if atr_values is not None:
            orders[i].update(atr=float(atr_values[i]), atrDistance=float(atr_values[i]*settings.atr_multiplier))
    return orders


def run_mtf_backtest(frames, settings):
    _, timeframe = execution_stage(settings)
    frame = frames[timeframe]
    bar_seconds = TIMEFRAMES[timeframe]
    calculated = {tf: indicators(frame, settings.ema_fast, settings.ema_slow, settings.rsi_period) for tf, frame in frames.items()}
    orders = build_orders(frames, settings, calculated)
    start, split, end = seconds(settings.start_date), seconds(settings.validation_date), seconds(settings.end_date+timedelta(days=1))
    exit_values = calculated[timeframe].to_numpy()
    research = simulate(frame, [], settings, start, split, 'Research', bar_seconds, orders, exit_values)
    validation = simulate(frame, [], settings, split, end, 'Validation', bar_seconds, orders, exit_values)
    mask = (frame.index.asi8//10**9 >= start) & (frame.index.asi8//10**9+bar_seconds <= end)
    mask &= frame[['open','high','low','close']].notna().all(axis=1).to_numpy()
    candles = [dict(time=int(t.timestamp()), open=float(r.open), high=float(r.high), low=float(r.low), close=float(r.close))
               for t, r in frame.loc[mask].dropna(subset=['open','high','low','close']).iterrows()]
    indicator_points = [dict(time=int(t.timestamp()), **{k:float(v) if np.isfinite(v) else None for k,v in row.items()})
                        for t,row in calculated[timeframe].loc[mask].iterrows()]
    return dict(settings=settings.model_dump(mode='json'), strategyName='Multi-timeframe EMA + RSI',
                executionTimeframe=timeframe, barSeconds=bar_seconds, research=research,
                validation=validation, candles=candles, indicators=indicator_points)

"""ChartArt v1.2 long-only RSI/Bollinger strategy on completed candles."""
from datetime import timedelta

import numpy as np

from .data import TIMEFRAMES
from .indicators import indicators
from .strategy import seconds, simulate


def weekday_bars(index, bar_seconds, timezone):
    start = index.tz_convert(timezone).dayofweek < 5
    end = (index + np.timedelta64(bar_seconds-1, 's')).tz_convert(timezone).dayofweek < 5
    return np.asarray(start & end)


def calculate(frame, settings):
    closes = frame.close.to_numpy(dtype=float)
    rsi = indicators(frame, 2, 3, settings.rsi_period).rsi20.to_numpy()
    values = np.full((len(frame), 5), np.nan)
    history = []
    for i, close in enumerate(closes):
        if not np.isfinite(close):
            history = []
            continue
        history.append(close)
        if len(history) > settings.bb_period:
            history.pop(0)
        if len(history) == settings.bb_period:
            basis = float(np.mean(history))
            deviation = float(2*np.std(history, ddof=0))
            values[i] = (basis, basis+deviation, rsi[i], close, basis-deviation)
    return values


def build_orders(frame, values, bar_seconds):
    orders = {}
    for i in range(1, len(frame)):
        previous, current = values[i-1], values[i]
        if not np.isfinite(previous).all() or not np.isfinite(current).all():
            continue
        # Pine v3: crossover(vrsi, 50) and crossover(close, lower band).
        if previous[2] <= 50 < current[2] and previous[3] <= previous[4] and current[3] > current[4]:
            stamp = int(frame.index[i].timestamp())
            orders[i] = dict(direction=1, orderType='stop', trigger=float(current[4]),
                # The signal low is a sizing reference when the percent stop is disabled.
                stop=float(frame.low.iloc[i]), sweepLevel=None, obstacle=None,
                blocked=False, swingHighs=[], swingLows=[],
                signalLabel='ChartArt v1.2 long crossover', signalCloseTime=stamp+bar_seconds)
    return orders


def run_chartart_v12_backtest(frame, settings):
    timeframe = settings.entry_timeframe
    bar_seconds = TIMEFRAMES[timeframe]
    weekdays = weekday_bars(frame.index, bar_seconds, settings.session_timezone)
    frame = frame.copy()
    frame.loc[~weekdays, ['open', 'high', 'low', 'close']] = np.nan
    values = calculate(frame, settings)
    orders = build_orders(frame, values, bar_seconds)
    start = seconds(settings.start_date)
    split = seconds(settings.validation_date)
    end = seconds(settings.end_date+timedelta(days=1))
    research = simulate(frame, [], settings, start, split, 'Research', bar_seconds, orders, values, ~weekdays)
    validation = simulate(frame, [], settings, split, end, 'Validation', bar_seconds, orders, values, ~weekdays)
    times = frame.index.as_unit('ns').asi8//10**9
    mask = weekdays & (times >= start) & (times+bar_seconds <= end) & frame[['open','high','low','close']].notna().all(axis=1).to_numpy()
    candles = [dict(time=int(t.timestamp()), open=float(r.open), high=float(r.high), low=float(r.low), close=float(r.close))
               for t, r in frame.loc[mask].iterrows()]
    indicator_points = [dict(time=int(times[i]), ema20=None, ema50=None,
        rsi20=float(values[i,2]) if np.isfinite(values[i,2]) else None,
        bbBasis=float(values[i,0]) if np.isfinite(values[i,0]) else None,
        bbUpper=float(values[i,1]) if np.isfinite(values[i,1]) else None,
        bbLower=float(values[i,4]) if np.isfinite(values[i,4]) else None)
        for i in np.flatnonzero(mask)]
    return dict(settings=settings.model_dump(mode='json'), strategyName='ChartArt RSI + Bollinger v1.2 long-only',
        executionTimeframe=timeframe, barSeconds=bar_seconds, research=research,
        validation=validation, candles=candles, indicators=indicator_points)

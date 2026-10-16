"""Triple-barrier labels: which side would have won from each closed candle.

A long wins when price reaches ``close + take_profit*ATR`` before
``close - stop*ATR`` within ``horizon`` candles; a short mirrors it. A candle
that touches both barriers is counted as a loss, matching the conservative
stop-first execution. Labels use future candles and therefore must only be
used for training on data strictly before the evaluated period.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

LONG, NONE, SHORT = 1, 0, -1
CLASSES = (SHORT, NONE, LONG)


def first_touch(high: np.ndarray, low: np.ndarray, upper: np.ndarray, lower: np.ndarray, horizon: int):
    """Bars until the upper and the lower barrier is first touched (``horizon+1`` when never)."""
    n = len(high)
    never = horizon+1
    up_hit, down_hit = np.full(n, never), np.full(n, never)
    for step in range(1, horizon+1):
        future_high = np.full(n, np.nan)
        future_low = np.full(n, np.nan)
        future_high[:-step], future_low[:-step] = high[step:], low[step:]
        up_hit = np.where((up_hit == never) & (future_high >= upper), step, up_hit)
        down_hit = np.where((down_hit == never) & (future_low <= lower), step, down_hit)
    return up_hit, down_hit


def triple_barrier(frame: pd.DataFrame, atr: pd.Series, horizon: int, take_profit: float, stop: float) -> pd.Series:
    """Class per candle: LONG, SHORT or NONE. The last ``horizon`` candles are NaN (unknown yet)."""
    close, high, low = (frame[column].to_numpy(float) for column in ('close', 'high', 'low'))
    distance = atr.to_numpy(float)
    long_up, long_down = first_touch(high, low, close+take_profit*distance, close-stop*distance, horizon)
    short_up, short_down = first_touch(high, low, close+stop*distance, close-take_profit*distance, horizon)
    long_win = long_up < long_down
    short_win = short_down < short_up
    label = np.where(long_win & ~short_win, LONG, np.where(short_win & ~long_win, SHORT, NONE)).astype(float)
    label[~np.isfinite(distance)] = np.nan
    if horizon:
        label[-horizon:] = np.nan
    return pd.Series(label, index=frame.index, name='label')

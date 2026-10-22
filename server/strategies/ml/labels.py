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


def triple_barrier(frame: pd.DataFrame, atr: pd.Series, horizon: int, take_profit: float, stop: float,
                   cost: np.ndarray | float = 0.) -> pd.Series:
    """Class per candle: LONG, SHORT or NONE. The last ``horizon`` candles are NaN (unknown yet).

    ``cost`` is the round-trip trading cost in price units (fees, spread, slippage). The take-profit
    barrier moves out by it, so a side only wins when its move still clears the target after costs:
    moves too small to pay the fees are labelled NONE instead of teaching the models to chase them.
    """
    close, high, low = (frame[column].to_numpy(float) for column in ('close', 'high', 'low'))
    distance = atr.to_numpy(float)
    cost = np.nan_to_num(np.broadcast_to(np.asarray(cost, float), close.shape), nan=0.)
    long_up, long_down = first_touch(high, low, close+take_profit*distance+cost, close-stop*distance, horizon)
    short_up, short_down = first_touch(high, low, close+stop*distance, close-take_profit*distance-cost, horizon)
    long_win = long_up < long_down
    short_win = short_down < short_up
    label = np.where(long_win & ~short_win, LONG, np.where(short_win & ~long_win, SHORT, NONE)).astype(float)
    label[~np.isfinite(distance)] = np.nan
    if horizon:
        label[-horizon:] = np.nan
    return pd.Series(label, index=frame.index, name='label')


def excursions(frame: pd.DataFrame, atr: pd.Series, horizon: int) -> pd.DataFrame:
    """Largest favourable and adverse move within ``horizon`` candles, in ATR units.

    ``long_mfe`` is how far price rose above the close, ``long_mae`` how far it
    fell below it; shorts mirror these. They are the regression targets the exit
    models learn take-profit and stop distances from. The last ``horizon`` rows
    are NaN because their future is not known yet.
    """
    close, high, low = (frame[column].to_numpy(float) for column in ('close', 'high', 'low'))
    n = len(close)
    future_high, future_low = np.full(n, -np.inf), np.full(n, np.inf)
    for step in range(1, horizon+1):
        future_high[:-step] = np.maximum(future_high[:-step], high[step:])
        future_low[:-step] = np.minimum(future_low[:-step], low[step:])
    distance = atr.to_numpy(float)
    with np.errstate(invalid='ignore', divide='ignore'):
        up, down = (future_high-close)/distance, (close-future_low)/distance
    table = pd.DataFrame(dict(long_mfe=np.maximum(up, 0), long_mae=np.maximum(down, 0),
                              short_mfe=np.maximum(down, 0), short_mae=np.maximum(up, 0)), index=frame.index)
    table[~np.isfinite(distance) | (distance <= 0)] = np.nan
    if horizon:
        table.iloc[-horizon:] = np.nan
    return table

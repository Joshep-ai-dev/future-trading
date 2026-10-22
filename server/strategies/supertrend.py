"""Supertrend: an ATR band that follows price and flips side when price closes through it.

The line sits ``multiplier × ATR`` below price in an uptrend (direction +1) and
above it in a downtrend (direction -1). Each band only moves in the trend's
favour, so the line works as a stop that never loosens. Values on a candle use
that candle's close and earlier data only.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def supertrend(frame: pd.DataFrame, length: int = 10, multiplier: float = 3.) -> tuple[np.ndarray, np.ndarray]:
    """Return ``(line, direction)`` per candle; both are NaN until the ATR is ready."""
    high, low, close = (frame[column].to_numpy(float) for column in ('high', 'low', 'close'))
    n = len(close)
    line, direction = np.full(n, np.nan), np.full(n, np.nan)
    if n == 0:
        return line, direction
    previous_close = np.concatenate(([np.nan], close[:-1]))
    true_range = np.nanmax(np.vstack([high-low, np.abs(high-previous_close), np.abs(low-previous_close)]), axis=0)
    # Wilder's RMA, the ATR used by TradingView's Supertrend.
    atr = pd.Series(true_range).ewm(alpha=1/length, adjust=False, min_periods=length).mean().to_numpy()
    middle = (high+low)/2
    basic_upper, basic_lower = middle+multiplier*atr, middle-multiplier*atr
    upper, lower = np.full(n, np.nan), np.full(n, np.nan)
    for i in range(n):
        if not np.isfinite(atr[i]):
            continue
        if i == 0 or not np.isfinite(upper[i-1]):
            upper[i], lower[i] = basic_upper[i], basic_lower[i]
            direction[i] = 1. if close[i] >= middle[i] else -1.
        else:
            upper[i] = basic_upper[i] if basic_upper[i] < upper[i-1] or close[i-1] > upper[i-1] else upper[i-1]
            lower[i] = basic_lower[i] if basic_lower[i] > lower[i-1] or close[i-1] < lower[i-1] else lower[i-1]
            if direction[i-1] == -1 and close[i] > upper[i]:
                direction[i] = 1.
            elif direction[i-1] == 1 and close[i] < lower[i]:
                direction[i] = -1.
            else:
                direction[i] = direction[i-1]
        line[i] = lower[i] if direction[i] == 1 else upper[i]
    return line, direction

"""Gap-aware Wilder ATR used by the BB strategy."""
import numpy as np


def atr(frame, period=14):
    """Wilder ATR, SMA seed of period true ranges; reset on missing OHLC."""
    output = np.full(len(frame), np.nan)
    previous = average = None
    seed = []
    for i, (high, low, close) in enumerate(frame[['high', 'low', 'close']].to_numpy()):
        if not np.isfinite([high, low, close]).all():
            previous = average = None
            seed = []
            continue
        tr = high-low if previous is None else max(high-low, abs(high-previous), abs(low-previous))
        if average is None:
            seed.append(tr)
            if len(seed) == period:
                average = float(np.mean(seed))
        else:
            average = (average*(period-1)+tr)/period
        if average is not None:
            output[i] = average
        previous = close
    return output

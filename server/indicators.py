"""Gap-aware Wilder ATR used by the BB strategy."""
import numpy as np


def rsi(frame, period=14):
    """Close-price RSI with Wilder averages, reset on missing close values."""
    output = np.full(len(frame), np.nan)
    previous = gain = loss = None
    gains, losses = [], []
    for i, close in enumerate(frame.close.to_numpy()):
        if not np.isfinite(close):
            previous = gain = loss = None
            gains, losses = [], []
            continue
        if previous is not None:
            change = close-previous
            up, down = max(change, 0.), max(-change, 0.)
            if gain is None:
                gains.append(up)
                losses.append(down)
                if len(gains) == period:
                    gain, loss = float(np.mean(gains)), float(np.mean(losses))
            else:
                gain = (gain*(period-1)+up)/period
                loss = (loss*(period-1)+down)/period
            if gain is not None:
                output[i] = (100. if gain > 0 else 50.) if loss == 0 else 100.-100./(1.+gain/loss)
        previous = close
    return output


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

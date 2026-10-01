"""Causal, gap-aware EMA and Wilder RSI calculations."""
import numpy as np
import pandas as pd


def indicators(frame, fast_period=20, slow_period=50, rsi_period=20):
    """Configurable SMA-seeded EMAs and Wilder RSI (flat market = 50)."""
    values = frame.close.to_numpy(dtype=float)
    output = np.full((len(values), 3), np.nan)
    history = []
    ema20 = ema50 = gain = loss = previous = None
    gains, losses = [], []
    for i, value in enumerate(values):
        if not np.isfinite(value):
            history, gains, losses = [], [], []
            ema20 = ema50 = gain = loss = previous = None
            continue
        history.append(value)
        if len(history) == fast_period:
            ema20 = float(np.mean(history))
        elif ema20 is not None:
            ema20 += (value-ema20)*2/(fast_period+1)
        if len(history) == slow_period:
            ema50 = float(np.mean(history))
        elif ema50 is not None:
            ema50 += (value-ema50)*2/(slow_period+1)
        if previous is not None:
            up, down = max(value-previous, 0.), max(previous-value, 0.)
            if gain is None:
                gains.append(up)
                losses.append(down)
                if len(gains) == rsi_period:
                    gain, loss = float(np.mean(gains)), float(np.mean(losses))
            else:
                gain, loss = (gain*(rsi_period-1)+up)/rsi_period, (loss*(rsi_period-1)+down)/rsi_period
        rsi = np.nan if gain is None else (50. if gain == loss == 0 else 100. if loss == 0 else 100-100/(1+gain/loss))
        output[i] = (ema20 if ema20 is not None else np.nan, ema50 if ema50 is not None else np.nan, rsi)
        previous = value
        # Only the initial period closes are needed to seed the EMAs.
        if len(history) > max(fast_period, slow_period):
            history = history[-(max(fast_period, slow_period)+1):]
    return pd.DataFrame(output, index=frame.index, columns=['ema20', 'ema50', 'rsi20'])



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

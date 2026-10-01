"""Causal, gap-aware EMA and Wilder RSI calculations."""
import numpy as np
import pandas as pd


def indicators(frame):
    """SMA-seeded EMA20/50; RSI20 uses Wilder smoothing (flat market = 50)."""
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
        if len(history) == 20:
            ema20 = float(np.mean(history))
        elif ema20 is not None:
            ema20 += (value-ema20)*2/21
        if len(history) == 50:
            ema50 = float(np.mean(history))
        elif ema50 is not None:
            ema50 += (value-ema50)*2/51
        if previous is not None:
            up, down = max(value-previous, 0.), max(previous-value, 0.)
            if gain is None:
                gains.append(up)
                losses.append(down)
                if len(gains) == 20:
                    gain, loss = float(np.mean(gains)), float(np.mean(losses))
            else:
                gain, loss = (gain*19+up)/20, (loss*19+down)/20
        rsi = np.nan if gain is None else (50. if gain == loss == 0 else 100. if loss == 0 else 100-100/(1+gain/loss))
        output[i] = (ema20 if ema20 is not None else np.nan, ema50 if ema50 is not None else np.nan, rsi)
        previous = value
        # Only the initial 50 closes are needed to seed the EMAs.
        if len(history) > 50:
            history = history[-51:]
    return pd.DataFrame(output, index=frame.index, columns=['ema20', 'ema50', 'rsi20'])


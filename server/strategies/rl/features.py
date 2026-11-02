"""Causal candle inputs and indicators for PPO observations."""
from __future__ import annotations

import numpy as np
import pandas as pd

from server.strategies.ml.features import build_features


def build_rl_features(frame: pd.DataFrame) -> pd.DataFrame:
    indicators = build_features(frame, ['returns', 'volatility', 'trend', 'volume', 'candles'])
    # A common reference preserves each candle's OHLC geometry and opening gap
    # without tying the policy to the instrument's absolute price level.
    previous_close = frame.close.shift().replace(0., np.nan)
    candles = pd.DataFrame({
        f'candle_{column}_relative': frame[column]/previous_close-1
        for column in ('open', 'high', 'low', 'close')
    }, index=frame.index)
    if 'volume' in frame:
        candles['candle_log_volume'] = np.log1p(frame.volume.clip(lower=0))
    return pd.concat([candles, indicators], axis=1).replace([np.inf, -np.inf], np.nan).astype(np.float32)

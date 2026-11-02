"""Causal candle inputs and indicators for PPO observations."""
from __future__ import annotations

import numpy as np
import pandas as pd

from server.strategies.ml.features import build_features


def build_rl_features(frame: pd.DataFrame) -> pd.DataFrame:
    indicators = build_features(frame, ['returns', 'volatility', 'trend', 'volume', 'candles', 'higher_timeframe'])
    # A common reference preserves each candle's OHLC geometry and opening gap
    # without tying the policy to the instrument's absolute price level.
    previous_close = frame.close.shift().replace(0., np.nan)
    candles = pd.DataFrame({
        f'candle_{column}_relative': frame[column]/previous_close-1
        for column in ('open', 'high', 'low', 'close')
    }, index=frame.index)
    if 'volume' in frame:
        candles['candle_log_volume'] = np.log1p(frame.volume.clip(lower=0))
    return pd.concat([candles, indicators, market_context(frame)], axis=1).replace([np.inf, -np.inf], np.nan).astype(np.float32)


def market_context(frame: pd.DataFrame) -> pd.DataFrame:
    """Explicit market state using only completed current and past bars."""
    returns = np.log(frame.close).diff()
    fast = frame.close.ewm(span=20, adjust=False).mean()
    slow = frame.close.ewm(span=100, adjust=False).mean()
    vol = returns.rolling(20).std()
    reference_vol = returns.rolling(100).std().replace(0., np.nan)
    high, low = frame.high.rolling(100).max(), frame.low.rolling(100).min()
    return pd.DataFrame({
        'regime_trend_strength': (fast/slow-1)/(vol*np.sqrt(20)+1e-12),
        'regime_volatility_ratio': vol/reference_vol,
        'regime_range_position': (frame.close-low)/(high-low).replace(0., np.nan),
        'regime_efficiency': frame.close.diff(20).abs()/(frame.close.diff().abs().rolling(20).sum()+1e-12),
    }, index=frame.index)


def regime_breakdown(frame: pd.DataFrame, evaluated: pd.DataFrame, trades: pd.DataFrame) -> list[dict]:
    context = market_context(frame)
    names = pd.Series('Range', index=frame.index)
    names.loc[context.regime_trend_strength > .5] = 'Uptrend'
    names.loc[context.regime_trend_strength < -.5] = 'Downtrend'
    names.loc[context.regime_volatility_ratio > 1.5] = 'High volatility'
    names.loc[context.isna().any(axis=1)] = 'Warming up'
    # Attribute a trade to conditions known at its entry decision, before fill.
    entry_names = []
    if len(trades):
        entry_names = names.iloc[np.maximum(0, frame.index.searchsorted(pd.DatetimeIndex(trades.entry_time))-1)].to_numpy()
    rows = []
    observed = names.shift().reindex(evaluated.index)
    for name in ('Uptrend', 'Downtrend', 'Range', 'High volatility', 'Warming up'):
        selected = trades.loc[np.asarray(entry_names) == name] if len(trades) else trades
        rows.append(dict(name=name, share=float((observed == name).mean()) if len(observed) else 0.,
                         trades=len(selected), netPnl=float(selected.pnl.sum()) if len(selected) else 0.,
                         winRate=float((selected.pnl > 0).mean()*100) if len(selected) else None, allowed=True))
    return rows

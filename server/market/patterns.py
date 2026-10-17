"""Similar-pattern (analog) search and future high/low projection.

The latest ``window`` candles become a shape: the log-close path relative to
its last close, divided by the window's return volatility, so matches compare
shape rather than price level or noise size. Every earlier window whose
following ``horizon`` candles had already finished is a candidate; the
closest shapes (Euclidean distance, reported with correlation) are kept.
Their futures, expressed as returns from the match's last close, give
quantile bands for the next close, highest high and lowest low.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view


def _shape(log_close: np.ndarray) -> np.ndarray:
    """Normalise windows (rows) by their last value and their return volatility."""
    relative = log_close-log_close[..., -1:]
    scale = np.std(np.diff(log_close, axis=-1), axis=-1, keepdims=True)
    return relative/np.where(scale > 1e-12, scale, 1.)


def find_similar(bars: pd.DataFrame, *, window: int = 48, horizon: int = 24, top_k: int = 20,
                 end: pd.Timestamp | None = None, min_gap: int | None = None) -> dict:
    """Most similar past windows to the window ending at ``end`` (default: latest candle)."""
    if not 8 <= window <= 500 or not 1 <= horizon <= 500 or not 1 <= top_k <= 200:
        raise ValueError('Window 8-500, horizon 1-500 and matches 1-200 are required')
    clean = bars.dropna(subset=['open', 'high', 'low', 'close'])
    if end is not None:
        clean = clean.loc[clean.index <= end]
    n = len(clean)
    if n < window+horizon+window:
        raise ValueError('Not enough complete candles for this window and horizon')
    close, high, low = (clean[column].to_numpy(float) for column in ('close', 'high', 'low'))
    log_close = np.log(close)
    query = _shape(log_close[-window:])
    # Candidate windows end at index e (inclusive) and need e+horizon < n-1 so their whole future
    # finished before the query; ``min_gap`` keeps them away from the query itself.
    gap = horizon if min_gap is None else min_gap
    last_end = n-1-max(horizon, gap)
    windows = sliding_window_view(log_close[:last_end+1], window)
    shapes = _shape(windows)
    distance = np.sqrt(((shapes-query)**2).mean(axis=1))
    order = np.argsort(distance)
    chosen, taken = [], np.zeros(len(distance), bool)
    for index in order:  # Skip near-duplicates: one match per stretch of ``window // 2`` candles.
        if taken[max(0, index-window//2):index+window//2+1].any():
            continue
        taken[index] = True
        chosen.append(index)
        if len(chosen) == top_k:
            break
    if not chosen:
        raise ValueError('No comparable past windows')
    current = close[-1]
    matches, future_close, future_high, future_low = [], [], [], []
    for index in chosen:
        e = index+window-1  # last candle of the matched window
        anchor = close[e]
        path_close = close[e+1:e+1+horizon]/anchor-1
        path_high = np.maximum.accumulate(high[e+1:e+1+horizon])/anchor-1
        path_low = np.minimum.accumulate(low[e+1:e+1+horizon])/anchor-1
        future_close.append(path_close)
        future_high.append(path_high)
        future_low.append(path_low)
        shape = shapes[index]
        correlation = float(np.corrcoef(shape, query)[0, 1]) if np.std(shape) > 0 and np.std(query) > 0 else 0.
        matches.append(dict(
            start=int(clean.index[index].timestamp()), end=int(clean.index[e].timestamp()),
            distance=float(distance[index]), correlation=correlation,
            futureClosePct=float(path_close[-1]*100), futureHighPct=float(path_high[-1]*100), futureLowPct=float(path_low[-1]*100),
            # Window and future scaled to today's last close so the UI can overlay them on the current price.
            path=[float(current*np.exp(value-log_close[e])) for value in log_close[index:e+1]],
            future=[float(current*(1+value)) for value in path_close]))
    future_close, future_high, future_low = (np.vstack(values) for values in (future_close, future_high, future_low))
    weights = 1/(np.array([m['distance'] for m in matches])+1e-6)

    def band(values: np.ndarray, q: float) -> list[float]:
        return [float(current*(1+np.quantile(values[:, step], q))) for step in range(values.shape[1])]

    up = float(np.average(future_close[:, -1] > 0, weights=weights))
    step_seconds = int((clean.index[-1]-clean.index[-2]).total_seconds()) if n > 1 else 0
    return dict(
        window=window, horizon=horizon, end=int(clean.index[-1].timestamp()), stepSeconds=step_seconds,
        current=float(current), query=[float(value) for value in close[-window:]],
        matches=matches,
        projection=dict(
            close=dict(p10=band(future_close, .1), p50=band(future_close, .5), p90=band(future_close, .9)),
            high=dict(p50=band(future_high, .5), p90=band(future_high, .9)),
            low=dict(p50=band(future_low, .5), p10=band(future_low, .1))),
        summary=dict(
            probabilityUp=up, expectedClose=float(current*(1+np.average(future_close[:, -1], weights=weights))),
            expectedHigh=float(current*(1+np.median(future_high[:, -1]))), highP90=float(current*(1+np.quantile(future_high[:, -1], .9))),
            expectedLow=float(current*(1+np.median(future_low[:, -1]))), lowP10=float(current*(1+np.quantile(future_low[:, -1], .1))),
            averageCorrelation=float(np.mean([m['correlation'] for m in matches])), candidates=int(len(distance))))

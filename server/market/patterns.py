"""Similar-pattern (analog) search and future high/low projection.

The latest ``window`` candles become a shape: the log-close path relative to
its last close, divided by the window's return volatility, so matches compare
shape rather than price level or noise size. Every earlier window whose
following ``horizon`` candles had already finished is a candidate; the
closest shapes (Euclidean distance, reported with correlation) are kept.
Their futures, expressed as returns from the match's last close, give
quantile bands for the next close, highest high and lowest low.

Optional inputs:

* ``forecast`` - predicted closes for the next candles. They are appended to
  the query, so a match must resemble the recent candles *and* the predicted
  move that followed (actual + forecast); its future starts right after the
  matched window, so the forecast part is compared with what really happened.
* ``news`` / ``news_weight`` - per-candle news features (``news_tone``,
  ``news_volume_z`` from ``server.news.features``). The window's news path is
  compared like the price shape and blended into the distance with the given
  weight, so matches come from moments with similar news flow as well.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view


def _shape(log_close: np.ndarray, anchor: int | None = None) -> np.ndarray:
    """Normalise paths (rows) by the value at ``anchor`` (default: last) and the return volatility up to it."""
    anchor = log_close.shape[-1] if anchor is None else anchor
    relative = log_close-log_close[..., anchor-1:anchor]
    scale = np.std(np.diff(log_close[..., :anchor], axis=-1), axis=-1, keepdims=True)
    return relative/np.where(scale > 1e-12, scale, 1.)


NEWS_COLUMNS = ('news_tone', 'news_volume_z')


def _news_matrix(news: pd.DataFrame) -> np.ndarray:
    """(candles, 2): tone scaled to about +/-1 per 3 tone points and volume z, clipped; missing news is neutral (0)."""
    tone = (news['news_tone']/3).clip(-3, 3)
    volume = news['news_volume_z'].clip(-3, 3)
    return np.column_stack([tone.to_numpy(float), volume.to_numpy(float)])


def _news_summary(rows: np.ndarray) -> dict:
    tone, volume = rows[:, 0]*3, rows[:, 1]
    mean = lambda values: None if np.isnan(values).all() else float(np.nanmean(values))  # noqa: E731
    return dict(tone=mean(tone), volumeZ=mean(volume), coverage=float((~np.isnan(rows).any(axis=1)).mean()))


def find_similar(bars: pd.DataFrame, *, window: int = 48, horizon: int = 24, top_k: int = 20,
                 end: pd.Timestamp | None = None, min_gap: int | None = None, forecast: list[float] | None = None,
                 news: pd.DataFrame | None = None, news_weight: float = 0.) -> dict:
    """Most similar past windows to the window ending at ``end`` (default: latest candle)."""
    if not 8 <= window <= 500 or not 1 <= horizon <= 500 or not 1 <= top_k <= 200:
        raise ValueError('Window 8-500, horizon 1-500 and matches 1-200 are required')
    forecast = [float(value) for value in forecast or []]
    steps = len(forecast)
    if steps > horizon:
        raise ValueError('The forecast cannot be longer than the horizon')
    if any(not np.isfinite(value) or value <= 0 for value in forecast):
        raise ValueError('Forecast prices must be positive numbers')
    if not 0 <= news_weight <= 1:
        raise ValueError('News weight must be between 0 and 1')
    if news_weight > 0 and news is None:
        raise ValueError('News features are required for a news weight')
    clean = bars.dropna(subset=['open', 'high', 'low', 'close'])
    if end is not None:
        clean = clean.loc[clean.index <= end]
    n = len(clean)
    if n < window+horizon+window:
        raise ValueError('Not enough complete candles for this window and horizon')
    close, high, low = (clean[column].to_numpy(float) for column in ('close', 'high', 'low'))
    log_close = np.log(close)
    query = _shape(np.concatenate([log_close[-window:], np.log(forecast)]), window)
    # Candidate windows end at index e (inclusive) and need e+horizon < n-1 so their whole future
    # finished before the query; ``min_gap`` keeps them away from the query itself.
    gap = horizon if min_gap is None else min_gap
    last_end = n-1-max(horizon, gap)
    count = last_end-window+2
    if count < 1:
        raise ValueError('Not enough complete candles for this window and horizon')
    # Each candidate covers its window plus the candles matching the forecast steps (all finished).
    windows = sliding_window_view(log_close[:last_end+1+steps], window+steps)[:count]
    shapes = _shape(windows, window)
    price_distance = np.sqrt(((shapes-query)**2).mean(axis=1))
    distance = price_distance
    news_rows = news_distance = None
    if news is not None:
        news_rows = _news_matrix(news.reindex(clean.index))
    if news_rows is not None and news_weight > 0:
        filled = np.nan_to_num(news_rows)
        candidates = sliding_window_view(filled[:last_end+1], window, axis=0)[:count]
        news_distance = np.sqrt(((candidates-filled[-window:].T[None])**2).mean(axis=(1, 2)))
        distance = np.sqrt((1-news_weight)*price_distance**2+news_weight*news_distance**2)
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
            distance=float(distance[index]), correlation=correlation, priceDistance=float(price_distance[index]),
            newsDistance=None if news_distance is None else float(news_distance[index]),
            news=None if news_rows is None else _news_summary(news_rows[index:e+1]),
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
        forecast=forecast, newsWeight=float(news_weight),
        queryNews=None if news_rows is None else _news_summary(news_rows[-window:]),
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

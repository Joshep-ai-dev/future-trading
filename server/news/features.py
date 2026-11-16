"""Causal per-candle news features.

For a candle opening at ``t`` (closing at ``t + bar_seconds``) only news known
by the close is used: a GDELT 15-minute bucket counts once it has ended, an
article once it was published. Columns:

* ``news_volume`` - GDELT silver articles in the trailing 6 hours.
* ``news_volume_z`` - log volume vs. its own trailing 7-day mean / std
  (how unusual the news flow is right now).
* ``news_tone`` - GDELT volume-weighted average tone over 6 hours
  (roughly -10..+10; NaN without articles).
* ``headline_sentiment`` / ``headline_count`` - mean silver-POV sentiment and
  count of stored headlines in the trailing 24 hours (NaN without headlines;
  headlines exist only from when collection started).
* ``macro_surprise`` - sum of silver-biased surprise z-scores of US releases
  (CPI, PPI, NFP, ...) in the trailing 24 hours; a release counts from its
  release time. Releases at the same moment (CPI m/m, y/y, core) are averaged
  into one value. 0 when nothing was released.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from server.news.calendar import enrich, surprise_scales
from server.news.store import NewsStore

BUCKET_SECONDS = 900
TONE_HOURS = 6
HEADLINE_HOURS = 24


def _trailing(times: np.ndarray, values: np.ndarray, at: np.ndarray, span: int) -> np.ndarray:
    """Sum of ``values`` whose time is in (at - span, at] for each ``at`` (times sorted)."""
    total = np.concatenate([[0.], np.cumsum(values)])
    right = np.searchsorted(times, at, side='right')
    left = np.searchsorted(times, at-span, side='right')
    return total[right]-total[left]


def release_surprises(events: list[dict]) -> list[tuple[int, float]]:
    """(release time, mean silver bias) per release moment, from stored calendar events."""
    by_time: dict[int, list[float]] = {}
    for row in enrich(events, surprise_scales(events), None):
        if row['silverBias'] is not None:
            by_time.setdefault(row['released'], []).append(row['silverBias'])
    return sorted((time, float(np.mean(values))) for time, values in by_time.items())


def news_features(index: pd.DatetimeIndex, bar_seconds: int, store: NewsStore | None = None,
                  timeline: list[dict] | None = None, articles: list[tuple[int, float]] | None = None,
                  releases: list[tuple[int, float]] | None = None) -> pd.DataFrame:
    """News features for candles opening at ``index`` (UTC)."""
    closes = (index.asi8//10**9).astype(np.int64)+int(bar_seconds)
    if timeline is None or articles is None or releases is None:
        store = store or NewsStore()
        start = int(closes[0])-8*86400 if len(closes) else None
        timeline = store.timeline(since=start) if timeline is None else timeline
        articles = store.article_times(since=start) if articles is None else articles
        releases = release_surprises(store.events()) if releases is None else releases
    frame = pd.DataFrame(index=index)
    if timeline:
        known = np.array([row['bucket'] for row in timeline], dtype=np.int64)+BUCKET_SECONDS
        volume = np.array([row['volume'] or 0. for row in timeline], dtype=float)
        tone = np.array([row['tone'] if row['tone'] is not None else 0. for row in timeline], dtype=float)
        span = TONE_HOURS*3600
        count = _trailing(known, volume, closes, span)
        weighted = _trailing(known, volume*tone, closes, span)
        frame['news_volume'] = count
        frame['news_tone'] = np.where(count > 0, weighted/np.where(count > 0, count, 1), np.nan)
        covered = closes >= known[0]  # before the first bucket the volume is unknown, not zero
        frame.loc[~covered, ['news_volume', 'news_tone']] = np.nan
        log_volume = np.log1p(frame['news_volume'])
        baseline = log_volume.rolling('7D', min_periods=max(4, int(86400/bar_seconds))).agg(['mean', 'std'])
        frame['news_volume_z'] = (log_volume-baseline['mean'])/baseline['std'].where(baseline['std'] > 1e-9)
    else:
        frame[['news_volume', 'news_tone', 'news_volume_z']] = np.nan
    if articles:
        published = np.array([time for time, _ in articles], dtype=np.int64)
        score = np.array([value for _, value in articles], dtype=float)
        span = HEADLINE_HOURS*3600
        count = _trailing(published, np.ones_like(score), closes, span)
        frame['headline_count'] = count
        frame['headline_sentiment'] = np.where(count > 0, _trailing(published, score, closes, span)/np.where(count > 0, count, 1), np.nan)
    else:
        frame['headline_count'] = 0.
        frame['headline_sentiment'] = np.nan
    if releases:
        released = np.array([time for time, _ in releases], dtype=np.int64)
        frame['macro_surprise'] = _trailing(released, np.array([bias for _, bias in releases], dtype=float), closes, 86400)
    else:
        frame['macro_surprise'] = 0.
    return frame

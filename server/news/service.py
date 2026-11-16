"""Background news collection (started from the app lifespan; ``SILVER_NEWS=0`` disables).

Every cycle reads the RSS feeds and the GDELT article list, then extends the
GDELT volume/tone timeline. The timeline is backfilled from the first market
candle in 2-day chunks (GDELT returns 15-minute buckets for short spans), at
most ``BACKFILL_CHUNKS`` per cycle so new headlines never wait long.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from pathlib import Path

from server.news.sources import RSS_FEEDS, GdeltClient, GdeltRateLimited, fetch_rss
from server.news.store import NewsStore

logger = logging.getLogger(__name__)
CYCLE_SECONDS = 600
CHUNK_SECONDS = 2*86400
BACKFILL_CHUNKS = 12
BUCKET_SECONDS = 900
MARKET_CSV = Path(__file__).resolve().parents[2] / 'data' / 'OKX_XAG-USDT-SWAP_1m.csv'


def history_start(default: int = 1767225600) -> int:
    """Day of the first market candle (UTC seconds) across the backfilled history and the source file."""
    import pandas as pd
    starts = []
    for path in (MARKET_CSV.with_name('OKX_XAG-USDT-SWAP_1m_history.csv'), MARKET_CSV):
        try:
            starts.append(int(pd.read_csv(path, usecols=['timestamp_ms'])['timestamp_ms'].min())//1000)
        except (OSError, ValueError, KeyError):
            continue
    return min(starts)//86400*86400 if starts else default


class NewsService:
    def __init__(self, store: NewsStore | None = None, gdelt: GdeltClient | None = None, feeds=RSS_FEEDS):
        self._store = store
        self.gdelt = gdelt or GdeltClient()
        self.feeds = feeds
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None
        self.lock = threading.Lock()
        self.state = dict(lastRun=None, lastNew=0, errors={}, backfilling=False)
        self.retry_at = 0.  # monotonic time before which GDELT timeline calls wait (after a rate limit)
        self.backoff = 0.

    @property
    def store(self) -> NewsStore:
        if self._store is None:
            self._store = NewsStore()
        return self._store

    def collect_articles(self) -> int:
        """One pass over RSS feeds and the GDELT article list. Returns the number of new articles."""
        added, errors = 0, {}
        for provider, source, url in self.feeds:
            try:
                added += self.store.add_articles(fetch_rss(provider, source, url))
            except Exception as error:  # One broken feed must not stop the others.
                errors[provider] = str(error)[:200]
        try:
            added += self.store.add_articles(self.gdelt.articles())
        except Exception as error:
            errors['gdelt'] = str(error)[:200]
        with self.lock:
            self.state.update(lastRun=int(time.time()), lastNew=added,
                              errors={**{k: v for k, v in self.state['errors'].items() if k == 'timeline'}, **errors})
        return added

    def extend_timeline(self, now: int | None = None, max_chunks: int = BACKFILL_CHUNKS) -> bool:
        """Fetch the next timeline chunks. Returns True while older history is still missing."""
        now = int(now or time.time())
        latest = now//BUCKET_SECONDS*BUCKET_SECONDS-BUCKET_SECONDS  # last finished bucket
        cursor = int(self.store.get_meta('timeline_until') or history_start())
        if time.monotonic() < self.retry_at:
            return latest-cursor > 12*3600
        for _ in range(max_chunks):
            if cursor >= latest:
                break
            end = min(cursor+CHUNK_SECONDS, latest)
            try:
                rows = self.gdelt.timeline(cursor, end)
            except GdeltRateLimited:
                # Back off 1, 2, 4 ... 15 minutes so a throttled address recovers instead of being re-penalised.
                self.backoff = min(900., max(60., self.backoff*2))
                self.retry_at = time.monotonic()+self.backoff
                with self.lock:
                    self.state['errors']['timeline'] = f'GDELT rate limit, retrying in {int(self.backoff//60)} min'
                break
            except Exception as error:
                with self.lock:
                    self.state['errors']['timeline'] = str(error)[:200]
                break
            self.backoff = 0.
            self.store.add_timeline([row for row in rows if row[0] < end], int(time.time()))
            # Re-read the last few hours next time: GDELT keeps adding late-indexed articles.
            cursor = end if end < latest else max(end-6*3600, cursor)
            self.store.set_meta('timeline_until', str(cursor))
            with self.lock:
                self.state['errors'].pop('timeline', None)
            if end >= latest:
                break
        behind = latest-cursor > 12*3600
        with self.lock:
            self.state['backfilling'] = behind
        return behind

    def _run(self):
        while not self.stop_event.is_set():
            try:
                self.collect_articles()
                behind = self.extend_timeline()
            except Exception:
                logger.exception('News collection failed')
                behind = False
            self.stop_event.wait(60 if behind else CYCLE_SECONDS)

    def start(self):
        if os.environ.get('SILVER_NEWS', '1') == '0' or (self.thread and self.thread.is_alive()):
            return
        self.stop_event.clear()
        self.thread = threading.Thread(target=self._run, name='news-collector', daemon=True)
        self.thread.start()

    def shutdown(self):
        self.stop_event.set()

    def status(self) -> dict:
        with self.lock:
            state = {**self.state, 'errors': dict(self.state['errors'])}
        return dict(running=bool(self.thread and self.thread.is_alive()), enabled=os.environ.get('SILVER_NEWS', '1') != '0',
                    sources=[dict(id=provider, name=name) for provider, name, _ in self.feeds] + [dict(id='gdelt', name='GDELT')],
                    **state, **self.store.counts())


news_service = NewsService()

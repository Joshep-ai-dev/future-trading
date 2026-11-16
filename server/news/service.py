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

from server.news.calendar import CALENDAR_START, EVENTS, fetch_calendar
from server.news.sources import RSS_FEEDS, GdeltClient, GdeltRateLimited, fetch_rss
from server.news.store import NewsStore

logger = logging.getLogger(__name__)
CYCLE_SECONDS = 600
CHUNK_SECONDS = 2*86400
BACKFILL_CHUNKS = 8
HISTORY_DAYS = 365  # news history kept even before the first market candle
HEADLINE_DAYS_PER_CYCLE = 12
HEADLINES_PER_DAY = 75
WATCH_SECONDS = 15        # how often the release watcher looks at the calendar
WATCH_WINDOW = 15*60      # keep polling a release this long for its actual value
HEADLINES_AFTER_RELEASE = 4*60  # one extra headline pass this long after a release
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
    def __init__(self, store: NewsStore | None = None, gdelt: GdeltClient | None = None, feeds=RSS_FEEDS,
                 calendar=fetch_calendar):
        self._store = store
        self.gdelt = gdelt or GdeltClient()
        self.feeds = feeds
        self.calendar = calendar
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None
        self.watcher: threading.Thread | None = None
        self.headline_pass_done: set[int] = set()
        self.lock = threading.Lock()
        # errors: real failures. waiting: normal pauses (GDELT rate limit backoff).
        self.state = dict(lastRun=None, lastNew=0, errors={}, waiting={}, watching=[], backfilling=False)
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
        except GdeltRateLimited:
            with self.lock:
                self.state['waiting']['gdelt'] = 'GDELT pause, retrying next cycle'
        except Exception as error:
            errors['gdelt'] = str(error)[:200]
        with self.lock:
            self.state.update(lastRun=int(time.time()), lastNew=added,
                              errors={**{k: v for k, v in self.state['errors'].items() if k in ('timeline', 'calendar', 'headlines')}, **errors})
        return added

    def collect_calendar(self, now: int | None = None) -> int:
        """Backfill the economic calendar in 180-day chunks, then keep refreshing the last 10 and next 30 days."""
        now = int(now or time.time())
        cursor = int(self.store.get_meta('calendar_until') or CALENDAR_START)
        stored = 0
        try:
            # Stop a day short of the refresh window; the refresh below reaches back to the cursor,
            # so no tiny (and empty, 404) ranges are requested every cycle.
            while cursor < now-11*86400:
                end = min(cursor+180*86400, now-10*86400)
                rows = self.calendar(cursor, end)
                self.store.upsert_events(rows)
                stored += len(rows)
                cursor = end
                self.store.set_meta('calendar_until', str(cursor))
            rows = self.calendar(min(cursor, now-10*86400), now+30*86400)  # actuals arrive, forecasts get set or revised
            self.store.upsert_events(rows)
            stored += len(rows)
            with self.lock:
                self.state['errors'].pop('calendar', None)
        except Exception as error:
            with self.lock:
                self.state['errors']['calendar'] = str(error)[:200]
        return stored

    def extend_timeline(self, now: int | None = None, max_chunks: int = BACKFILL_CHUNKS) -> bool:
        """Fetch the next timeline chunks. Returns True while older history is still missing."""
        now = int(now or time.time())
        latest = now//BUCKET_SECONDS*BUCKET_SECONDS-BUCKET_SECONDS  # last finished bucket
        cursor = int(self.store.get_meta('timeline_until') or min(history_start(), (now-HISTORY_DAYS*86400)//86400*86400))
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
                    self.state['errors'].pop('timeline', None)
                    self.state['waiting']['gdelt'] = f'GDELT pause, retrying in {max(1, int(self.backoff//60))} min'
                break
            except Exception as error:
                with self.lock:
                    self.state['errors']['timeline'] = str(error)[:200]
                break
            self.backoff = 0.
            with self.lock:
                self.state['waiting'].pop('gdelt', None)
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

    def backfill_headlines(self, now: int | None = None, max_days: int = HEADLINE_DAYS_PER_CYCLE) -> bool:
        """GDELT headlines day by day, newest day first, back to HISTORY_DAYS. Returns True while days remain."""
        now = int(now or time.time())
        oldest = (now-HISTORY_DAYS*86400)//86400*86400
        cursor = int(self.store.get_meta('headlines_back_until') or now//86400*86400)  # days before this are pending
        for _ in range(max_days):
            if cursor <= oldest or time.monotonic() < self.retry_at:
                break
            try:
                rows = self.gdelt.articles(limit=HEADLINES_PER_DAY, start=cursor-86400, end=cursor)
            except GdeltRateLimited:
                self.backoff = min(900., max(60., self.backoff*2))
                self.retry_at = time.monotonic()+self.backoff
                with self.lock:
                    self.state['errors'].pop('headlines', None)
                    self.state['waiting']['gdelt'] = f'GDELT pause, retrying in {max(1, int(self.backoff//60))} min'
                break
            except Exception as error:
                with self.lock:
                    self.state['errors']['headlines'] = str(error)[:200]
                break
            self.backoff = 0.
            with self.lock:
                self.state['waiting'].pop('gdelt', None)
            self.store.add_articles(rows)
            cursor -= 86400
            self.store.set_meta('headlines_back_until', str(cursor))
            with self.lock:
                self.state['errors'].pop('headlines', None)
        return cursor > oldest

    def due_releases(self, now: int | None = None) -> list[dict]:
        """Numeric releases scheduled within the watch window that have no actual value yet."""
        now = int(now or time.time())
        rows = self.store.events(since=now-WATCH_WINDOW, until=now+1)
        return [row for row in rows if row['actual'] is None and EVENTS.get(row['name'], ('', 0, False))[1] != 0]

    def watch_once(self, now: int | None = None) -> dict:
        """One watcher step: re-read the calendar while a release is due, then one headline pass after it."""
        now = int(now or time.time())
        due = self.due_releases(now)
        refreshed = False
        if due:
            try:
                self.store.upsert_events(self.calendar(now-86400, now+86400))
                refreshed = True
                with self.lock:
                    self.state['errors'].pop('calendar', None)
            except Exception as error:
                with self.lock:
                    self.state['errors']['calendar'] = str(error)[:200]
        # A few minutes after a release, fetch headlines once so the first reactions appear quickly.
        recent = {row['released'] for row in self.store.events(since=now-HEADLINES_AFTER_RELEASE-120, until=now-HEADLINES_AFTER_RELEASE+1)
                  if EVENTS.get(row['name'], ('', 0, False))[2]}
        for released in sorted(recent-self.headline_pass_done):
            self.headline_pass_done.add(released)
            self.collect_articles()
        with self.lock:
            self.state['watching'] = sorted({row['name'] for row in self.due_releases(now)})
        return dict(due=len(due), refreshed=refreshed)

    def _watch(self):
        while not self.stop_event.wait(WATCH_SECONDS):
            try:
                self.watch_once()
            except Exception:
                logger.exception('Release watcher failed')

    def _run(self):
        while not self.stop_event.is_set():
            try:
                self.collect_articles()
                self.collect_calendar()
                behind = self.extend_timeline()
                behind = self.backfill_headlines() or behind
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
        self.watcher = threading.Thread(target=self._watch, name='news-release-watcher', daemon=True)
        self.watcher.start()

    def shutdown(self):
        self.stop_event.set()

    def status(self) -> dict:
        with self.lock:
            state = {**self.state, 'errors': dict(self.state['errors']), 'waiting': dict(self.state['waiting']),
                     'watching': list(self.state['watching'])}
        back = self.store.get_meta('headlines_back_until')
        state['headlinesFrom'] = int(back) if back else None
        return dict(running=bool(self.thread and self.thread.is_alive()), enabled=os.environ.get('SILVER_NEWS', '1') != '0',
                    sources=[dict(id=provider, name=name) for provider, name, _ in self.feeds] + [dict(id='gdelt', name='GDELT'), dict(id='calendar', name='FXStreet calendar')],
                    **state, **self.store.counts())


news_service = NewsService()

"""SQLite store for news articles and the GDELT volume/tone timeline."""
from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path(__file__).resolve().parents[2] / 'data' / 'news' / 'news.sqlite'

SCHEMA = (
    '''CREATE TABLE IF NOT EXISTS articles (
        id TEXT PRIMARY KEY, published INTEGER NOT NULL, fetched INTEGER NOT NULL, provider TEXT NOT NULL,
        source TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
        sentiment REAL NOT NULL DEFAULT 0, relevance REAL NOT NULL DEFAULT 0, topics TEXT NOT NULL DEFAULT '')''',
    'CREATE INDEX IF NOT EXISTS articles_published ON articles (published)',
    '''CREATE TABLE IF NOT EXISTS tone_timeline (
        bucket INTEGER PRIMARY KEY, volume REAL, tone REAL, fetched INTEGER NOT NULL)''',
    'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
)
ARTICLE_COLUMNS = ('id', 'published', 'fetched', 'provider', 'source', 'title', 'url', 'summary',
                   'sentiment', 'relevance', 'topics')


class NewsStore:
    def __init__(self, path: Path | str = DB_PATH):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            for statement in SCHEMA:
                connection.execute(statement)

    @contextmanager
    def _connect(self):
        """One connection per call: commit on success, roll back on error, always close."""
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def add_articles(self, rows: list[dict]) -> int:
        """Insert new articles; an article already stored (same id) is kept as first seen. Returns the new count."""
        if not rows:
            return 0
        with self.lock, self._connect() as connection:
            before = connection.total_changes
            connection.executemany(
                f'INSERT OR IGNORE INTO articles ({",".join(ARTICLE_COLUMNS)}) VALUES ({",".join("?" * len(ARTICLE_COLUMNS))})',
                [tuple(row[column] for column in ARTICLE_COLUMNS) for row in rows])
            return connection.total_changes-before

    def articles(self, *, query: str = '', topic: str = '', sentiment: str = '', since: int | None = None,
                 until: int | None = None, limit: int = 50, offset: int = 0) -> tuple[list[dict], int]:
        where, params = ['1=1'], []
        if query:
            where.append('(title LIKE ? OR summary LIKE ? OR source LIKE ?)')
            params += [f'%{query}%'] * 3
        if topic:
            where.append("(',' || topics || ',') LIKE ?")
            params.append(f'%,{topic},%')
        if sentiment == 'positive':
            where.append('sentiment > 0.15')
        elif sentiment == 'negative':
            where.append('sentiment < -0.15')
        elif sentiment == 'neutral':
            where.append('sentiment BETWEEN -0.15 AND 0.15')
        if since is not None:
            where.append('published >= ?')
            params.append(since)
        if until is not None:
            where.append('published < ?')
            params.append(until)
        clause = ' AND '.join(where)
        with self._connect() as connection:
            total = connection.execute(f'SELECT COUNT(*) FROM articles WHERE {clause}', params).fetchone()[0]
            rows = connection.execute(f'SELECT * FROM articles WHERE {clause} ORDER BY published DESC LIMIT ? OFFSET ?',
                                      [*params, limit, offset]).fetchall()
        return [dict(row) for row in rows], int(total)

    def add_timeline(self, rows: list[tuple[int, float | None, float | None]], fetched: int) -> None:
        """Upsert (bucket, volume, tone) rows; a value that is None keeps the stored one."""
        if not rows:
            return
        with self.lock, self._connect() as connection:
            connection.executemany(
                '''INSERT INTO tone_timeline (bucket, volume, tone, fetched) VALUES (?, ?, ?, ?)
                   ON CONFLICT(bucket) DO UPDATE SET volume=COALESCE(excluded.volume, volume),
                   tone=COALESCE(excluded.tone, tone), fetched=excluded.fetched''',
                [(bucket, volume, tone, fetched) for bucket, volume, tone in rows])

    def timeline(self, since: int | None = None, until: int | None = None) -> list[dict]:
        where, params = ['1=1'], []
        if since is not None:
            where.append('bucket >= ?')
            params.append(since)
        if until is not None:
            where.append('bucket < ?')
            params.append(until)
        with self._connect() as connection:
            rows = connection.execute(f'SELECT bucket, volume, tone FROM tone_timeline WHERE {" AND ".join(where)} ORDER BY bucket',
                                      params).fetchall()
        return [dict(row) for row in rows]

    def article_times(self, since: int | None = None) -> list[tuple[int, float]]:
        """(published, sentiment) of every article, oldest first, for feature building."""
        with self._connect() as connection:
            rows = connection.execute('SELECT published, sentiment FROM articles WHERE published >= ? ORDER BY published',
                                      (since or 0,)).fetchall()
        return [(int(row[0]), float(row[1])) for row in rows]

    def get_meta(self, key: str) -> str | None:
        with self._connect() as connection:
            row = connection.execute('SELECT value FROM meta WHERE key=?', (key,)).fetchone()
        return None if row is None else str(row[0])

    def set_meta(self, key: str, value: str) -> None:
        with self.lock, self._connect() as connection:
            connection.execute('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                               (key, value))

    def counts(self) -> dict:
        with self._connect() as connection:
            articles, newest = connection.execute('SELECT COUNT(*), MAX(published) FROM articles').fetchone()
            buckets, first, last = connection.execute('SELECT COUNT(*), MIN(bucket), MAX(bucket) FROM tone_timeline').fetchone()
        return dict(articles=int(articles), newestArticle=newest, timelineBuckets=int(buckets),
                    timelineStart=first, timelineEnd=last)

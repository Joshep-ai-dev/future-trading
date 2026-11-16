"""News sources: public RSS feeds and the GDELT 2.0 DOC API (no API keys).

Every fetcher returns plain dicts; nothing here touches the store.
GDELT allows one request every 5 seconds, so ``GdeltClient`` spaces calls.
"""
from __future__ import annotations

import hashlib
import html
import json
import re
import time
import urllib.parse
import urllib.error
import urllib.request
import xml.etree.ElementTree as ElementTree
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

from server.news.sentiment import relevance, score_text, topics_for

USER_AGENT = 'Mozilla/5.0 (compatible; SilverTerminal/1.0; news reader)'
# (provider id, display name, URL). General feeds are filtered to silver, gold and macro-driver headlines.
RSS_FEEDS = (
    ('fxstreet', 'FXStreet', 'https://www.fxstreet.com/rss/news'),
    ('fxempire', 'FX Empire', 'https://www.fxempire.com/api/v1/en/articles/rss/news'),
    ('investing', 'Investing.com', 'https://www.investing.com/rss/news_11.rss'),
    ('mining', 'MINING.COM', 'https://www.mining.com/feed/'),
)
MIN_RELEVANCE = .4
MAX_FEED_AGE = 14*86400  # Feeds also carry old evergreen pieces; history comes from GDELT instead.
GDELT_URL = 'https://api.gdeltproject.org/api/v2/doc/doc'
GDELT_QUERY = '("silver price" OR "silver prices" OR "silver futures" OR "spot silver" OR "silver rally") sourcelang:english'
_TAGS = re.compile(r'<[^>]+>')


def _get(url: str, timeout: float = 20) -> bytes:
    request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, 'Accept': '*/*'})
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - fixed https URLs
        return response.read()


def article_id(url: str) -> str:
    """Stable id from the URL without query string or fragment (tracking parameters differ per feed)."""
    parts = urllib.parse.urlsplit(url.strip())
    return hashlib.sha1(f'{parts.netloc.lower()}{parts.path.rstrip("/")}'.encode()).hexdigest()


def clean_text(value: str | None, limit: int = 600) -> str:
    text = html.unescape(_TAGS.sub(' ', value or ''))
    return re.sub(r'\s+', ' ', text).strip()[:limit]


def make_article(*, provider: str, source: str, title: str, url: str, published: int, summary: str = '',
                 fetched: int | None = None) -> dict:
    """Sentiment and relevance come from the headline (summaries often wander); topics use both."""
    return dict(id=article_id(url), published=int(published), fetched=int(fetched or time.time()), provider=provider,
                source=source, title=title, url=url, summary=summary, sentiment=round(score_text(title), 4),
                relevance=relevance(title), topics=','.join(topics_for(f'{title}. {summary}')))


def _child(item: ElementTree.Element, *names: str) -> str:
    for name in names:
        found = item.find(name)
        if found is not None:
            return (found.text or found.get('href') or '').strip()
    return ''


def parse_feed(data: bytes, provider: str, source: str, *, now: int | None = None) -> list[dict]:
    """RSS 2.0 or Atom items -> articles relevant to silver (title, link, date, summary)."""
    root = ElementTree.fromstring(data)
    atom = '{http://www.w3.org/2005/Atom}'
    items = root.findall('.//item') or root.findall(f'.//{atom}entry')
    now = int(now or time.time())
    articles = []
    for item in items:
        title = clean_text(_child(item, 'title', f'{atom}title'), 300)
        url = _child(item, 'link', f'{atom}link')
        stamp = _child(item, 'pubDate', f'{atom}published', f'{atom}updated', '{http://purl.org/dc/elements/1.1/}date')
        if not title or not url.startswith('http'):
            continue
        try:
            moment = parsedate_to_datetime(stamp) if stamp and not stamp[:4].isdigit() else datetime.fromisoformat(stamp.replace('Z', '+00:00'))
            published = int(moment.timestamp())
        except (TypeError, ValueError):
            published = now
        summary = clean_text(_child(item, 'description', f'{atom}summary', f'{atom}content'))
        article = make_article(provider=provider, source=source, title=title, url=url,
                               published=min(published, now), summary=summary, fetched=now)
        if article['relevance'] >= MIN_RELEVANCE and article['published'] >= now-MAX_FEED_AGE:
            articles.append(article)
    return articles


def fetch_rss(provider: str, source: str, url: str) -> list[dict]:
    return parse_feed(_get(url), provider, source)


def gdelt_stamp(moment: datetime | int) -> str:
    if isinstance(moment, int):
        moment = datetime.fromtimestamp(moment, timezone.utc)
    return moment.strftime('%Y%m%d%H%M%S')


def parse_gdelt_date(value: str) -> int:
    return int(datetime.strptime(value, '%Y%m%dT%H%M%SZ').replace(tzinfo=timezone.utc).timestamp())


class GdeltRateLimited(RuntimeError):
    pass


class GdeltClient:
    """Spaced GDELT DOC API calls: article list and 15-minute volume / tone timelines."""

    def __init__(self, spacing: float = 10., opener=_get):
        self.spacing = spacing
        self.opener = opener
        self.last_call = 0.

    def _call(self, **params) -> dict:
        wait = self.spacing-(time.monotonic()-self.last_call)
        if wait > 0:
            time.sleep(wait)
        self.last_call = time.monotonic()
        try:
            body = self.opener(f'{GDELT_URL}?{urllib.parse.urlencode({"query": GDELT_QUERY, "format": "json", **params})}', 60)
        except urllib.error.HTTPError as error:
            if error.code == 429:
                raise GdeltRateLimited('GDELT rate limit') from error
            raise
        text = body.decode('utf-8', 'replace').strip()
        if not text.startswith('{'):
            if 'limit requests' in text.lower():
                raise GdeltRateLimited('GDELT rate limit')
            raise ValueError(f'Unexpected GDELT response: {text[:120]}')
        return json.loads(text) if text else {}

    def articles(self, timespan: str = '1d', limit: int = 75, start: int | None = None, end: int | None = None) -> list[dict]:
        """Latest articles, or the most relevant ones between ``start`` and ``end`` (GDELT keeps over a year)."""
        if start is not None and end is not None:
            data = self._call(mode='artlist', maxrecords=limit, sort='hybridrel',
                              startdatetime=gdelt_stamp(start), enddatetime=gdelt_stamp(end))
        else:
            data = self._call(mode='artlist', maxrecords=limit, sort='datedesc', timespan=timespan)
        now = int(time.time())
        rows = []
        for item in data.get('articles', []):
            url, title = item.get('url', ''), clean_text(item.get('title'), 300)
            if not url.startswith('http') or not title:
                continue
            try:
                published = parse_gdelt_date(item.get('seendate', ''))
            except ValueError:
                published = now
            rows.append(make_article(provider='gdelt', source=item.get('domain') or 'GDELT', title=title, url=url,
                                     published=min(published, now), fetched=now))
        return rows

    def timeline(self, start: int, end: int) -> list[tuple[int, float | None, float | None]]:
        """(bucket start, article count, average tone) per GDELT bucket between ``start`` and ``end``."""
        span = dict(startdatetime=gdelt_stamp(start), enddatetime=gdelt_stamp(end))
        volume = _series(self._call(mode='timelinevolraw', **span))
        tone = _series(self._call(mode='timelinetone', **span))
        buckets = sorted(set(volume) | set(tone))
        return [(bucket, volume.get(bucket), tone.get(bucket)) for bucket in buckets]


def _series(data: dict) -> dict[int, float]:
    timeline = data.get('timeline') or []
    if not timeline:
        return {}
    values = {}
    for point in timeline[0].get('data', []):
        try:
            values[parse_gdelt_date(point['date'])] = float(point['value'])
        except (KeyError, TypeError, ValueError):
            continue
    return values

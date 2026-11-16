"""News API: browse headlines, news timeline, news-flow outlook, collector status and refresh.

Mounted by ``server.app``; the auth middleware covers every ``/api/news`` path
and ``POST /api/news/refresh`` is in ``TRADER_PATHS``.
"""
from __future__ import annotations

import time
from collections import Counter
from typing import Literal

import numpy as np
from fastapi import APIRouter, HTTPException, Query

from server.news.sentiment import TOPIC_NAMES
from server.news.service import news_service

router = APIRouter(prefix='/api/news')
RESOLUTIONS = {'15m': 900, '1h': 3600, '4h': 14400, '1d': 86400}


@router.get('')
def list_news(q: str = Query('', max_length=80), topic: str = Query('', max_length=20),
              sentiment: Literal['', 'positive', 'negative', 'neutral'] = '', since: int | None = Query(None, ge=0),
              until: int | None = Query(None, ge=0), limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0)):
    if topic and topic not in TOPIC_NAMES:
        raise HTTPException(status_code=400, detail=f'Unknown topic. Use one of: {", ".join(TOPIC_NAMES)}')
    rows, total = news_service.store.articles(query=q.strip(), topic=topic, sentiment=sentiment, since=since,
                                              until=until, limit=limit, offset=offset)
    return dict(total=total, articles=[_article(row) for row in rows], topics=list(TOPIC_NAMES))


def _article(row: dict) -> dict:
    return dict(id=row['id'], published=row['published'], provider=row['provider'], source=row['source'],
                title=row['title'], url=row['url'], summary=row['summary'], sentiment=row['sentiment'],
                relevance=row['relevance'], topics=[topic for topic in row['topics'].split(',') if topic])


@router.get('/timeline')
def news_timeline(hours: int = Query(168, ge=6, le=24*400), resolution: Literal['15m', '1h', '4h', '1d'] = '1h'):
    """GDELT volume / tone and stored-headline sentiment per bucket (bucket start, UTC seconds)."""
    step = RESOLUTIONS[resolution]
    now = int(time.time())
    start = (now-hours*3600)//step*step
    buckets: dict[int, dict] = {}

    def bucket(at: int) -> dict:
        key = at//step*step
        return buckets.setdefault(key, dict(time=key, volume=0., toneSum=0., headlines=0, sentimentSum=0.))

    for row in news_service.store.timeline(since=start):
        item = bucket(row['bucket'])
        volume = row['volume'] or 0.
        item['volume'] += volume
        item['toneSum'] += volume*(row['tone'] or 0.)
    articles, _ = news_service.store.articles(since=start, limit=100000)
    for row in articles:
        item = bucket(row['published'])
        item['headlines'] += 1
        item['sentimentSum'] += row['sentiment']
    rows = []
    for key in range(start, now//step*step+step, step):
        item = buckets.get(key, dict(time=key, volume=0., toneSum=0., headlines=0, sentimentSum=0.))
        rows.append(dict(time=key, volume=item['volume'], tone=item['toneSum']/item['volume'] if item['volume'] else None,
                         headlines=item['headlines'],
                         sentiment=item['sentimentSum']/item['headlines'] if item['headlines'] else None))
    return dict(resolution=resolution, buckets=rows)


@router.get('/outlook')
def news_outlook():
    """How the last 24 hours of news compare with the week before (a description of news flow, not a forecast)."""
    now = int(time.time())
    day, week = now-86400, now-8*86400
    recent, _ = news_service.store.articles(since=day, limit=2000)
    weights = np.array([row['relevance'] for row in recent], dtype=float)
    scores = np.array([row['sentiment'] for row in recent], dtype=float)
    headline = float(np.average(scores, weights=weights)) if len(recent) and weights.sum() > 0 else None
    timeline = news_service.store.timeline(since=week)

    def tone(rows):
        volume = sum(row['volume'] or 0. for row in rows)
        return (sum((row['volume'] or 0.)*(row['tone'] or 0.) for row in rows)/volume if volume else None), volume

    tone_day, volume_day = tone([row for row in timeline if row['bucket'] >= day])
    tone_week, volume_week = tone([row for row in timeline if row['bucket'] < day])
    tone_shift = None if tone_day is None or tone_week is None else tone_day-tone_week
    parts = [(headline, .6), (None if tone_shift is None else float(np.clip(tone_shift/3, -1, 1)), .4)]
    known = [(value, weight) for value, weight in parts if value is not None]
    score = sum(value*weight for value, weight in known)/sum(weight for _, weight in known) if known else None
    label = 'No data' if score is None else 'Bullish' if score > .15 else 'Bearish' if score < -.15 else 'Neutral'
    topic_counts = Counter(topic for row in recent for topic in row['topics'].split(',') if topic)
    topics = []
    for topic, count in topic_counts.most_common(6):
        values = [row['sentiment'] for row in recent if topic in row['topics'].split(',')]
        topics.append(dict(topic=topic, count=count, sentiment=float(np.mean(values))))
    drivers = sorted(recent, key=lambda row: -abs(row['sentiment'])*row['relevance'])[:5]
    return dict(label=label, score=score, headlineSentiment=headline, headlines=len(recent),
                tone24h=tone_day, tone7d=tone_week, toneShift=tone_shift, volume24h=volume_day,
                volumeRatio=None if not volume_week else volume_day/(volume_week/7),
                topics=topics, drivers=[_article(row) for row in drivers if row['sentiment']])


@router.get('/status')
def news_status():
    return news_service.status()


@router.post('/refresh')
def refresh_news():
    """Collect headlines now (RSS feeds and GDELT article list)."""
    added = news_service.collect_articles()
    return dict(added=added, status=news_service.status())

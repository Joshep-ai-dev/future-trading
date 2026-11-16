"""US economic calendar for silver: actual vs. forecast (consensus) and silver's real reaction.

Source: the FXStreet economic-calendar API (public, no key), which gives each
release's actual, consensus, previous and revised values. Only the events in
``EVENTS`` are kept, grouped as on the News page.

* surprise = actual - consensus; ``surprise_z`` divides it by the standard
  deviation of that event's past surprises (from 2024 on), so a 0.1 pp CPI miss
  and a 50k NFP miss are comparable.
* ``silver_bias`` is the textbook first reaction for silver: hotter inflation,
  stronger growth or a higher rate than expected -> higher yields and dollar ->
  silver down (-1 per unit of surprise); a higher unemployment rate -> up (+1).
* ``reaction`` measures what silver actually did 15 minutes, 1 hour and 4 hours
  after the release from the market candles, so the textbook sign can be
  checked against history (``group_stats``).
"""
from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

import numpy as np
import pandas as pd

CALENDAR_URL = 'https://calendar-api.fxstreet.com/en/api/v1/eventDates'
CALENDAR_START = 1704067200  # 2024-01-01: enough releases per event to size surprises
REACTION_MINUTES = (15, 60, 240)

GROUPS = (
    ('cpi', 'US CPI'), ('ppi', 'US PPI'), ('retail', 'US Retail Sales'), ('minutes', 'FOMC Minutes'),
    ('gdp_pce', 'US GDP + PCE'), ('nfp', 'US NFP'), ('rate', 'FOMC Interest Rate Decision'), ('press', 'Fed Press Conference'),
)
# FXStreet event name -> (group, silver sign per unit of surprise, core figure of the group).
# Core = the figure markets trade on: core CPI / PPI / PCE m/m, retail sales ex autos, NFP, GDP, FOMC events.
EVENTS = {
    'Consumer Price Index ex Food & Energy (MoM)': ('cpi', -1, True),
    'Consumer Price Index (YoY)': ('cpi', -1, False),
    'Consumer Price Index (MoM)': ('cpi', -1, False),
    'Consumer Price Index ex Food & Energy (YoY)': ('cpi', -1, False),
    'Producer Price Index ex Food & Energy (MoM)': ('ppi', -1, True),
    'Producer Price Index (MoM)': ('ppi', -1, False),
    'Producer Price Index (YoY)': ('ppi', -1, False),
    'Producer Price Index ex Food & Energy (YoY)': ('ppi', -1, False),
    'Retail Sales ex Autos (MoM)': ('retail', -1, True),
    'Retail Sales (MoM)': ('retail', -1, False),
    'Retail Sales Control Group': ('retail', -1, False),
    'FOMC Minutes': ('minutes', 0, True),
    'Gross Domestic Product Annualized': ('gdp_pce', -1, True),
    'Core Personal Consumption Expenditures - Price Index (YoY)': ('gdp_pce', -1, False),
    'Core Personal Consumption Expenditures - Price Index (MoM)': ('gdp_pce', -1, True),
    'Personal Consumption Expenditures - Price Index (YoY)': ('gdp_pce', -1, False),
    'Personal Consumption Expenditures - Price Index (MoM)': ('gdp_pce', -1, False),
    'Nonfarm Payrolls': ('nfp', -1, True),
    'Unemployment Rate': ('nfp', 1, False),
    'Average Hourly Earnings (MoM)': ('nfp', -1, False),
    'Average Hourly Earnings (YoY)': ('nfp', -1, False),
    'Fed Interest Rate Decision': ('rate', -1, True),
    'FOMC Press Conference': ('press', 0, True),
}


def _number(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if np.isfinite(number) else None


def parse_events(rows: list[dict], now: int | None = None) -> list[dict]:
    """FXStreet rows -> stored events (US events in ``EVENTS`` only)."""
    now = int(now or time.time())
    events = []
    for row in rows:
        name = row.get('name')
        if row.get('countryCode') != 'US' or name not in EVENTS:
            continue
        group, sign, primary = EVENTS[name]
        try:
            released = int(datetime.fromisoformat(row['dateUtc'].replace('Z', '+00:00')).timestamp())
        except (KeyError, ValueError):
            continue
        period = (row.get('periodDateUtc') or '')[:10]
        better = row.get('isBetterThanExpected')
        events.append(dict(
            id=str(row.get('id') or f'{name}-{released}'), name=name, grp=group, silver_sign=sign, primary_event=int(primary),
            released=released, period=period, period_type=row.get('periodType') or '', actual=_number(row.get('actual')),
            consensus=_number(row.get('consensus')), previous=_number(row.get('previous')), revised=_number(row.get('revised')),
            unit=row.get('unit') or '', potency=row.get('potency') or '', volatility=row.get('volatility') or '',
            better=None if better is None else int(bool(better)), fetched=now))
    return events


def _get(url: str) -> bytes:
    request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (compatible; SilverTerminal/1.0)',
                                                   'Referer': 'https://www.fxstreet.com/', 'Accept': 'application/json'})
    with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310 - fixed https URL
        return response.read()


def fetch_calendar(start: int, end: int, opener=_get) -> list[dict]:
    """US events between two UTC timestamps (callers keep ranges to about six months)."""
    stamp = lambda value: datetime.fromtimestamp(value, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')  # noqa: E731
    url = f'{CALENDAR_URL}/{stamp(start)}/{stamp(end)}?{urllib.parse.urlencode({"countries": "US"})}'
    return parse_events(json.loads(opener(url)))


def surprise_scales(events: list[dict]) -> dict[str, float]:
    """Per event name: standard deviation of past surprises (at least 5 released values)."""
    by_name: dict[str, list[float]] = {}
    for event in events:
        if event['actual'] is not None and event['consensus'] is not None:
            by_name.setdefault(event['name'], []).append(event['actual']-event['consensus'])
    return {name: float(np.std(values)) for name, values in by_name.items() if len(values) >= 5 and np.std(values) > 1e-12}


def reactions(times: np.ndarray, closes: np.ndarray, released: list[int]) -> list[dict | None]:
    """Silver % move from the last close before each release to REACTION_MINUTES later (None without data)."""
    out = []
    for at in released:
        before = np.searchsorted(times, at, side='right')-1  # last 1m candle opening at or before the release
        if before < 0 or at-times[before] > 600:
            out.append(None)
            continue
        base = closes[max(0, before-1)] if times[before] == at else closes[before]
        moves = {}
        for minutes in REACTION_MINUTES:
            # The candle opening one minute before at+minutes closes exactly at at+minutes.
            close_at = at+minutes*60-60
            target = np.searchsorted(times, close_at, side='right')-1
            if target <= before-(times[before] == at) or close_at-times[target] > 600:
                moves[f'm{minutes}'] = None
            else:
                moves[f'm{minutes}'] = float((closes[target]/base-1)*100)
        out.append(moves)
    return out


def enrich(events: list[dict], scales: dict[str, float], bars: pd.DataFrame | None) -> list[dict]:
    """API rows: surprise, z-score, textbook silver bias and the measured silver reaction."""
    reaction = [None]*len(events)
    if bars is not None and len(bars):
        times = (bars.index.asi8//10**9).astype(np.int64)
        reaction = reactions(times, bars['close'].to_numpy(float), [event['released'] for event in events])
    rows = []
    for event, moved in zip(events, reaction):
        # Core flag and sign always come from EVENTS, so stored rows follow later changes of the table.
        _, sign, core = EVENTS.get(event['name'], (event['grp'], event['silver_sign'], bool(event['primary_event'])))
        surprise = None if event['actual'] is None or event['consensus'] is None else round(event['actual']-event['consensus'], 6)
        scale = scales.get(event['name'])
        z = None if surprise is None or not scale else surprise/scale
        rows.append(dict(
            id=event['id'], name=event['name'], group=event['grp'], core=core, released=event['released'],
            period=event['period'], periodType=event['period_type'], actual=event['actual'], forecast=event['consensus'],
            previous=event['previous'], revised=event['revised'], potency=event['potency'], volatility=event['volatility'],
            surprise=surprise, surpriseZ=z, silverBias=None if z is None or not sign else float(np.clip(sign*z, -3, 3)),
            reaction=moved))
    return rows


def group_stats(rows: list[dict]) -> list[dict]:
    """Per group, from core releases with a measured 1-hour reaction: how silver actually responded to surprises."""
    stats = []
    for key, label in GROUPS:
        group = [row for row in rows if row['group'] == key and row['core'] and row['released'] <= time.time()]
        measured = [row for row in group if row['reaction'] and row['reaction'].get('m60') is not None]
        moves = np.array([row['reaction']['m60'] for row in measured], dtype=float)
        biased = [row for row in measured if row['silverBias']]
        agree = [np.sign(row['silverBias']) == np.sign(row['reaction']['m60']) for row in biased if row['reaction']['m60']]
        pairs = np.array([(row['surpriseZ'], row['reaction']['m60']) for row in measured if row['surpriseZ'] is not None], dtype=float)
        correlation = float(np.corrcoef(pairs[:, 0], pairs[:, 1])[0, 1]) if len(pairs) >= 5 and pairs[:, 0].std() > 0 and pairs[:, 1].std() > 0 else None
        upcoming = [row for row in rows if row['group'] == key and row['core'] and row['released'] > time.time()]
        stats.append(dict(
            group=key, label=label, releases=len(group), measured=len(measured),
            averageAbsMove=float(np.mean(np.abs(moves))) if len(moves) else None,
            biasHitRate=float(np.mean(agree)) if agree else None, surpriseCorrelation=correlation,
            last=max(group, key=lambda row: row['released']) if group else None,
            next=min(upcoming, key=lambda row: row['released']) if upcoming else None))
    return stats

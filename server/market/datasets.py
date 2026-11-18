"""Public one-minute exchange history, isolated by exchange and exact symbol."""
from pathlib import Path
import hashlib
import json
import math
import re
import threading
import time

import pandas as pd

ROOT = Path(__file__).resolve().parents[2] / 'data' / 'markets'
_lock = threading.Lock()


def dataset_path(key: str) -> Path:
    if not re.fullmatch(r'dataset:[a-f0-9]{64}', key):
        raise ValueError('Invalid downloaded market identifier')
    return ROOT / (key[8:] + '.csv')


def list_datasets() -> list[dict]:
    if not ROOT.exists():
        return []
    rows = []
    with _lock:
        for path in ROOT.glob('*.json'):
            row = json.loads(path.read_text(encoding='utf-8'))
            if dataset_path(row['id']).exists():
                rows.append(row)
    return sorted(rows, key=lambda row: row['label'])


def save_minutes(venue: str, symbol: str, candles: list, start: int, end: int) -> dict:
    rows = {}
    for candle in candles:
        timestamp, opened, high, low, closed, volume = candle[:6]
        if not start <= timestamp < end:
            continue
        if timestamp % 60000 or not all(math.isfinite(float(value)) for value in candle[:6]):
            raise ValueError('Exchange returned invalid candle values')
        if min(opened, high, low, closed) <= 0 or volume < 0 or high < max(opened, low, closed) or low > min(opened, high, closed):
            raise ValueError('Exchange returned invalid OHLCV')
        rows[timestamp] = candle[:6]
    if not rows:
        raise ValueError('No completed one-minute candles available in the requested range')
    key = 'dataset:' + hashlib.sha256(f'{venue}:{symbol}'.encode()).hexdigest()
    path = dataset_path(key)
    with _lock:
        ROOT.mkdir(parents=True, exist_ok=True)
        columns = ['timestamp_ms', 'open', 'high', 'low', 'close', 'volume_contracts']
        frame = pd.DataFrame(rows.values(), columns=columns)
        if path.exists():
            frame = pd.concat([pd.read_csv(path), frame], ignore_index=True)
        frame = frame.drop_duplicates('timestamp_ms', keep='last').sort_values('timestamp_ms')
        temporary = path.with_suffix('.tmp')
        frame.to_csv(temporary, index=False)
        temporary.replace(path)
        first, last = int(frame.iloc[0].timestamp_ms), int(frame.iloc[-1].timestamp_ms)
        meta = dict(id=key, venue=venue, symbol=symbol, label=f"{symbol.split(':')[0]} - {venue.upper()}",
                    bars=len(frame), start=first//1000, end=last//1000,
                    startDate=pd.Timestamp(first, unit='ms').strftime('%Y-%m-%d'),
                    endDate=pd.Timestamp(last, unit='ms').strftime('%Y-%m-%d'),
                    missingBars=(last-first)//60000+1-len(frame))
        temporary = path.with_suffix('.json.tmp')
        temporary.write_text(json.dumps(meta), encoding='utf-8')
        temporary.replace(path.with_suffix('.json'))
    return {**meta, 'downloadedBars': len(rows), 'requestedStart': start//1000,
            'requestedEnd': end//1000, 'downloadedStart': min(rows)//1000, 'downloadedEnd': max(rows)//1000}


def download_minutes(exchange, market: dict, venue: str, days: int = 7, *, start_ms: int | None = None, end_ms: int | None = None) -> dict:
    latest = int(time.time()//60)*60000
    end = min(end_ms, latest) if end_ms is not None else latest
    start = start_ms if start_ms is not None else end-days*86400000
    if start >= end or start % 60000 or end % 60000 or end-start > 30*86400000:
        raise ValueError('Choose a completed date range of up to 30 days')
    requested_start = start
    if venue == 'hyperliquid':
        # The API retains only the most recent 5000 candles, including the
        # forming minute. Older requested dates must not trigger huge queries.
        start = max(start, latest-4999*60000)
        if start >= end:
            raise ValueError('Hyperliquid only serves the latest 5000 one-minute candles (about 3.5 days). Choose more recent dates; previously saved history remains available in Paper mode.')
    days = max(1, math.ceil((end-start)/86400000))
    candles = []
    if venue == 'htx':
        cursor = end
        for _ in range(days*15+10):
            since = max(start, cursor-500*60000)
            page = exchange.fetch_ohlcv(market['symbol'], '1m', since=since, params={'until': cursor-1})
            page = [row for row in page if start <= row[0] < cursor]
            if not page:
                break
            candles.extend(page)
            cursor = min(row[0] for row in page)
            if cursor <= start:
                break
    else:
        cursor = start
        for _ in range(days*15+10):
            params = {'until': min(end, cursor+500*60000)-1} if venue == 'hyperliquid' else {}
            page = exchange.fetch_ohlcv(market['symbol'], '1m', since=cursor, limit=500, **({'params': params} if params else {}))
            page = [row for row in page if cursor <= row[0] < end]
            if not page:
                break
            candles.extend(page)
            cursor = max(row[0] for row in page)+60000
            if cursor >= end:
                break
        if not candles:
            # Some APIs cannot page back before their retention window.
            candles = exchange.fetch_ohlcv(market['symbol'], '1m', limit=500)
    result = save_minutes(venue, market['symbol'], candles, start, end)
    result['requestedStart'] = requested_start//1000
    result['limitedHistory'] = result['downloadedStart'] > requested_start//1000 or result['downloadedEnd'] < end//1000-60
    return result

"""Hourly public OKX candle catch-up; atomic cache writes preserve original CSV."""
import json
from http.client import HTTPException
import logging
import threading
import time
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import numpy as np
import pandas as pd

from server.market.data import CSV

CACHE = CSV.with_name('OKX_XAG-USDT-SWAP_1m_updates.csv')
COLUMNS = ['timestamp_ms', 'open', 'high', 'low', 'close', 'volume_contracts']
log = logging.getLogger(__name__)


def fetch_page(after=None):
    params = dict(instId='XAG-USDT-SWAP', bar='1m', limit='100')
    if after is not None:
        params['after'] = str(after)
    request = Request('https://www.okx.com/api/v5/market/history-candles?' + urlencode(params),
                      headers={'User-Agent': 'SilverResearch/1.0'})
    for attempt in range(3):
        try:
            with urlopen(request, timeout=20) as response:
                payload = json.load(response)
            if str(payload.get('code')) != '0':
                raise ValueError('OKX: ' + str(payload.get('msg', payload)))
            return payload['data']
        except (OSError, ValueError, HTTPException):  # HTTPException covers truncated responses.
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)


class MarketRefresh:
    def __init__(self, source=CSV, cache=CACHE, fetch=fetch_page, interval=3600):
        self.source, self.cache = Path(source), Path(cache)
        self.fetch, self.interval = fetch, interval
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.state = dict(running=False, lastAttempt=None, lastSuccess=None,
                          latestCandle=None, addedRows=0, error=None, nextRefresh=None,
                          pages=0, pendingRows=0, oldestScanned=None)
        self.thread = None

    def status(self):
        return dict(self.state, intervalSeconds=self.interval, instrument='XAG-USDT-SWAP')

    def refresh(self):
        if not self.lock.acquire(blocking=False):
            return self.status()
        self.state.update(running=True, lastAttempt=int(time.time()), error=None,
                          pages=0, pendingRows=0, oldestScanned=None)
        try:
            source = pd.read_csv(self.source, usecols=COLUMNS)
            existing = pd.read_csv(self.cache, usecols=COLUMNS) if self.cache.exists() else pd.DataFrame(columns=COLUMNS)
            latest = int(max(source.timestamp_ms.max(), existing.timestamp_ms.max())) if len(existing) else int(source.timestamp_ms.max())
            after, rows = None, []
            now_ms = int(time.time() * 1000)
            while not self.stop.is_set():
                page = self.fetch(after)
                if not page:
                    raise ValueError('OKX history ended before reaching local history; cache not changed')
                stamps = [int(row[0]) for row in page]
                oldest = min(stamps)
                if after is not None and oldest >= after:
                    raise ValueError('OKX pagination did not advance')
                for row in page:
                    stamp = int(row[0])
                    if stamp > latest and stamp + 60000 <= now_ms and str(row[8]) == '1':
                        rows.append([stamp, *map(float, row[1:6])])
                self.state.update(pages=self.state['pages']+1, pendingRows=len(rows),
                                  oldestScanned=oldest//1000)
                if oldest <= latest:
                    break
                after = oldest
                if self.stop.wait(.15):
                    return self.status()
            if self.stop.is_set():
                return self.status()
            if rows:
                new = pd.DataFrame(rows, columns=COLUMNS)
                price = new[['open', 'high', 'low', 'close']]
                if (not np.isfinite(new.to_numpy(dtype=float)).all() or
                        (new.timestamp_ms % 60000 != 0).any() or (price <= 0).any().any() or
                        (new.high < new[['open', 'low', 'close']].max(axis=1)).any() or
                        (new.low > new[['open', 'high', 'close']].min(axis=1)).any() or
                        (new.volume_contracts < 0).any()):
                    raise ValueError('Invalid OHLCV received from OKX')
                merged = (pd.concat([existing, new]) if len(existing) else new).drop_duplicates('timestamp_ms', keep='last').sort_values('timestamp_ms')
                self.cache.parent.mkdir(parents=True, exist_ok=True)
                temporary = self.cache.with_suffix('.csv.tmp')
                merged.to_csv(temporary, index=False)
                temporary.replace(self.cache)
                added = len(merged)-len(existing)
                latest = int(merged.timestamp_ms.max())
            else:
                added = 0
            self.state.update(lastSuccess=int(time.time()), latestCandle=latest//1000, addedRows=added)
        except Exception as error:
            self.state['error'] = str(error)
            log.exception('Market data refresh failed')
        finally:
            self.state.update(running=False, nextRefresh=int(time.time()+self.interval))
            self.lock.release()
        return self.status()

    def start(self):
        def loop():
            while not self.stop.is_set():
                self.refresh()
                self.stop.wait(self.interval)
        self.thread = threading.Thread(target=loop, name='okx-hourly-refresh', daemon=True)
        self.thread.start()

    def shutdown(self):
        self.stop.set()
        if self.thread:
            self.thread.join(timeout=1)


refresh_service = MarketRefresh()

if __name__ == '__main__':
    print(json.dumps(refresh_service.refresh(), indent=2))

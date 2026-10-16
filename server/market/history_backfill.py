"""Download older public OKX minute candles into a separate history CSV.

Pages backwards from the earliest local candle until the requested start date
or until OKX has no older data. The original CSV and the update cache are
never modified; progress is flushed to disk every few pages so an interrupted
backfill keeps what it downloaded and resumes from there.
"""
from __future__ import annotations

import logging
import threading
import time
from pathlib import Path

import numpy as np
import pandas as pd

from server.market.data import CSV
from server.market.market_refresh import COLUMNS, fetch_page

HISTORY = CSV.with_name('OKX_XAG-USDT-SWAP_1m_history.csv')
CACHE = CSV.with_name('OKX_XAG-USDT-SWAP_1m_updates.csv')
log = logging.getLogger(__name__)


def validate(frame: pd.DataFrame) -> None:
    price = frame[['open', 'high', 'low', 'close']]
    if (not np.isfinite(frame.to_numpy(dtype=float)).all() or (frame.timestamp_ms % 60000 != 0).any()
            or (price <= 0).any().any() or (frame.high < frame[['open', 'low', 'close']].max(axis=1)).any()
            or (frame.low > frame[['open', 'high', 'close']].min(axis=1)).any() or (frame.volume_contracts < 0).any()):
        raise ValueError('Invalid OHLCV received from OKX')


class HistoryBackfill:
    def __init__(self, sources=(CSV, CACHE), history=HISTORY, fetch=fetch_page, flush_pages=50, pause=.12):
        self.sources, self.history = [Path(path) for path in sources], Path(history)
        self.fetch, self.flush_pages, self.pause = fetch, flush_pages, pause
        self.stop_event = threading.Event()
        self.lock = threading.Lock()
        self.thread = None
        self.state = dict(running=False, targetStart=None, oldestCandle=None, addedRows=0, pages=0,
                          error=None, finished=None, reachedStart=False)

    def status(self) -> dict:
        return dict(self.state)

    def _earliest(self) -> int:
        stamps = [pd.read_csv(path, usecols=['timestamp_ms']).timestamp_ms.min()
                  for path in [*self.sources, self.history] if path.exists()]
        stamps = [int(value) for value in stamps if pd.notna(value)]
        if not stamps:
            raise ValueError('No local candles to extend backwards')
        return min(stamps)

    def _write(self, rows: list[list[float]]) -> int:
        new = pd.DataFrame(rows, columns=COLUMNS)
        validate(new)
        existing = pd.read_csv(self.history, usecols=COLUMNS) if self.history.exists() else pd.DataFrame(columns=COLUMNS)
        merged = (pd.concat([existing, new]) if len(existing) else new).drop_duplicates('timestamp_ms').sort_values('timestamp_ms')
        temporary = self.history.with_suffix('.csv.tmp')
        merged.to_csv(temporary, index=False)
        temporary.replace(self.history)
        return len(merged)-len(existing)

    def start(self, days: int) -> dict:
        """Begin downloading until ``days`` before now (or the start of OKX history)."""
        if not 1 <= days <= 3650:
            raise ValueError('Choose between 1 and 3650 days of history')
        with self.lock:
            if self.state['running']:
                return self.status()
            target = int((time.time()-days*86400)*1000)//60000*60000
            self.stop_event.clear()
            self.state.update(running=True, targetStart=target//1000, addedRows=0, pages=0, error=None,
                              finished=None, reachedStart=False)
            self.thread = threading.Thread(target=self._run, args=(target,), name='history-backfill', daemon=True)
            self.thread.start()
        return self.status()

    def stop(self) -> dict:
        self.stop_event.set()
        return self.status()

    def _run(self, target: int) -> None:
        rows: list[list[float]] = []
        try:
            after = self._earliest()
            self.state['oldestCandle'] = after//1000
            while not self.stop_event.is_set() and after > target:
                page = self.fetch(after)
                if not page:
                    self.state['reachedStart'] = True  # OKX keeps no older candles for this contract.
                    break
                stamps = [int(row[0]) for row in page]
                oldest = min(stamps)
                if oldest >= after:
                    raise ValueError('OKX pagination did not advance')
                rows += [[int(row[0]), *map(float, row[1:6])] for row in page
                         if int(row[0]) >= target and str(row[8]) == '1']
                after = oldest
                self.state.update(pages=self.state['pages']+1, oldestCandle=oldest//1000)
                if self.state['pages'] % self.flush_pages == 0 and rows:
                    self.state['addedRows'] += self._write(rows)
                    rows = []
                if self.stop_event.wait(self.pause):
                    break
            if rows:
                self.state['addedRows'] += self._write(rows)
        except Exception as error:
            self.state['error'] = str(error)
            log.exception('History backfill failed')
        finally:
            self.state.update(running=False, finished=int(time.time()))

    def shutdown(self) -> None:
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=2)


history_backfill = HistoryBackfill()

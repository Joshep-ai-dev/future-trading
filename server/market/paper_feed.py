"""Public prices for paper execution, isolated by saved exchange and exact symbol."""
import threading
import time
import math

from server.market.datasets import dataset_path, list_datasets
from server.market.dataset_sync import public_exchange

_lock = threading.Lock()
_cache: dict[str, tuple[float, list[dict]]] = {}


def dataset_minutes(key: str) -> list[dict]:
    dataset_path(key)
    with _lock:
        cached = _cache.get(key)
        if cached and time.monotonic()-cached[0] < 5:
            return cached[1]
        dataset = next((row for row in list_datasets() if row['id'] == key), None)
        if dataset is None:
            raise ValueError('Download the selected exchange market first')
        exchange = public_exchange(dataset['venue'])
        try:
            rows = exchange.fetch_ohlcv(dataset['symbol'], '1m', limit=300)
            now = time.time()
            candles = [dict(time=int(row[0]/1000), open=float(row[1]), high=float(row[2]),
                            low=float(row[3]), close=float(row[4]), volume=float(row[5])) for row in rows
                       if row[0]/1000 <= now]
            candles = sorted({row['time']:row for row in candles}.values(), key=lambda row:row['time'])
            for row in candles:
                if not all(math.isfinite(row[key]) and row[key] > 0 for key in ('open','high','low','close')) or not math.isfinite(row['volume']) or row['volume'] < 0:
                    raise ValueError('Exchange returned invalid candle values')
            if not candles or now-candles[-1]['time'] > 120:
                raise ValueError('Waiting for fresh exchange candles')
            _cache[key] = (time.monotonic(), candles)
            return candles
        finally:
            close = getattr(exchange, 'close', None)
            if callable(close):
                close()

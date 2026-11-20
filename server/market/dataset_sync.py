"""Incrementally refresh saved paper markets through credential-free exchange APIs."""
import copy
import threading
import time

from server.market.datasets import dataset_path, download_minutes, list_datasets
from server.exchanges.live_exchange import VENUES
from server.exchanges.market_catalog import market_catalog, _snapshots

_locks: dict[str, threading.Lock] = {}
_guard = threading.Lock()
_success: dict[str, tuple[float, dict]] = {}


def prepare_dataset(venue: str, symbol: str) -> dict:
    if venue not in ('htx', 'hyperliquid'):
        raise ValueError('Choose HTX or Hyperliquid for public paper markets')
    if not any(row['id'] == symbol for row in market_catalog(venue)):
        raise ValueError('Choose an exact perpetual symbol from the exchange market list')
    exchange = public_exchange(venue)
    try:
        return download_minutes(exchange, {'symbol': symbol}, venue, days=1)
    finally:
        close = getattr(exchange, 'close', None)
        if callable(close):
            close()


def public_exchange(venue: str):
    import ccxt
    market_catalog(venue)
    markets, currencies, helpers = copy.deepcopy(_snapshots[venue])
    exchange = getattr(ccxt, VENUES[venue])({
        'enableRateLimit': True, 'timeout': 15000,
        'options': {'defaultType': 'swap', 'defaultSubType': 'linear'},
    })
    exchange.set_markets(markets, currencies)
    exchange.options.update(helpers)
    return exchange


def sync_dataset(key: str) -> dict:
    dataset_path(key)  # Validate before accessing shared state or the network.
    with _guard:
        lock = _locks.setdefault(key, threading.Lock())
    with lock:
        cached = _success.get(key)
        if cached and time.monotonic()-cached[0] < 30:
            return cached[1]
        dataset = next((row for row in list_datasets() if row['id'] == key), None)
        if dataset is None or dataset['venue'] not in VENUES:
            raise ValueError('Saved exchange market was not found')
        end = int(time.time()//60)*60000
        # Re-read the last minute to reconcile late exchange corrections.
        start = max(int(dataset['end'])*1000, end-30*86400000)
        exchange = public_exchange(dataset['venue'])
        try:
            result = download_minutes(exchange, {'symbol': dataset['symbol']}, dataset['venue'],
                                      start_ms=start, end_ms=end)
            result['lastSuccess'] = time.time()
            _success[key] = (time.monotonic(), result)
            return result
        finally:
            close = getattr(exchange, 'close', None)
            if callable(close):
                close()

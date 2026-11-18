"""Public OKX XAG-USDT-SWAP order book and recent trades for paper trading.

No credentials. One cached snapshot is shared by every user and refreshed at
most every 0.4 s per part; sizes are converted from contracts to XAG.
"""
import json
import threading
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from server.exchanges.exchange_stream import BOOK_DEPTH, TRADE_HISTORY, book_view, trade_view

INSTRUMENT = 'XAG-USDT-SWAP'
BASE_URL = 'https://www.okx.com'
CACHE_SECONDS = 0.4
SYMBOL = 'XAG/USDT:USDT'

_lock = threading.Lock()
_cache: dict[str, tuple[float, dict]] = {}
_contract_value: float | None = None


def _get(path: str, params: dict) -> list:
    request = Request(f'{BASE_URL}{path}?{urlencode(params)}', headers={'User-Agent': 'SilverResearch/1.0'})
    with urlopen(request, timeout=10) as response:
        payload = json.load(response)
    if str(payload.get('code')) != '0':
        raise ValueError('OKX: ' + str(payload.get('msg', payload)))
    return payload['data']


def contract_value() -> float:
    global _contract_value
    if _contract_value is None:
        rows = _get('/api/v5/public/instruments', dict(instType='SWAP', instId=INSTRUMENT))
        _contract_value = float(rows[0]['ctVal'])
    return _contract_value


def snapshot(books: list, trades: list, size: float) -> dict:
    """Convert OKX REST rows into the same shapes the live exchange stream publishes."""
    book = books[0] if books else {}
    view = book_view(dict(bids=[[float(row[0]), float(row[1])] for row in book.get('bids', [])],
                          asks=[[float(row[0]), float(row[1])] for row in book.get('asks', [])],
                          timestamp=int(book['ts']) if book.get('ts') else None), size)
    recent = [trade_view(dict(id=row.get('tradeId'), side=row.get('side'), price=float(row['px']),
                              amount=float(row['sz']), timestamp=int(row['ts'])), size)
              for row in trades[:TRADE_HISTORY]]
    return dict(symbol=SYMBOL, orderBook=view, trades=recent)


def public_order_book(part: str = 'book') -> dict:
    """Only the requested part is fetched: 'book' (order book) or 'trades'."""
    with _lock:
        cached = _cache.get(part)
        if cached and time.monotonic() - cached[0] < CACHE_SECONDS:
            return cached[1]
        size = contract_value()
        if part == 'trades':
            rows = _get('/api/v5/market/trades', dict(instId=INSTRUMENT, limit=str(TRADE_HISTORY)))
            result = dict(symbol=SYMBOL, trades=snapshot([], rows, size)['trades'])
        else:
            rows = _get('/api/v5/market/books', dict(instId=INSTRUMENT, sz=str(BOOK_DEPTH)))
            result = dict(symbol=SYMBOL, orderBook=snapshot(rows, [], size)['orderBook'])
        result['updatedAt'] = int(time.time() * 1000)
        _cache[part] = (time.monotonic(), result)
        return result

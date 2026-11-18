"""Public bulk market quotes, cached separately from the instrument catalog."""
import copy
import math
import threading
import time

from server.exchanges.live_exchange import VENUES
from server.exchanges.market_catalog import market_catalog, _snapshots

_cache: dict[str, tuple[float, dict]] = {}
_locks = {venue: threading.Lock() for venue in VENUES}


def finite(value: object) -> float | None:
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def normalize_quote(ticker: dict) -> dict:
    info = ticker.get('info') or {}
    price, source = None, None
    for value, kind in ((ticker.get('last'), 'last'), (ticker.get('close'), 'mid'), (info.get('markPx'), 'mark')):
        parsed = finite(value)
        if parsed is not None and parsed > 0:
            price, source = parsed, kind
            break
    previous = finite(ticker.get('open')) or finite(ticker.get('previousClose')) or finite(info.get('prevDayPx'))
    percentage = finite(ticker.get('percentage'))
    if percentage is None and price is not None and previous is not None and previous > 0:
        percentage = (price / previous - 1) * 100
    volume = finite(ticker.get('quoteVolume'))
    return dict(price=price, priceSource=source, percentage=percentage,
                quoteVolume=volume if volume is not None and volume >= 0 else None)


def market_quotes(venue: str) -> dict:
    import ccxt
    with _locks[venue]:
        cached = _cache.get(venue)
        if cached and time.monotonic() - cached[0] < 10:
            return cached[1]
        catalog = market_catalog(venue)
        symbols = {row['id'] for row in catalog}
        markets, currencies, helpers = copy.deepcopy(_snapshots[venue])
        exchange = getattr(ccxt, VENUES[venue])({
            'enableRateLimit': True, 'timeout': 15000,
            'options': {'defaultType': 'swap', 'defaultSubType': 'linear',
                        'fetchMarkets': {'hip3': {'limit': 1_000_000}}},
        })
        quotes, errors = {}, []
        try:
            exchange.set_markets(markets, currencies)
            exchange.options.update(helpers)
            groups = [{'type': 'swap'}, {'hip3': True}] if venue == 'hyperliquid' else [{}]
            for params in groups:
                try:
                    tickers = exchange.fetch_tickers(None, params)
                    quotes.update({symbol: normalize_quote(ticker) for symbol, ticker in tickers.items() if symbol in symbols})
                except Exception:
                    errors.append('Some market quotes are unavailable. Retrying automatically.')
            if not quotes:
                if cached:
                    return {**cached[1], 'stale': True, 'warning': 'Quote refresh failed. Showing previous prices.'}
                raise ValueError('Market quotes are currently unavailable')
            result = dict(quotes=quotes, updatedAt=int(time.time()*1000), stale=False,
                          warning=errors[0] if errors else None)
            _cache[venue] = (time.monotonic(), result)
            return result
        finally:
            close = getattr(exchange, 'close', None)
            if callable(close):
                close()

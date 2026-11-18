"""Credential-free perpetual market discovery with a short shared cache."""
import copy
import threading
import time

from server.exchanges.live_exchange import VENUES

_snapshots: dict[str, tuple[dict, dict, dict]] = {}

_cache: dict[str, tuple[float, list[dict]]] = {}
_locks = {venue: threading.Lock() for venue in VENUES}


def market_catalog(venue: str) -> list[dict]:
    import ccxt
    with _locks[venue]:
        cached = _cache.get(venue)
        if cached and time.monotonic() - cached[0] < 300:
            return cached[1]
        exchange = getattr(ccxt, VENUES[venue])({
            'enableRateLimit': True, 'timeout': 20000,
            'options': {'defaultType': 'swap', 'defaultSubType': 'linear',
                        'fetchMarkets': {'hip3': {'limit': 1_000_000}}},
        })
        try:
            exchange.load_markets()
            collateral = 'USDC' if venue == 'hyperliquid' else 'USDT'
            markets = {market['symbol']: {
                'id': market['symbol'], 'base': market['base'],
                'label': f"{market['base']} / {market['quote']}",
                'icon': market['base'][:2], 'unsupported': [],
            } for market in exchange.markets.values()
                if market.get('swap') and market.get('linear')
                and market.get('active') is not False
                and market.get('quote') == collateral and market.get('settle') == collateral}
            result = sorted(markets.values(), key=lambda market: market['id'])
            if not result:
                raise ValueError('No active perpetual markets returned')
            helper_keys = exchange.options.get('marketHelperProps', []) if isinstance(exchange.options, dict) else []
            helpers = {key: copy.deepcopy(exchange.options[key]) for key in helper_keys if key in exchange.options}
            _snapshots[venue] = (copy.deepcopy(exchange.markets),
                                 copy.deepcopy(exchange.currencies) if isinstance(exchange.currencies, dict) else {}, helpers)
            _cache[venue] = (time.monotonic(), result)
            return result
        finally:
            close = getattr(exchange, 'close', None)
            if callable(close):
                close()

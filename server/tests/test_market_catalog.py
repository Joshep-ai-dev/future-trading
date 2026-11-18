import unittest
from unittest.mock import MagicMock, patch

from server.exchanges import market_catalog as catalog
from server.exchanges.live_exchange import LiveExchange


class MarketCatalogTests(unittest.TestCase):
    def tearDown(self) -> None:
        catalog._cache.clear()

    def test_discovers_filters_sorts_and_caches_each_venue(self) -> None:
        for venue in ('htx', 'mexc', 'hyperliquid'):
            with self.subTest(venue=venue):
                quote = 'USDC' if venue == 'hyperliquid' else 'USDT'
                def market(base: str, **overrides: object) -> dict:
                    return dict(symbol=f'{base}/{quote}:{quote}', base=base, quote=quote,
                                settle=quote, swap=True, linear=True, active=True, **overrides)
                btc, eth = market('BTC'), market('ETH')
                exchange = MagicMock()
                exchange.markets = {str(i): row for i, row in enumerate([
                    eth, btc, {**btc, 'active': False}, {**btc, 'swap': False},
                    {**btc, 'linear': False}, {**btc, 'settle': 'BTC'}])}
                with patch(f'ccxt.{venue}', return_value=exchange) as adapter:
                    rows = catalog.market_catalog(venue)
                    self.assertEqual([row['id'] for row in rows], [btc['symbol'], eth['symbol']])
                    self.assertEqual(catalog.market_catalog(venue), rows)
                    adapter.assert_called_once()
                    exchange.close.assert_called_once()

    def test_failure_is_not_cached_and_closes_client(self) -> None:
        exchange = MagicMock()
        exchange.load_markets.side_effect = RuntimeError('offline')
        with patch('ccxt.mexc', return_value=exchange):
            with self.assertRaises(RuntimeError):
                catalog.market_catalog('mexc')
        self.assertNotIn('mexc', catalog._cache)
        exchange.close.assert_called_once()

    def test_exact_symbols_do_not_confuse_hip3_dexes(self) -> None:
        exchange = MagicMock(id='hyperliquid')
        exchange.options = {}
        rows = [dict(symbol=f'{dex}-BTC/USDC:USDC', base=f'{dex}-BTC',
                     quote='USDC', settle='USDC', swap=True, linear=True)
                for dex in ('XYZ', 'ABC')]
        exchange.markets = {row['symbol']: row for row in rows}
        self.assertIs(LiveExchange._market(exchange, rows[1]['symbol']), rows[1])

    def test_connections_accept_discovered_symbols_on_all_requested_venues(self) -> None:
        for venue in ('htx', 'mexc', 'hyperliquid'):
            with self.subTest(venue=venue):
                quote = 'USDC' if venue == 'hyperliquid' else 'USDT'
                market = {'symbol': f'BTC/{quote}:{quote}', 'base': 'BTC', 'contractSize': 1}
                exchange = MagicMock()
                exchange.has = {'fetchPositions': True}
                service = LiveExchange()
                with patch(f'ccxt.{venue}', return_value=exchange), patch.object(
                    service, '_market', return_value=market
                ), patch.object(service, 'account_balance', return_value={'total': {quote: 25}}):
                    result = service.connect(venue, 'test-key', 'test-secret', instrument=market['symbol'])
                self.assertEqual(result['symbol'], market['symbol'])
                exchange.create_order.assert_not_called()

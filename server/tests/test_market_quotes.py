import time
import unittest
from unittest.mock import MagicMock, patch

from server.exchanges import market_quotes as quotes


class MarketQuoteTests(unittest.TestCase):
    def tearDown(self) -> None:
        quotes._cache.clear()

    def test_normalization_preserves_zero_change_and_missing_volume(self) -> None:
        row = quotes.normalize_quote({'last': '0.0000000123', 'percentage': 0})
        self.assertEqual(row['price'], 0.0000000123)
        self.assertEqual(row['percentage'], 0)
        self.assertIsNone(row['quoteVolume'])

    def test_hyperliquid_mid_and_mark_prices_use_previous_day_for_change(self) -> None:
        mid = quotes.normalize_quote({'close': '110', 'previousClose': '100', 'quoteVolume': '25'})
        self.assertAlmostEqual(mid['percentage'], 10)
        self.assertEqual(mid['priceSource'], 'mid')
        mark = quotes.normalize_quote({'info': {'markPx': '90', 'prevDayPx': '100'}})
        self.assertAlmostEqual(mark['percentage'], -10)
        self.assertEqual(mark['priceSource'], 'mark')

    def test_invalid_numbers_are_not_sent_as_json(self) -> None:
        row = quotes.normalize_quote({'last': float('nan'), 'percentage': float('inf'), 'quoteVolume': -1})
        self.assertIsNone(row['price'])
        self.assertIsNone(row['percentage'])
        self.assertIsNone(row['quoteVolume'])

    def test_bulk_quotes_cover_native_and_hip3_markets_and_are_cached(self) -> None:
        native, hip3 = 'BTC/USDC:USDC', 'XYZ-SILVER/USDC:USDC'
        exchange = MagicMock()
        exchange.options = {}
        exchange.fetch_tickers.side_effect = [{native: {'last': 100}, 'BTC/USDC': {'last': 999}}, {hip3: {'last': 30}}]
        with patch.object(quotes, 'market_catalog', return_value=[{'id': native}, {'id': hip3}]), patch.dict(
            quotes._snapshots, {'hyperliquid': ({}, {}, {'hip3TokensByName': {}})}
        ), patch('ccxt.hyperliquid', return_value=exchange) as factory:
            result = quotes.market_quotes('hyperliquid')
            self.assertEqual(set(result['quotes']), {native, hip3})
            self.assertEqual(result, quotes.market_quotes('hyperliquid'))
        self.assertEqual([call.args[1] for call in exchange.fetch_tickers.call_args_list], [{'type': 'swap'}, {'hip3': True}])
        factory.assert_called_once()
        exchange.close.assert_called_once()

    def test_failed_refresh_keeps_previous_quotes_and_marks_them_stale(self) -> None:
        previous = {'quotes': {'BTC/USDT:USDT': {'price': 123}}, 'updatedAt': 1000, 'stale': False, 'warning': None}
        quotes._cache['htx'] = (time.monotonic()-60, previous)
        exchange = MagicMock()
        exchange.options = {}
        exchange.fetch_tickers.side_effect = RuntimeError('private-error-details')
        with patch.object(quotes, 'market_catalog', return_value=[{'id': 'BTC/USDT:USDT'}]), patch.dict(
            quotes._snapshots, {'htx': ({}, {}, {})}
        ), patch('ccxt.htx', return_value=exchange):
            result = quotes.market_quotes('htx')
        self.assertTrue(result['stale'])
        self.assertEqual(result['quotes'], previous['quotes'])
        self.assertEqual(result['updatedAt'], 1000)
        self.assertNotIn('private', result['warning'])

    def test_partial_hyperliquid_failure_keeps_symbol_list_independent(self) -> None:
        exchange = MagicMock()
        exchange.options = {}
        exchange.fetch_tickers.side_effect = [{'BTC/USDC:USDC': {'last': 100}}, RuntimeError('offline')]
        with patch.object(quotes, 'market_catalog', return_value=[{'id':'BTC/USDC:USDC'}, {'id':'XYZ-ZEC/USDC:USDC'}]), patch.dict(
            quotes._snapshots, {'hyperliquid': ({}, {}, {})}
        ), patch('ccxt.hyperliquid', return_value=exchange):
            result = quotes.market_quotes('hyperliquid')
        self.assertEqual(len(result['quotes']), 1)
        self.assertIsNotNone(result['warning'])

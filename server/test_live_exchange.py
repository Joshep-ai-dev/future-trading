import unittest
from unittest.mock import MagicMock, patch

import ccxt

from .live_exchange import LiveExchange


class ExchangeConnectionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.service = LiveExchange()
        self.exchange = MagicMock()
        self.exchange.has = {'fetchPositions': True}
        self.market = {'symbol': 'XAG/USDT:USDT', 'contractSize': 1}
        self.exchange.fetch_balance.return_value = {'total': {'USDT': 25}}

    def test_htx_reads_linear_perpetual_balance(self) -> None:
        with patch.object(ccxt, 'htx', return_value=self.exchange) as adapter, patch.object(
            self.service, '_market', return_value=self.market
        ):
            result = self.service.connect('htx', 'key', 'secret')
        self.assertEqual(adapter.call_args.args[0]['options'],
                         {'defaultType': 'swap', 'defaultSubType': 'linear'})
        self.exchange.fetch_balance.assert_called_once_with({'type': 'swap', 'subType': 'linear'})
        self.assertEqual(result['usdtBalance'], 25)

    def test_connection_errors_are_sanitized_and_client_is_not_saved(self) -> None:
        for error_type, expected in (
            (ccxt.PermissionDenied, 'denied access'),
            (ccxt.AuthenticationError, 'authentication failed'),
            (ccxt.NetworkError, 'network request failed'),
            (ccxt.ExchangeError, 'rejected the request'),
        ):
            with self.subTest(error_type=error_type):
                self.exchange.fetch_balance.side_effect = error_type('private-secret')
                with patch.object(ccxt, 'htx', return_value=self.exchange), patch.object(
                    self.service, '_market', return_value=self.market
                ), self.assertRaises(ValueError) as caught:
                    self.service.connect('htx', 'key', 'secret')
                self.assertIn(expected, str(caught.exception))
                self.assertIn('reading the futures account balance', str(caught.exception))
                self.assertNotIn('private-secret', str(caught.exception))
                self.assertNotIn('htx', self.service.clients)
                self.exchange.close.assert_called()

    def test_other_venues_keep_existing_balance_request(self) -> None:
        with patch.object(ccxt, 'mexc', return_value=self.exchange), patch.object(
            self.service, '_market', return_value=self.market
        ):
            self.service.connect('mexc', 'key', 'secret')
        self.exchange.fetch_balance.assert_called_once_with()

    def test_overview_filters_positions_and_converts_contract_sizes(self) -> None:
        self.service.clients['htx'] = self.exchange
        self.service.markets['htx'] = {**self.market, 'contractSize': 0.1}
        self.exchange.has['fetchOpenOrders'] = True
        self.exchange.fetch_ticker.return_value = {'last': 32, 'bid': 31.9, 'ask': 32.1, 'info': {'secret': 'private'}}
        self.exchange.fetch_positions.return_value = [
            {'contracts': 0}, {'contracts': 10, 'side': 'long', 'entryPrice': 30, 'unrealizedPnl': 2}]
        self.exchange.fetch_open_orders.return_value = [{'id': 'order', 'amount': 20, 'filled': 5, 'side': 'buy'}]
        result = self.service.overview('htx')
        self.assertEqual(result['positions'][0]['quantity'], 1)
        self.assertEqual(len(result['positions']), 1)
        self.assertEqual(result['orders'][0]['quantity'], 2)
        self.assertEqual(result['orders'][0]['filled'], 0.5)
        self.assertEqual(result['balance']['total'], 25)
        self.assertNotIn('info', result['market'])
        self.assertEqual(result['errors'], {})

    def test_overview_partial_failure_is_not_an_empty_position_list(self) -> None:
        self.service.clients['htx'] = self.exchange
        self.service.markets['htx'] = self.market
        self.exchange.has['fetchOpenOrders'] = False
        self.exchange.fetch_ticker.return_value = {'last': 32}
        self.exchange.fetch_positions.side_effect = ccxt.NetworkError('private-secret')
        result = self.service.overview('htx')
        self.assertIsNone(result['positions'])
        self.assertIsNone(result['orders'])
        self.assertIn('positions', result['errors'])
        self.assertNotIn('private-secret', str(result))
        self.assertEqual(result['market']['last'], 32)

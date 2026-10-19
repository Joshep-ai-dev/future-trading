import unittest
from unittest.mock import MagicMock, patch

import ccxt

from server.exchanges.live_exchange import AutomaticLiveBot, LiveExchange


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

    def test_disconnect_preserves_exchange_positions_and_orders(self) -> None:
        self.service.clients['htx'] = self.exchange
        self.service.markets['htx'] = self.market
        result = self.service.disconnect('htx')
        self.assertFalse(result['connected'])
        self.assertNotIn('htx', self.service.clients)
        self.exchange.close.assert_called_once()
        self.exchange.fetch_positions.assert_not_called()
        self.exchange.create_order.assert_not_called()
        self.exchange.cancel_order.assert_not_called()

    def test_disconnect_stops_only_the_selected_venues_bot(self) -> None:
        self.service.clients['htx'] = self.exchange
        self.service.markets['htx'] = self.market
        bot = MagicMock(venue='htx', thread=None)
        self.service.auto_bot = bot
        self.service.disconnect('htx')
        bot.stop.assert_called_once()
        bot.venue = 'okx'
        bot.stop.reset_mock()
        self.service.disconnect('htx')
        bot.stop.assert_not_called()

    def test_disconnect_waits_for_bot_request_before_releasing_client(self) -> None:
        self.service.clients['htx'] = self.exchange
        self.service.markets['htx'] = self.market
        bot = MagicMock(venue='htx')
        bot.thread.is_alive.return_value = True
        self.service.auto_bot = bot
        with self.assertRaisesRegex(ValueError, 'finishing an exchange request'):
            self.service.disconnect('htx')
        bot.stop.assert_called_once()
        bot.thread.join.assert_called_once_with(timeout=15)
        self.assertIn('htx', self.service.clients)
        self.exchange.close.assert_not_called()

    def test_live_sizing_uses_available_margin_and_never_falls_back_to_equity(self) -> None:
        self.exchange.id = 'htx'
        self.exchange.options = {}
        bot = AutomaticLiveBot(self.service)
        self.exchange.fetch_balance.return_value = {'free': {'USDT': 4.96}, 'total': {'USDT': 783}}
        self.assertEqual(bot._available_usdt(self.exchange), 4.96)
        for free in (0, -1, None, float('nan'), float('inf')):
            with self.subTest(free=free):
                self.exchange.fetch_balance.return_value = {'free': {'USDT': free}, 'total': {'USDT': 783}}
                with self.assertRaises(ValueError):
                    bot._available_usdt(self.exchange)

    def test_trade_history_uses_only_exchange_reported_realized_pnl(self) -> None:
        self.service.clients['htx'] = self.exchange
        self.service.markets['htx'] = {**self.market, 'contractSize': 0.1}
        self.exchange.has['fetchClosedOrders'] = True
        self.exchange.fetch_closed_orders.return_value = [
            {'id': '1', 'side': 'sell', 'filled': 20, 'average': 57.5,
             'timestamp': 1_700_000_000_000, 'info': {'real_profit': '12.5', 'lever_rate': '12'}},
            {'id': '2', 'side': 'buy', 'filled': 1, 'average': 57,
             'timestamp': 1_700_000_100_000, 'info': {}},
        ]
        result = self.service.trade_history('htx')
        self.assertEqual(result, [{'id': '1', 'side': 'sell', 'pnl': 12.5, 'price': 57.5,
                                   'quantity': 2., 'leverage': 12., 'timestamp': 1_700_000_000}])

    def test_take_profit_is_optional_and_validated_before_entry(self) -> None:
        self.service.clients['htx'] = self.exchange
        self.service.markets['htx'] = self.market
        self.exchange.fetch_positions.return_value = []
        self.exchange.fetch_ticker.return_value = {'last': 57}
        with self.assertRaisesRegex(ValueError, 'Take profit'):
            self.service.open_with_stop('htx', 'long', 1, 56, 55)
        self.exchange.create_order.assert_not_called()

    def test_htx_backward_candles_omit_limit_and_use_until(self) -> None:
        from types import SimpleNamespace
        from server.app import exchange_candles
        self.exchange.timeframes = {'1m': '1min', '5m': '5min'}
        self.exchange.fetch_ohlcv.return_value = [[1_699_999_700_000, 1, 2, 1, 2, 10]]
        service = SimpleNamespace(_get=lambda venue: (self.exchange, self.market))
        with patch('server.app.workspace', return_value=SimpleNamespace(exchange=service)):
            result = exchange_candles('htx', '5m', before=1_700_000_000, request=None)
        self.exchange.fetch_ohlcv.assert_called_once_with(
            self.market['symbol'], '5m', since=1_699_850_000_000,
            params={'until': 1_699_999_999_999})
        self.assertTrue(result['hasMore'])


class LiveOrderSafetyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.service = LiveExchange()
        self.exchange = MagicMock()
        self.exchange.has = {'fetchPositions': True}
        self.market = {'symbol': 'XAG/USDT:USDT', 'contractSize': 1}
        self.service.clients['htx'] = self.exchange
        self.service.markets['htx'] = self.market

    def test_error_text_hides_urls_queries_and_tokens(self) -> None:
        from server.exchanges.live_exchange import safe_exchange_error
        error = RuntimeError('htx POST https://api.hbdm.com/linear-swap-api/v1/order?AccessKeyId=abcdef1234567890abcdef12&Signature=XYZ '
                             '{"err_msg":"insufficient margin"} key=ZmFrZXNlY3JldGtleXZhbHVlMTIzNDU2Nzg5')
        text = safe_exchange_error(error)
        self.assertIn('insufficient margin', text)
        for secret in ('AccessKeyId', 'abcdef1234567890abcdef12', 'Signature', 'ZmFrZXNlY3JldGtleXZhbHVlMTIzNDU2Nzg5'):
            self.assertNotIn(secret, text)

    def test_prepare_account_accepts_already_set_and_names_real_failures(self) -> None:
        from server.exchanges.live_exchange import OrderStepError
        self.exchange.set_margin_mode.side_effect = Exception('margin mode already isolated, no need to change')
        self.service.prepare_account('htx', 12)
        self.exchange.set_leverage.assert_called_once_with(12, 'XAG/USDT:USDT')
        self.exchange.set_leverage.side_effect = Exception('leverage exceeds the maximum allowed')
        with self.assertRaisesRegex(OrderStepError, 'Setting 12x leverage failed.*maximum'):
            self.service.prepare_account('htx', 12)

    def test_order_without_stop_places_no_stop_order(self) -> None:
        self.exchange.fetch_positions.return_value = []
        self.exchange.fetch_ticker.return_value = {'last': 57.}
        with patch.object(self.service, 'market_order', return_value={'filled': 2, 'average': 57.}) as entry, \
             patch.object(self.service, 'set_stop') as stop:
            result = self.service.open_with_stop('htx', 'long', 2, None, None)
        entry.assert_called_once()
        stop.assert_not_called()
        self.assertIsNone(result['protectiveStop'])

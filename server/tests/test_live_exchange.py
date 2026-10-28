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

    def test_status_does_not_hold_registry_lock_during_network_call(self) -> None:
        import threading
        self.service.clients['okx'] = self.exchange
        self.service.markets['okx'] = self.market
        acquired = threading.Event()

        def positions(venue):
            def read_registry():
                self.service._get(venue)
                acquired.set()
            worker = threading.Thread(target=read_registry)
            worker.start()
            self.assertTrue(acquired.wait(1), 'Status blocked execution registry access')
            worker.join(1)
            return []

        with patch.object(self.service, 'positions', side_effect=positions):
            self.assertEqual(len(self.service.status()), 1)

    def test_selected_overview_skips_unrelated_network_calls(self) -> None:
        self.service.clients['okx'] = self.exchange
        self.service.markets['okx'] = self.market
        self.exchange.fetch_positions.return_value = []
        result = self.service.overview('okx', sections=('positions',))
        self.assertEqual(result['positions'], [])
        self.exchange.fetch_ticker.assert_not_called()
        self.exchange.fetch_balance.assert_not_called()
        self.exchange.fetch_open_orders.assert_not_called()

    def test_market_selector_supports_xag_and_stable_perpetuals(self) -> None:
        self.exchange.markets = {
            'XAG/USDT:USDT': {'symbol': 'XAG/USDT:USDT', 'base': 'XAG', 'quote': 'USDT', 'settle': 'USDT', 'swap': True, 'linear': True, 'active': True},
            'STABLE/USDT:USDT': {'symbol': 'STABLE/USDT:USDT', 'base': 'STABLE', 'quote': 'USDT', 'settle': 'USDT', 'swap': True, 'linear': True, 'active': True},
            'STABLE/USDT': {'symbol': 'STABLE/USDT', 'base': 'STABLE', 'quote': 'USDT', 'spot': True, 'active': True},
        }
        self.assertEqual(self.service._market(self.exchange, 'xag')['symbol'], 'XAG/USDT:USDT')
        self.assertEqual(self.service._market(self.exchange, 'stable')['symbol'], 'STABLE/USDT:USDT')

    def test_market_selector_rejects_an_unlisted_perpetual(self) -> None:
        self.exchange.markets = {}
        with self.assertRaisesRegex(ValueError, 'STABLE/USDT'):
            self.service._market(self.exchange, 'stable')

    def test_htx_rejects_stable_before_opening_a_connection(self) -> None:
        with self.assertRaisesRegex(ValueError, 'does not currently list'):
            self.service.connect('htx', 'key', 'secret', instrument='stable')

    def test_hyperliquid_uses_api_wallet_and_usdc_stable_market(self) -> None:
        market = {'symbol': 'STABLE/USDC:USDC', 'base': 'STABLE', 'quote': 'USDC',
                  'settle': 'USDC', 'contractSize': 1}
        self.exchange.fetch_balance.return_value = {'total': {'USDC': 25}}
        with patch.object(ccxt, 'hyperliquid', return_value=self.exchange) as adapter, patch.object(
            self.service, '_market', return_value=market
        ) as select_market:
            result = self.service.connect('hyperliquid', '0xwallet', 'agent-private-key', instrument='stable')
        credentials = adapter.call_args.args[0]
        self.assertEqual(credentials['walletAddress'], '0xwallet')
        self.assertEqual(credentials['privateKey'], 'agent-private-key')
        self.assertNotIn('apiKey', credentials)
        select_market.assert_called_once_with(self.exchange, 'stable')
        self.assertEqual((result['symbol'], result['usdtBalance']), ('STABLE/USDC:USDC', 25))

    def test_market_selector_finds_xyz_hip3_silver_market(self) -> None:
        self.exchange.id = 'hyperliquid'
        self.exchange.options = {}
        silver = {'symbol': 'XYZ-SILVER/USDC:USDC', 'base': 'XYZ-SILVER', 'baseId': '110001',
                  'quote': 'USDC', 'settle': 'USDC', 'swap': True, 'linear': True,
                  'active': True, 'baseName': 'xyz:SILVER', 'info': {'name': 'xyz:SILVER'}}
        self.exchange.markets = {silver['symbol']: silver}
        self.assertIs(self.service._market(self.exchange, 'silver'), silver)
        self.assertEqual(self.exchange.options['fetchMarkets']['hip3']['dexes'], ['xyz'])

    def test_hyperliquid_rejects_unlisted_xag(self) -> None:
        with self.assertRaisesRegex(ValueError, 'does not currently list an XAG'):
            self.service.connect('hyperliquid', '0xwallet', 'agent-private-key', instrument='xag')

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

    def test_conditional_order_snapshot_converts_contract_quantity(self) -> None:
        self.service.clients['htx'] = self.exchange
        self.service.markets['htx'] = {**self.market, 'contractSize': 0.1}
        with patch('server.exchanges.live_exchange.classic_conditional_orders', return_value=[
            dict(id='isolated:tpsl:1', side='sell', type='sl', amount=20, triggerPrice=54, marginMode='isolated')]):
            result = self.service.overview('htx', sections=('conditionalOrders',))
        self.assertEqual(result['conditionalOrders'][0]['quantity'], 2)
        self.assertEqual(result['conditionalOrders'][0]['triggerPrice'], 54)
        self.exchange.fetch_open_orders.assert_not_called()

    def test_conditional_order_failure_is_reported_separately(self) -> None:
        self.service.clients['htx'] = self.exchange
        self.service.markets['htx'] = self.market
        with patch('server.exchanges.live_exchange.classic_conditional_orders', side_effect=ValueError('private-secret')):
            result = self.service.overview('htx', sections=('conditionalOrders',))
        self.assertIn('conditionalOrders', result['errors'])
        self.assertNotIn('private-secret', str(result))

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

    def test_htx_positions_prefer_classic_hedge_rows_even_with_v5_balance(self) -> None:
        self.service.clients['htx'] = self.exchange
        self.service.markets['htx'] = {**self.market, 'id': 'XAG-USDT'}
        self.exchange.options = {}
        self.exchange.request.side_effect = [
            {'status': 'ok', 'data': [
                {'contract_code': 'XAG-USDT', 'direction': 'buy', 'volume': '3.32'},
                {'contract_code': 'XAG-USDT', 'direction': 'sell', 'volume': '23.68'},
            ]},
            {'status': 'ok', 'data': []},
        ]
        self.exchange.parse_position.side_effect = lambda row, market: {
            'side': 'long' if row['direction'] == 'buy' else 'short',
            'contracts': float(row['volume']),
            'marginMode': row['margin_mode'],
        }

        positions = self.service.positions('htx')

        self.assertEqual([position['side'] for position in positions], ['long', 'short'])
        self.exchange.fetch_positions.assert_not_called()

    def test_htx_positions_fall_back_to_v5_when_classic_is_unavailable(self) -> None:
        self.service.clients['htx'] = self.exchange
        self.service.markets['htx'] = self.market
        self.exchange.options = {}
        self.exchange.request.side_effect = ccxt.NotSupported('classic account unavailable')
        self.exchange.fetch_positions.return_value = [{'side': 'long', 'contracts': 2}]

        self.assertEqual(self.service.positions('htx'), [{'side': 'long', 'contracts': 2}])
        self.exchange.fetch_positions.assert_called_once_with([self.market['symbol']])

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

    def test_accepted_entry_and_close_notify_position_refresh(self) -> None:
        self.exchange.amount_to_precision.side_effect = lambda symbol, amount: amount
        self.exchange.create_order.return_value = {'id': 'accepted', 'amount': 2}
        callback = MagicMock()
        self.service.on_execution = callback
        self.service.market_order('htx', 'buy', 2)
        self.service.market_order('htx', 'sell', 2, reduce_only=True)
        self.assertEqual(callback.call_count, 2)
        callback.assert_called_with('htx')

    def test_close_targets_each_classic_margin_account(self) -> None:
        self.market['id'] = 'XAG-USDT'
        self.exchange.options = {'localAccountApi': 'classic'}
        self.exchange.amount_to_precision.side_effect = lambda symbol, amount: amount
        positions = [dict(side='long', contracts=amount, marginMode=mode,
                          info=dict(contract_code='XAG-USDT', margin_mode=mode,
                                    position_mode='dual_side', lever_rate=20))
                     for mode, amount in [('isolated', 23), ('cross', 6)]]
        self.exchange.request.return_value = {'status': 'ok', 'data': {'order_id_str': 'close-1'}}
        self.service.protective_orders['htx'] = 'other-stop'
        with patch.object(self.service, 'positions', return_value=positions):
            for mode, amount, endpoint in [('isolated', 23, 'swap_order'), ('cross', 6, 'swap_cross_order')]:
                result = self.service.close_position('htx', side='long', margin_mode=mode)
                self.assertTrue(result['closed'])
                args = self.exchange.request.call_args.args
                self.assertEqual(args[0], 'linear-swap-api/v1/' + endpoint)
                self.assertEqual(args[3]['volume'], amount)
                self.assertEqual(args[3]['direction'], 'sell')
                self.assertEqual(args[3]['offset'], 'close')
                self.assertEqual(args[3]['reduce_only'], 1)
        self.assertEqual(self.service.protective_orders['htx'], 'other-stop')
        self.exchange.create_order.assert_not_called()

    def test_close_missing_target_never_falls_back_to_other_position(self) -> None:
        with patch.object(self.service, 'positions', return_value=[dict(side='long', contracts=6, marginMode='cross')]), \
             patch.object(self.service, 'market_order') as order:
            result = self.service.close_position('htx', side='long', margin_mode='isolated')
        self.assertFalse(result['closed'])
        order.assert_not_called()

    def test_ambiguous_close_requires_target(self) -> None:
        with patch.object(self.service, 'positions', return_value=[
            dict(side='long', contracts=23, marginMode='isolated'),
            dict(side='long', contracts=6, marginMode='cross')]), \
             patch.object(self.service, 'market_order') as order:
            with self.assertRaisesRegex(ValueError, 'Multiple positions'):
                self.service.close_position('htx')
        order.assert_not_called()

    def test_classic_one_way_close_uses_reduce_only_both(self) -> None:
        self.market['id'] = 'XAG-USDT'
        self.exchange.amount_to_precision.side_effect = lambda symbol, amount: amount
        self.exchange.request.return_value = {'status': 'ok', 'data': {'order_id': 12}}
        position = dict(side='short', contracts=6, marginMode='cross', info=dict(
            contract_code='XAG-USDT', margin_mode='cross', position_mode='single_side', lever_rate=20))
        with patch.object(self.service, 'positions', return_value=[position]):
            self.service.close_position('htx', side='short', margin_mode='cross')
        params = self.exchange.request.call_args.args[3]
        self.assertEqual((params['direction'], params['offset'], params['reduce_only']), ('buy', 'both', 1))

    def test_targeted_unified_close_preserves_other_position_and_margin_mode(self) -> None:
        self.service.protective_orders['htx'] = 'other-stop'
        with patch.object(self.service, 'positions', return_value=[
            dict(side='long', contracts=23, marginMode='isolated'),
            dict(side='long', contracts=6, marginMode='cross')]), \
             patch.object(self.service, 'market_order', return_value={'id': 'close-2'}) as order:
            self.service.close_position('htx', side='long', margin_mode='cross')
        order.assert_called_once_with('htx', 'sell', 6, reduce_only=True, margin_mode='cross')
        self.assertEqual(self.service.protective_orders['htx'], 'other-stop')

    def test_classic_close_rejection_is_not_reported_as_success(self) -> None:
        self.market['id'] = 'XAG-USDT'
        self.exchange.amount_to_precision.side_effect = lambda symbol, amount: amount
        self.exchange.request.return_value = {'status': 'error', 'data': {}}
        position = dict(side='long', contracts=6, marginMode='cross', info=dict(
            contract_code='XAG-USDT', margin_mode='cross', position_mode='dual_side', lever_rate=20))
        with patch.object(self.service, 'positions', return_value=[position]):
            with self.assertRaisesRegex(RuntimeError, 'did not confirm'):
                self.service.close_position('htx', side='long', margin_mode='cross')
        self.exchange.create_order.assert_not_called()

    def test_update_protection_replaces_and_removes_orders(self) -> None:
        self.market['id'] = 'XAG-USDT'
        self.exchange.amount_to_precision.side_effect = lambda symbol, amount: amount
        self.exchange.price_to_precision.side_effect = lambda symbol, price: price
        self.exchange.fetch_positions.return_value = [{'contracts': 2, 'side': 'long', 'info': {'position_side': 'both'}}]
        self.exchange.fetch_ticker.return_value = {'last': 60.}
        self.exchange.create_order.return_value = {'id': 'new', 'amount': 2}
        open_orders = [{'algo_id': 'app-sl', 'type': 'sl', 'sl_trigger_price': '55'},
                       {'algo_id': 'app-tp', 'type': 'tp', 'tp_trigger_price': '65'}]
        self.exchange.contractPrivateGetV5AlgoOrderOpens.side_effect = lambda params: {'code': 200, 'data': list(open_orders)}
        def cancel(items):
            open_orders[:] = [row for row in open_orders if row['algo_id'] not in {item['algo_id'] for item in items}]
            return {'code': 200, 'data': [{'code': 200, 'algo_id': item['algo_id']} for item in items]}
        self.exchange.contractPrivatePostV5AlgoCancelOrders.side_effect = cancel
        self.service.update_protection('htx', 58., None)
        cancelled = {item['algo_id'] for item in self.exchange.contractPrivatePostV5AlgoCancelOrders.call_args.args[0]}
        self.assertEqual(cancelled, {'app-sl', 'app-tp'})
        self.assertEqual(self.exchange.create_order.call_count, 1)
        with self.assertRaisesRegex(ValueError, 'below the current price'):
            self.service.update_protection('htx', 61., None)

    def test_update_protection_places_nothing_when_htx_rejects_the_cancel(self) -> None:
        from server.exchanges.live_exchange import OrderStepError
        self.market['id'] = 'XAG-USDT'
        self.exchange.fetch_positions.return_value = [{'contracts': 2, 'side': 'long', 'info': {}}]
        self.exchange.fetch_ticker.return_value = {'last': 60.}
        self.exchange.contractPrivateGetV5AlgoOrderOpens.return_value = {'code': 200, 'data': [{'algo_id': 'a', 'type': 'sl', 'sl_trigger_price': '55'}]}
        self.exchange.contractPrivatePostV5AlgoCancelOrders.return_value = {'code': 200, 'data': [{'code': 1071, 'algo_id': 'a'}]}
        with self.assertRaisesRegex(OrderStepError, 'did not cancel'):
            self.service.update_protection('htx', 58., None)
        self.exchange.create_order.assert_not_called()

    def test_update_protection_targets_one_side_in_hedge_mode(self) -> None:
        self.market['id'] = 'XAG-USDT'
        self.exchange.amount_to_precision.side_effect = lambda symbol, amount: amount
        self.exchange.price_to_precision.side_effect = lambda symbol, price: price
        self.exchange.fetch_ticker.return_value = {'last': 60.}
        self.exchange.create_order.return_value = {'id': 'new-long-sl', 'amount': 2}
        positions = [{'contracts': 2, 'side': 'long', 'info': {'position_side': 'long'}},
                     {'contracts': 3, 'side': 'short', 'info': {'position_side': 'short'}}]
        orders = [{'algo_id': 'long-sl', 'type': 'sl', 'direction': 'sell', 'sl_trigger_price': '55'},
                  {'algo_id': 'short-sl', 'type': 'sl', 'direction': 'buy', 'sl_trigger_price': '65'}]
        self.exchange.contractPrivateGetV5AlgoOrderOpens.side_effect = lambda params: {'code': 200, 'data': list(orders)}
        def cancel(items):
            orders[:] = [row for row in orders if row['algo_id'] not in {item['algo_id'] for item in items}]
            return {'code': 200, 'data': [{'code': 200, 'algo_id': item['algo_id']} for item in items]}
        self.exchange.contractPrivatePostV5AlgoCancelOrders.side_effect = cancel
        with patch.object(self.service, 'positions', return_value=positions), \
             patch.object(self.service, '_htx_open_position', return_value=('long', 2)):
            self.service.update_protection('htx', 58., None, 'long')

        cancelled = {item['algo_id'] for item in self.exchange.contractPrivatePostV5AlgoCancelOrders.call_args.args[0]}
        self.assertEqual(cancelled, {'long-sl'})
        self.assertEqual([row['algo_id'] for row in orders], ['short-sl'])
        self.assertEqual(self.exchange.create_order.call_args.args[3], 2)

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
        self.service.clients['okx'], self.service.markets['okx'] = self.exchange, self.market
        self.exchange.set_margin_mode.side_effect = Exception('margin mode already isolated, no need to change')
        self.service.prepare_account('okx', 12)
        self.exchange.set_leverage.assert_called_once_with(12, 'XAG/USDT:USDT', {})
        self.exchange.set_leverage.side_effect = Exception('leverage exceeds the maximum allowed')
        with self.assertRaisesRegex(OrderStepError, 'Setting 12x leverage failed.*maximum'):
            self.service.prepare_account('okx', 12)

    def test_htx_hedge_mode_sets_leverage_for_each_side(self) -> None:
        self.exchange.set_leverage.side_effect = [Exception('{"code":1066,"message":"position_side cannot be empty."}'), None, None]
        self.service.prepare_account('htx', 12)
        sides = [call.args[2]['position_side'] for call in self.exchange.set_leverage.call_args_list]
        self.assertEqual(sides, ['both', 'long', 'short'])

    def test_htx_stop_retries_with_hedge_position_side(self) -> None:
        self.exchange.amount_to_precision.side_effect = lambda symbol, amount: amount
        self.exchange.price_to_precision.side_effect = lambda symbol, price: price
        self.exchange.create_order.side_effect = [Exception('{"code":1067,"message":"The position_side field is invalid."}'), {'id': '9', 'amount': 2}]
        self.assertEqual(self.service.set_stop('htx', 'long', 2, 56.)['id'], '9')
        sides = [call.args[5]['position_side'] for call in self.exchange.create_order.call_args_list]
        self.assertEqual(sides, ['both', 'long'])
        params = self.exchange.create_order.call_args.args[5]
        self.assertEqual(params['stopLossPrice'], 56.)
        self.assertNotIn('triggerPrice', params)
        self.exchange.create_order.side_effect = None
        self.exchange.create_order.return_value = {'id': '10', 'amount': 2}
        self.service.set_stop('htx', 'long', 2, 70., take_profit=True)
        self.assertEqual(self.exchange.create_order.call_args.args[5]['takeProfitPrice'], 70.)

    def test_htx_stop_uses_reported_position_side_and_size(self) -> None:
        self.exchange.amount_to_precision.side_effect = lambda symbol, amount: amount
        self.exchange.price_to_precision.side_effect = lambda symbol, price: price
        self.exchange.fetch_positions.return_value = [{'contracts': 1.5, 'side': 'long', 'info': {'position_side': 'long'}}]
        self.exchange.create_order.return_value = {'id': '11', 'amount': 1.5}
        self.service.set_stop('htx', 'long', 2, 56.)
        call = self.exchange.create_order.call_args
        self.assertEqual((call.args[3], call.args[5]['position_side']), (1.5, 'long'))

    def test_htx_entry_learns_hedge_mode_from_1497_reply(self) -> None:
        self.exchange.amount_to_precision.side_effect = lambda symbol, amount: amount
        self.exchange.create_order.side_effect = [
            {'id': None, 'info': {}},
            {'id': '5', 'amount': 25}]
        self.exchange.last_json_response = {'code': 1497, 'message': 'Position mode parameter passing error!'}
        self.assertEqual(self.service.market_order('htx', 'buy', .25)['id'], '5')
        sides = [call.args[5]['position_side'] for call in self.exchange.create_order.call_args_list]
        self.assertEqual(sides, ['both', 'long'])
        self.exchange.create_order.side_effect = None
        self.exchange.create_order.return_value = {'id': '6', 'amount': 25}
        self.service.market_order('htx', 'sell', .25, reduce_only=True)
        self.assertEqual(self.exchange.create_order.call_args.args[5]['position_side'], 'long')

    def test_htx_sends_isolated_margin_with_leverage_and_orders(self) -> None:
        import ccxt
        self.exchange.set_margin_mode.side_effect = ccxt.NotSupported('htx setMarginMode() is not supported yet')
        self.service.prepare_account('htx', 12)
        self.exchange.set_margin_mode.assert_not_called()
        self.exchange.set_leverage.assert_called_once_with(12, 'XAG/USDT:USDT', {'marginMode': 'isolated', 'position_side': 'both'})
        self.exchange.amount_to_precision.side_effect = lambda symbol, amount: amount
        self.exchange.price_to_precision.side_effect = lambda symbol, price: price
        self.exchange.create_order.return_value = {'id': '1', 'amount': 2}
        self.service.market_order('htx', 'buy', 2)
        self.service.set_stop('htx', 'long', 2, 56.)
        for call in self.exchange.create_order.call_args_list:
            self.assertEqual(call.args[5]['marginMode'], 'isolated')

    def test_manual_entry_checks_position_once_before_preparing_account(self) -> None:
        self.exchange.fetch_positions.return_value = []
        self.exchange.fetch_ticker.return_value = {'last': 57.}
        with patch.object(self.service, 'prepare_account') as prepare, \
             patch.object(self.service, 'market_order', return_value={'filled': 2}):
            self.service.open_with_stop('htx', 'long', 2, None, leverage=12)
        prepare.assert_called_once_with('htx', 12)
        self.exchange.fetch_positions.assert_called_once()

    def test_existing_position_prevents_manual_leverage_change(self) -> None:
        self.exchange.fetch_positions.return_value = [{'contracts': 2}]
        with patch.object(self.service, 'prepare_account') as prepare, \
             patch.object(self.service, 'market_order') as entry:
            with self.assertRaisesRegex(ValueError, 'existing position'):
                self.service.open_with_stop('htx', 'long', 2, None, leverage=12)
        prepare.assert_not_called()
        entry.assert_not_called()

    def test_order_without_stop_places_no_stop_order(self) -> None:
        self.exchange.fetch_positions.return_value = []
        self.exchange.fetch_ticker.return_value = {'last': 57.}
        with patch.object(self.service, 'market_order', return_value={'filled': 2, 'average': 57.}) as entry, \
             patch.object(self.service, 'set_stop') as stop:
            result = self.service.open_with_stop('htx', 'long', 2, None, None)
        entry.assert_called_once()
        stop.assert_not_called()
        self.assertIsNone(result['protectiveStop'])

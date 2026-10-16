import asyncio
import json
import unittest
import ccxt
from unittest.mock import AsyncMock, MagicMock, patch

from server.exchanges.exchange_stream import ExchangeStreams, classic_auth
from server.exchanges.htx_account import classic_balance, classic_positions, rejection_reason, normalize_htx_balance
from server.exchanges.live_exchange import LiveExchange


class HTXAccountTests(unittest.TestCase):
    def test_v5_available_field_is_recognized_without_using_total_equity(self) -> None:
        balance = {'total': {'USDT': 100}, 'free': {'USDT': None},
                   'info': {'data': {'details': [{'currency': 'USDT', 'available': '4.96', 'initial_margin': '20'}]}}}
        result = normalize_htx_balance(balance)
        self.assertEqual(result['free']['USDT'], 4.96)
        self.assertEqual(result['used']['USDT'], 20)
        self.assertIsNone(balance['free']['USDT'])

    def test_v5_zero_available_margin_is_preserved(self) -> None:
        balance = {'total': {'USDT': 100}, 'info': {'details': [{'currency': 'USDT', 'available_margin': '0', 'available': '50'}]}}
        self.assertEqual(normalize_htx_balance(balance)['free']['USDT'], 0)

    def test_v5_authentication_rejection_can_connect_classic_account(self) -> None:
        exchange = MagicMock()
        exchange.options = {}
        exchange.fetch_balance.side_effect = ccxt.AuthenticationError('private-key')
        exchange.request.side_effect = [
            {'status': 'ok', 'data': [{'margin_asset': 'USDT', 'margin_balance': '100', 'margin_available': '60'}]},
            {'status': 'ok', 'data': []}]
        balance = LiveExchange.account_balance(exchange, 'htx')
        self.assertEqual(balance['total']['USDT'], 100)
        self.assertEqual(exchange.options['localAccountApi'], 'classic')

    def test_failed_classic_fallback_does_not_accept_rejected_credentials(self) -> None:
        exchange = MagicMock()
        exchange.options = {}
        exchange.fetch_balance.side_effect = ccxt.AuthenticationError('private-key')
        exchange.request.side_effect = ccxt.AuthenticationError('private-secret')
        with self.assertRaises(ValueError) as caught:
            LiveExchange.account_balance(exchange, 'htx')
        self.assertIn('V5:', str(caught.exception))
        self.assertIn('Classic:', str(caught.exception))
        self.assertNotIn('private-key', str(caught.exception))
        self.assertNotIn('private-secret', str(caught.exception))
        self.assertNotIn('localAccountApi', exchange.options)

    def test_rejected_v5_response_is_not_accepted_as_an_empty_balance(self) -> None:
        exchange = MagicMock()
        exchange.options = {}
        exchange.fetch_balance.return_value = {'info': {'code': 401}, 'total': {}}
        exchange.request.side_effect = ccxt.AuthenticationError('private-secret')
        with self.assertRaisesRegex(ValueError, '401'):
            LiveExchange.account_balance(exchange, 'htx')

    def test_diagnostic_exposes_only_fixed_reason_and_allowed_code(self) -> None:
        error = ccxt.AuthenticationError('htx {"err_code":403,"err_msg":"Signature not valid: IP address private-secret", "AccessKeyId":"private-key"}')
        reason = rejection_reason(error)
        self.assertIn('IP-address', reason)
        self.assertIn('403', reason)
        self.assertNotIn('private-secret', reason)
        self.assertNotIn('private-key', reason)

    def test_empty_v5_balance_selects_classic_and_sums_account_modes(self) -> None:
        exchange = MagicMock()
        exchange.options = {}
        exchange.fetch_balance.return_value = {'total': {}}
        exchange.request.side_effect = [
            {'status': 'ok', 'data': [{'margin_asset': 'USDT', 'margin_balance': '100', 'margin_available': '60', 'margin_position': '35', 'margin_frozen': '5'}]},
            {'status': 'ok', 'data': [{'margin_asset': 'USDT', 'margin_balance': '50', 'margin_available': '40', 'margin_position': '10'}]}]
        balance = LiveExchange.account_balance(exchange, 'htx')
        self.assertEqual(balance['total']['USDT'], 150)
        self.assertEqual(balance['free']['USDT'], 100)
        self.assertEqual(balance['used']['USDT'], 50)
        self.assertEqual(exchange.options['localAccountApi'], 'classic')
        self.assertIn('manage orders on HTX', LiveExchange.execution_error(exchange))

    def test_classic_positions_query_both_modes_and_filter_contract(self) -> None:
        exchange = MagicMock()
        exchange.request.side_effect = [
            {'status': 'ok', 'data': [{'contract_code': 'XAG-USDT', 'volume': 12}, {'contract_code': 'BTC-USDT', 'volume': 2}]},
            {'status': 'ok', 'data': [{'contract_code': 'XAG-USDT', 'volume': 3}]}]
        exchange.parse_position.side_effect = lambda row, market: row
        positions = classic_positions(exchange, {'id': 'XAG-USDT'})
        self.assertEqual([p['margin_mode'] for p in positions], ['isolated', 'cross'])
        self.assertEqual([p['volume'] for p in positions], [12, 3])

    def test_classic_failed_account_query_does_not_become_zero_balance(self) -> None:
        exchange = MagicMock()
        exchange.request.return_value = {'status': 'error', 'err_msg': 'private-secret'}
        with self.assertRaises(ValueError) as caught:
            classic_balance(exchange)
        self.assertNotIn('private-secret', str(caught.exception))

    def test_classic_auth_is_deterministic_and_does_not_include_secret(self) -> None:
        message = classic_auth('test-key', 'private-secret', '2026-10-16T00:00:00')
        self.assertEqual(message['op'], 'auth')
        self.assertEqual(message['SignatureVersion'], '2')
        self.assertNotIn('private-secret', json.dumps(message))
        self.assertEqual(message, classic_auth('test-key', 'private-secret', '2026-10-16T00:00:00'))


class ExchangeStreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_shared_feed_streams_market_and_closes_after_last_subscriber(self) -> None:
        source = MagicMock(apiKey='private-key', secret='private-secret', password=None)
        source.options = {}
        market = {'symbol': 'XAG/USDT:USDT', 'contractSize': 0.1}
        service = MagicMock()
        service.clients = {'htx': source}
        service._get.return_value = source, market
        service.overview.return_value = dict(market={'last': 30}, balance={'total': 100}, positions=[], orders=[], errors={})
        client = MagicMock()
        client.has = {'watchTicker': True}
        client.close = AsyncMock()
        delivered = False

        async def ticker(symbol):
            nonlocal delivered
            if delivered:
                await asyncio.Future()
            delivered = True
            return {'last': 32, 'info': {'secret': 'private-secret'}}

        client.watch_ticker = ticker
        streams = ExchangeStreams(service)
        with patch('server.exchanges.exchange_stream.ccxtpro.htx', return_value=client) as factory:
            first, second = streams.events('htx'), streams.events('htx')
            await anext(first)
            await anext(second)
            try:
                for _ in range(5):
                    event = await asyncio.wait_for(anext(first), 3)
                    payload = json.loads(event.removeprefix('data: '))
                    if payload['market'] and payload['market'].get('last') == 32:
                        break
                self.assertEqual(payload['market']['last'], 32)
                self.assertEqual(payload['streams']['market'], 'live')
                self.assertNotIn('private-secret', event)
                self.assertNotIn('book', payload)
                client.watch_order_book.assert_not_called()
                factory.assert_called_once()
                await first.aclose()
                client.close.assert_not_awaited()
            finally:
                await first.aclose()
                await second.aclose()
                await streams.close()
            client.close.assert_awaited_once()
            self.assertEqual(streams.feeds, {})

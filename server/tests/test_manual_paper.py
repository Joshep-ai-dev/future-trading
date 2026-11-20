import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import MagicMock, patch

import pandas as pd
from pydantic import ValidationError

from server.app import ManualPaperOrder, ManualPaperProtection, PaperStartRequest
from server.paper.paper_trading import PaperTrading


class ManualPaperTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 1800000600
        self.price = 100.
        index = pd.date_range(end=pd.Timestamp(self.now-60, unit='s', tz='UTC'), periods=30, freq='min')
        self.frame = pd.DataFrame(dict(open=100., high=101., low=99., close=100., volume=1.), index=index)
        self.feed = lambda limit: [dict(time=self.now//60*60, open=self.price, high=self.price,
                                      low=self.price, close=self.price, volume=1.)]
        refresh = MagicMock()
        refresh.refresh.return_value = dict(running=False, error=None)
        self.service = PaperTrading(Path(self.temp.name)/'paper.json', loader=lambda *a, **k:(self.frame, {}),
                                    now=lambda:self.now, live_fetch=self.feed, refresh=refresh)
        self.request = PaperStartRequest(execution_mode='manual', strategy='none', capital=1000,
                                         entry_timeframe='1m', bb_reversal={})
        self.service.begin(self.request)

    def order(self, **values):
        request = ManualPaperOrder(direction='long', quantity=2, leverage=2, request_id='one', **values)
        return self.service.manual_order(request)

    def test_long_open_close_realizes_virtual_pnl_and_persists(self) -> None:
        state = self.order()['session']
        self.assertEqual(state['executionMode'], 'manual')
        self.assertEqual(state['openPosition']['entry_price'], 100)
        self.assertEqual(state['balance'], 1000)
        self.price = 110
        self.service.update_quote()
        self.assertEqual(self.service.status()['session']['displayEquity'], 1020)
        closed = self.service.manual_close()['session']
        self.assertEqual(closed['balance'], 1020)
        self.assertIsNone(closed['openPosition'])
        self.assertEqual(closed['trades'][0]['pnl'], 20)
        restored = PaperTrading(self.service.path, now=lambda:self.now)
        self.assertEqual(restored.status()['session']['balance'], 1020)

    def test_short_profit_stop_and_target_are_virtual(self) -> None:
        self.service.manual_order(ManualPaperOrder(direction='short', quantity=2, leverage=2,
                                 stop_price=105, take_profit_price=90, request_id='short'))
        self.price = 89
        self.service.update_quote()
        self.assertEqual(self.service.state['trades'][0]['exit_reason'], 'take_profit')
        self.assertEqual(self.service.state['balance'], 1022)

    def test_long_stop_and_isolated_liquidation(self) -> None:
        self.order(stop_price=95)
        self.price = 94
        self.service.update_quote()
        self.assertEqual(self.service.state['balance'], 988)
        self.assertEqual(self.service.state['trades'][0]['exit_reason'], 'stop_loss')
        self.price = 100
        self.service.manual_order(ManualPaperOrder(direction='long', quantity=10, leverage=10, request_id='two'))
        self.price = 70
        self.service.update_quote()
        self.assertEqual(self.service.state['balance'], 888)
        self.assertEqual(self.service.state['trades'][-1]['exit_reason'], 'liquidation')

    def test_duplicate_retry_does_not_open_another_trade(self) -> None:
        self.order()
        self.order()
        self.assertEqual(self.service.state['openPosition']['quantity'], 2)
        self.assertEqual(self.service.state['manualRequests'], ['one'])

    def test_bad_margin_protection_and_stale_prices_are_rejected(self) -> None:
        for values in (dict(quantity=100, leverage=1), dict(stop_price=110), dict(take_profit_price=90)):
            request = dict(direction='long', quantity=2, leverage=2, request_id='bad')
            request.update(values)
            with self.assertRaises(ValueError):
                self.service.manual_order(ManualPaperOrder(**request))
        self.service.live_fetch = lambda limit:[dict(time=self.now-300, close=100)]
        with self.assertRaises(ValueError):
            self.order()
        self.assertIsNone(self.service.state['openPosition'])

    def test_manual_cannot_take_over_bot_or_reset_open_position(self) -> None:
        self.service.state['executionMode'] = 'bot'
        with self.assertRaises(ValueError):
            self.order()
        self.service.state['executionMode'] = 'manual'
        self.order()
        self.service.set_running(False)
        with self.assertRaises(ValueError):
            self.service.begin(self.request)

    def test_live_dataset_uses_its_public_api_and_sync(self) -> None:
        market = 'dataset:'+'a'*64
        self.service.state['settings']['market'] = market
        with patch('server.market.paper_feed.dataset_minutes', return_value=self.feed(300)) as feed, \
             patch('server.market.dataset_sync.sync_dataset') as sync:
            self.order()
            self.service.update_quote()
            self.service.cycle()
        feed.assert_called_with(market)
        sync.assert_called_once_with(market)

    def test_pause_keeps_manual_position_protection_active(self) -> None:
        self.order(stop_price=95)
        self.service.set_running(False)
        self.price = 94
        self.service.update_quote()
        self.assertIsNone(self.service.state['openPosition'])
        self.assertEqual(self.service.state['trades'][0]['exit_reason'], 'stop_loss')

    def test_mark_to_market_does_not_start_strategy_runner(self) -> None:
        self.order()
        with patch('server.paper.paper_trading.get_strategy', side_effect=AssertionError('No bot in manual mode')):
            self.service.cycle()
            self.service.update_quote()
        self.assertEqual(self.service.state['executionMode'],'manual')

    def test_replay_and_non_finite_manual_orders_are_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            PaperStartRequest(execution_mode='manual', paper_mode='replay')
        with self.assertRaises(ValidationError):
            ManualPaperOrder(direction='long', quantity=float('nan'), request_id='bad')

    def test_edit_and_remove_virtual_protection(self) -> None:
        self.order(stop_price=95)
        self.assertEqual(self.service.manual_protection(), dict(stop=95, takeProfit=None))
        self.service.set_manual_protection(ManualPaperProtection(stop_price=96, take_profit_price=110))
        self.assertEqual(self.service.manual_protection(), dict(stop=96, takeProfit=110))
        with self.assertRaises(ValueError):
            self.service.set_manual_protection(ManualPaperProtection(stop_price=101))
        self.service.set_manual_protection(ManualPaperProtection())
        self.assertEqual(self.service.manual_protection(), dict(stop=None, takeProfit=None))

    def test_session_change_during_quote_fetch_cannot_fill_wrong_market(self) -> None:
        original = self.service.state
        def change_market(market):
            self.service.state = {**original, 'settings':{**original['settings'], 'market':'dataset:'+'b'*64}}
            return 100., self.now
        with patch.object(self.service, 'manual_price', side_effect=change_market), self.assertRaises(ValueError):
            self.order()
        self.assertIsNone(self.service.state['openPosition'])

    def test_paused_live_bot_position_can_be_closed_without_resetting_funds(self) -> None:
        self.order()
        self.service.state['executionMode'] = 'bot'
        with self.assertRaises(ValueError):
            self.service.manual_close()
        self.service.state['running'] = False
        self.price = 105
        result = self.service.manual_close()['session']
        self.assertEqual(result['executionMode'], 'manual')
        self.assertEqual(result['balance'], 1010)
        self.assertIsNone(result['openPosition'])

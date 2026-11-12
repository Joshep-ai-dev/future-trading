from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock

from server.paper.paper_trading import PaperTrading
from server.strategies.registry import STRATEGIES, get_strategy
from server.strategies.strategy import BacktestRequest


class RemovedStrategyTests(unittest.TestCase):
    def test_removed_strategies_are_not_registered(self):
        self.assertEqual(STRATEGIES, {})
        for key in ('bb_outer_reversal', 'ml_directional', 'ml_ensemble', 'rl_ppo'):
            with self.subTest(key=key), self.assertRaises(ValueError):
                get_strategy(key)

    def test_api_rejects_removed_strategy_requests(self):
        for key in ('bb_outer_reversal', 'ml_directional', 'ml_ensemble', 'rl_ppo'):
            with self.subTest(key=key), self.assertRaises(ValueError):
                BacktestRequest(start_date='2026-01-01', end_date='2026-01-02', strategy=key)
        self.assertEqual(BacktestRequest(start_date='2026-01-01', end_date='2026-01-02').strategy, 'none')

    def test_old_paper_sessions_are_retained_but_cannot_resume(self):
        for key in ('bb_outer_reversal', 'ml_directional', 'ml_ensemble', 'rl_ppo'):
            with self.subTest(key=key), TemporaryDirectory() as folder:
                state = dict(settings=dict(strategy=key, bb_reversal={}), running=True)
                store = Mock()
                store.load.return_value = state
                service = PaperTrading(Path(folder)/'paper.json', store=store)
                self.assertIs(service.state, state)
                self.assertFalse(service.state['running'])
                self.assertIsNone(service.status()['session'])
                self.assertIn('removed strategy', service.status()['error'])
                with self.assertRaisesRegex(ValueError, 'removed'):
                    service.set_running(True)


    def test_live_bot_rejects_start_before_contacting_exchange(self):
        from server.exchanges.live_exchange import AutomaticLiveBot
        service = Mock()
        bot = AutomaticLiveBot(service)
        request = BacktestRequest(start_date='2026-01-01', end_date='2026-01-02')
        with self.assertRaisesRegex(ValueError, 'No trading strategies'):
            bot.start('okx', request)
        service.execution_client.assert_not_called()

    def test_api_gate_explains_empty_workspace(self):
        from fastapi import HTTPException
        from server.app import require_trading_strategy
        with self.assertRaises(HTTPException) as caught:
            require_trading_strategy()
        self.assertEqual(caught.exception.status_code, 409)
        self.assertIn('No trading strategies', caught.exception.detail)

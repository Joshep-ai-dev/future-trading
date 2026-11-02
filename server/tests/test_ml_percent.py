import unittest
from dataclasses import replace
from unittest.mock import patch

import numpy as np
import pandas as pd

from server.strategies.execution import ExecutionSettings, run_signal_backtest
from server.strategies.ml.labels import LONG, NONE, SHORT, triple_barrier
from server.strategies.ml.strategy import MLSettings, exit_plan, prepare, run_ml_backtest
from server.tests.test_ml_strategy import bars, market


class PercentExitTests(unittest.TestCase):
    def test_defaults_and_validation(self):
        settings = MLSettings(exit_mode='percent')
        self.assertEqual((settings.exit_mode, settings.take_profit_pct, settings.stop_loss_pct), ('percent', 1., .65))
        self.assertEqual((settings.min_atr, settings.min_target), (.03, 0.))
        for field in ('take_profit_pct', 'stop_loss_pct'):
            for value in (0., -1., 100., np.nan, np.inf):
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    MLSettings(exit_mode='percent', **{field: value})
        for field in ('trailing', 'let_profit_run', 'reverse_on_signal'):
            with self.subTest(field=field), self.assertRaises(ValueError):
                MLSettings(exit_mode='percent', **{field: True})

    def test_percent_plan_uses_price_instead_of_atr(self):
        probabilities = pd.DataFrame(dict(p_long=[.8, .1], p_short=[.1, .8], p_none=[.1, .1]))
        plan = exit_plan(probabilities, pd.Series([.01, 50.]), MLSettings(exit_mode='percent'), pd.Series([100., 200.]))
        for side in ('long', 'short'):
            np.testing.assert_allclose(plan[f'{side}_target'], [1., 2.])
            np.testing.assert_allclose(plan[f'{side}_stop'], [.65, 1.3])
            self.assertTrue(np.isnan(plan[f'{side}_trail']).all())

    def test_labels_match_long_short_and_double_touch_exit_rules(self):
        for future, expected in (([100, 101.1, 99.8, 101], LONG),
                                 ([100, 100.2, 98.9, 99], SHORT),
                                 ([100, 101.1, 98.9, 100], NONE)):
            frame = bars([[100, 100, 100, 100], future])
            labels = triple_barrier(frame, frame.close/100, 1, 1., .65)
            self.assertEqual(labels.iloc[0], expected)
            self.assertTrue(np.isnan(labels.iloc[-1]))

    def test_execution_targets_reference_actual_fill_and_ignore_leverage(self):
        for side in (1, -1):
            for leverage in (1., 10.):
                with self.subTest(side=side, leverage=leverage):
                    frame = bars([[100, 100, 100, 100],
                                  [100, 101.2, 99.8, 101] if side == 1 else [100, 100.1, 98.8, 99]])
                    settings = ExecutionSettings(leverage=leverage, take_profit_pct=1., stop_loss_pct=.65)
                    result = run_signal_backtest(frame, np.array([side, 0]), np.ones(2), np.ones(2), settings,
                                                 slippage=.1, fee_bps=5)
                    trade = result['trades'].iloc[0]
                    self.assertEqual(trade.exit_reason, 'take_profit')
                    self.assertAlmostEqual(trade.target, trade.entry_price*(1+side*.01))
                    self.assertAlmostEqual(trade.initial_stop, trade.entry_price*(1-side*.0065))

    def test_stops_and_double_touch_are_conservative(self):
        for side in (1, -1):
            frame = bars([[100, 100, 100, 100], [100, 101.5, 98.5, 100]])
            result = run_signal_backtest(frame, np.array([side, 0]), np.ones(2), np.ones(2),
                                         ExecutionSettings(take_profit_pct=1., stop_loss_pct=.65))
            trade = result['trades'].iloc[0]
            self.assertEqual(trade.exit_reason, 'stop')
            self.assertAlmostEqual(trade.exit_price, 100*(1-side*.0065))

    def test_small_price_percentages_are_not_expanded_by_absolute_tick_floor(self):
        frame = bars([[.1, .1, .1, .1], [.1, .1011, .0999, .101]])
        result = run_signal_backtest(frame, np.array([1, 0]), np.ones(2), np.ones(2),
                                     ExecutionSettings(min_tick=.01, take_profit_pct=1., stop_loss_pct=.65))
        self.assertAlmostEqual(result['trades'].iloc[0].target, .101)

    def test_cache_identity_changes_with_percentages(self):
        settings = MLSettings(exit_mode='percent')
        self.assertNotEqual(settings.model_key(), replace(settings, stop_loss_pct=.7).model_key())
        self.assertNotEqual(settings.model_key(), replace(settings, take_profit_pct=2.).model_key())
        self.assertNotEqual(settings.model_key(), replace(settings, exit_mode='fixed').model_key())

    def test_training_uses_percentage_barriers(self):
        frame = market(800)
        with patch('server.strategies.ml.strategy.walk_forward'), \
             patch('server.strategies.ml.strategy.triple_barrier', wraps=triple_barrier) as labels:
            prepare(frame, MLSettings(exit_mode='percent'), start=frame.index[600])
        pd.testing.assert_series_equal(labels.call_args.args[1], frame.close/100)
        self.assertEqual(labels.call_args.args[3:], (1., .65))

    def test_end_to_end_percent_backtest_uses_the_requested_exits(self):
        from types import SimpleNamespace

        frame = bars([[100, 100, 100, 100], [100, 101.1, 99.8, 101], [101, 101.1, 100.9, 101]])
        probabilities = pd.DataFrame(dict(p_long=[.9, .05, .05], p_short=[.05, .05, .05],
                                          p_none=[.05, .9, .9]), index=frame.index)
        walk = SimpleNamespace(probabilities=probabilities, folds=[], importance={})
        with patch('server.strategies.ml.strategy.walk_forward', return_value=walk):
            result = run_ml_backtest(frame, MLSettings(horizon=1, exit_mode='percent', min_atr=0.), initial_capital=1000, leverage=1)
        self.assertEqual(len(result['trades']), 1)
        self.assertEqual(result['trades'].iloc[0].exit_reason, 'take_profit')
        self.assertAlmostEqual(result['trades'].iloc[0].target, 101.)
        self.assertEqual(result['report']['exitMode'], 'percent')

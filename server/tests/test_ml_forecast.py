import unittest
from dataclasses import replace
from unittest.mock import patch

import numpy as np
import pandas as pd

from server.strategies.execution import ExecutionSettings, run_signal_backtest
from server.strategies.ml.forecast import ForecastModel
from server.strategies.ml.strategy import MLSettings, Prepared, execute, exit_plan, prepare, run_ml_backtest
from server.strategies.ml.walk_forward import fold_cache
from server.tests.test_ml_strategy import bars, market


class ForecastTests(unittest.TestCase):
    def setUp(self):
        fold_cache.items.clear()
        self.addCleanup(fold_cache.items.clear)

    def test_one_model_predicts_all_three_outputs_and_vote_fractions(self):
        rng = np.random.default_rng(7)
        features = pd.DataFrame(dict(a=rng.normal(size=600), b=np.nan))
        targets = pd.DataFrame(dict(up=2+features.a.clip(lower=0), down=2-features.a.clip(upper=0), trend=features.a))
        model = ForecastModel.fit(features, targets, slice(0, 500))
        output = model.forecast_rows(features, slice(500, 600))
        self.assertEqual(output.shape, (100, 3))
        self.assertTrue(np.isfinite(output).all())
        self.assertTrue((output[:, :2] >= 0).all())
        self.assertTrue((output[:, 2] <= output[:, 0]).all())
        self.assertTrue((output[:, 2] >= -output[:, 1]).all())
        np.testing.assert_allclose(model.predict_rows(features, slice(500, 600)).sum(axis=1), 1.)

    def test_training_targets_do_not_depend_on_fixed_exit_percentages(self):
        frame = market(800)
        settings = MLSettings(horizon=6)
        with patch('server.strategies.ml.strategy.walk_forward') as walk:
            first = prepare(frame, settings)
            second = prepare(frame, replace(settings, take_profit_pct=5., stop_loss_pct=2.))
        pd.testing.assert_series_equal(first.labels, second.labels)
        pd.testing.assert_frame_equal(first.forecast_targets, second.forecast_targets)
        self.assertIsNotNone(walk.call_args.kwargs['forecast_targets'])
        self.assertTrue(first.forecast_targets.iloc[-6:].isna().all().all())

    def test_future_changes_cannot_change_earlier_predictions(self):
        frame = market(1800)
        settings = MLSettings(horizon=6, train_bars=700, retrain_every=200)
        first = prepare(frame, settings, start=frame.index[900])
        changed = frame.copy()
        changed.iloc[1400:, :4] *= 1.2
        fold_cache.items.clear()
        second = prepare(changed, settings, start=frame.index[900])
        columns = ['p_long', 'p_short', 'forecast_up', 'forecast_down', 'forecast_trend']
        pd.testing.assert_frame_equal(first.walk.probabilities[columns].iloc[:1400],
                                      second.walk.probabilities[columns].iloc[:1400])

    def test_no_forecast_means_no_fixed_exit_fallback(self):
        probabilities = pd.DataFrame(dict(p_long=[.8], p_short=[.1], p_none=[.1]))
        plan = exit_plan(probabilities, pd.Series([1.]), MLSettings())
        self.assertTrue(np.isnan(plan['long_target']).all())
        self.assertTrue(np.isnan(plan['long_stop']).all())

    def test_entries_require_atr_strictly_above_point_zero_three(self):
        from types import SimpleNamespace

        frame = bars([[100, 100.001, 99.999, 100]]*5)
        atr = pd.Series([np.nan, .029, .03, np.inf, .031], index=frame.index)
        probabilities = pd.DataFrame(dict(p_long=.9, p_short=.05, p_none=.05,
                                          forecast_up=2., forecast_down=1., forecast_trend=1.), index=frame.index)
        walk = SimpleNamespace(probabilities=probabilities, folds=[], importance={})
        prepared = Prepared(frame, atr, 1, pd.Series(1., index=frame.index), 0, walk)
        result = execute(prepared, MLSettings(min_atr=.03), initial_capital=1000, leverage=1)
        self.assertEqual(result['bars'].long_signal.tolist(), [False, False, False, False, True])
        self.assertEqual(result['open_position']['entry_time'], frame.index[-1])

    def test_custom_atr_threshold_can_be_lower_or_higher_than_default(self):
        from types import SimpleNamespace

        frame = bars([[100, 100.001, 99.999, 100]]*2)
        probabilities = pd.DataFrame(dict(p_long=.9, p_short=.05, p_none=.05,
                                          forecast_up=2., forecast_down=1., forecast_trend=1.), index=frame.index)
        walk = SimpleNamespace(probabilities=probabilities, folds=[], importance={})
        prepared = Prepared(frame, pd.Series(.025, index=frame.index), 1,
                            pd.Series(1., index=frame.index), 0, walk)
        for threshold, expected in ((.02, True), (.025, False), (.04, False)):
            with self.subTest(threshold=threshold):
                result = execute(prepared, MLSettings(min_atr=threshold), initial_capital=1000, leverage=1)
                self.assertEqual(bool(result['bars'].long_signal.any()), expected)

    def test_flat_prices_do_not_manufacture_directional_trades(self):
        index = pd.date_range('2026-01-01', periods=1200, freq='5min', tz='UTC')
        frame = pd.DataFrame(dict(open=100., high=100.1, low=99.9, close=100., volume=1.), index=index)
        result = run_ml_backtest(frame, MLSettings(train_bars=500, retrain_every=200),
                                 initial_capital=1000, leverage=1, start=index[600])
        self.assertTrue(result['trades'].empty)
        self.assertEqual(result['cash'], 1000.)
        self.assertGreater(result['report']['trainedBars'], 0)

    def test_forecasts_manage_positions_and_stop_never_loosens(self):
        frame = bars([[100, 100, 100, 100], [100, 100.5, 99.8, 100.2],
                      [100.2, 100.5, 100, 100.3], [100.3, 100.5, 100.1, 100.2]])
        forecast = dict(high=np.array([104., 104., 105., 104.]), low=np.array([98., 99., 98., 98.]),
                        trend=np.array([1., 1., 1., -1.]), target_fraction=.8, stop_buffer=1.)
        result = run_signal_backtest(frame, np.array([1, 0, 0, 1]), np.full(4, 2.), np.full(4, 4.),
                                     ExecutionSettings(max_hold_bars=10**9), adaptive_forecast=forecast)
        trade = result['trades'].iloc[0]
        self.assertEqual(trade.exit_reason, 'model_exit')
        self.assertEqual(trade.exit_time, frame.index[-1])
        self.assertEqual(len(result['trades']), 1)
        self.assertIsNone(result['open_position'])  # No immediate re-entry after model exit.
        stops = [point['price'] for point in trade.stop_history]
        self.assertEqual(stops, sorted(stops))
        self.assertAlmostEqual(trade.target, 100.3+(105.-100.3)*.8)

    def test_start_filter_keeps_forecasts_aligned(self):
        frame = bars([[100, 100.1, 99.9, 100]]*4)
        forecast = dict(high=np.full(4, 104.), low=np.full(4, 98.), trend=np.array([-1., -1., 1., -1.]),
                        target_fraction=.8, stop_buffer=1.)
        result = run_signal_backtest(frame, np.array([0, 0, 1, 0]), np.full(4, 2.), np.full(4, 4.),
                                     ExecutionSettings(), start=frame.index[2], adaptive_forecast=forecast)
        self.assertEqual(result['trades'].iloc[0].exit_time, frame.index[3])

    def test_end_to_end_reports_unseen_range_errors(self):
        frame = market(1800)
        result = run_ml_backtest(frame, MLSettings(horizon=6, train_bars=700, retrain_every=200,
                                                  entry_threshold=.4, min_edge=0., min_reward_risk=0., min_reward_cost=0.),
                                 initial_capital=1000, leverage=1, start=frame.index[900], close_at_end=True)
        self.assertEqual(result['report']['exitMode'], 'forecast')
        self.assertIn('forecast', result['report'])
        self.assertGreater(result['report']['forecastErrors']['samples'], 0)
        self.assertNotIn('time_exit', set(result['trades'].exit_reason) if len(result['trades']) else set())
        self.assertAlmostEqual(sum(result['report']['labelBalance'].values()), 1.)

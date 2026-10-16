import unittest
import warnings
from datetime import date

import numpy as np
import pandas as pd

from server.strategies.execution import ExecutionSettings, run_signal_backtest
from server.strategies.ml.features import FEATURE_GROUPS, build_features
from server.strategies.ml.labels import LONG, NONE, SHORT, triple_barrier
from server.strategies.ml.models import MODELS, fit_model
from server.strategies.ml.strategy import MLSettings, run_ml_backtest, signals_from
from server.strategies.ml.walk_forward import fold_cache, walk_forward

warnings.filterwarnings('ignore')


def market(n=2400, seed=3):
    rng = np.random.default_rng(seed)
    close = 50+np.cumsum(rng.normal(0, .05, n))
    open_ = np.r_[close[0], close[:-1]]
    high = np.maximum(open_, close)+rng.uniform(0, .04, n)
    low = np.minimum(open_, close)-rng.uniform(0, .04, n)
    index = pd.date_range('2026-01-01', periods=n, freq='5min', tz='UTC')
    return pd.DataFrame(dict(open=open_, high=high, low=low, close=close, volume=rng.uniform(1, 9, n)), index=index)


def bars(rows):
    index = pd.date_range('2026-01-01', periods=len(rows), freq='5min', tz='UTC')
    return pd.DataFrame(rows, columns=['open', 'high', 'low', 'close'], index=index)


class FeatureTests(unittest.TestCase):
    def test_features_never_use_future_candles(self):
        frame = market(600)
        full = build_features(frame)
        cut = build_features(frame.iloc[:400])
        pd.testing.assert_frame_equal(full.iloc[:400], cut, check_dtype=False)

    def test_every_group_builds_named_finite_columns(self):
        frame = market(400)
        for key in FEATURE_GROUPS:
            columns = build_features(frame, [key])
            self.assertGreater(columns.shape[1], 0, key)
            self.assertTrue(np.isfinite(columns.iloc[-1].to_numpy()).all(), key)

    def test_unknown_group_is_rejected(self):
        with self.assertRaises(ValueError):
            build_features(market(100), ['nope'])


class LabelTests(unittest.TestCase):
    def test_first_barrier_decides_and_double_touch_is_a_loss(self):
        frame = bars([[10, 10, 10, 10], [10, 11.6, 10, 11.5], [10, 10, 10, 10], [10, 11.6, 8.9, 10], [10, 10, 10, 10]])
        atr = pd.Series(1., index=frame.index)
        labels = triple_barrier(frame, atr, horizon=1, take_profit=1.5, stop=1.)
        self.assertEqual(labels.iloc[0], LONG)
        self.assertEqual(labels.iloc[2], NONE)
        self.assertTrue(np.isnan(labels.iloc[-1]))

    def test_short_win(self):
        frame = bars([[10, 10, 10, 10], [10, 10.2, 8.4, 8.5], [8, 8, 8, 8]])
        labels = triple_barrier(frame, pd.Series(1., index=frame.index), horizon=1, take_profit=1.5, stop=1.)
        self.assertEqual(labels.iloc[0], SHORT)


class ExecutionTests(unittest.TestCase):
    settings = ExecutionSettings(initial_capital=1000, leverage=1, amount_per_trade=100, max_hold_bars=3)

    def run_with(self, rows, signals, stop=1., target=2., **costs):
        frame = bars(rows)
        n = len(frame)
        return run_signal_backtest(frame, np.array(signals, float), np.full(n, stop), np.full(n, target), self.settings, **costs)

    def test_target_hit_takes_profit_at_target(self):
        result = self.run_with([[10, 10, 10, 10], [10, 12.5, 9.5, 12]], [1, 0])
        trade = result['trades'].iloc[0]
        self.assertEqual(trade.exit_reason, 'take_profit')
        self.assertAlmostEqual(trade.exit_price, 12.)

    def test_stop_wins_when_bar_touches_both_and_gaps_fill_adversely(self):
        result = self.run_with([[10, 10, 10, 10], [8.5, 12.5, 8, 9]], [1, 0])
        trade = result['trades'].iloc[0]
        self.assertEqual(trade.exit_reason, 'stop')
        self.assertAlmostEqual(trade.exit_price, 8.5)

    def test_time_exit_and_reversal(self):
        flat = [[10, 10.1, 9.9, 10]]*6
        timed = self.run_with(flat, [1, 0, 0, 0, 0, 0])
        self.assertEqual(timed['trades'].iloc[0].exit_reason, 'time_exit')
        reversed_ = self.run_with(flat, [1, -1, 0, 0, 0, 0])
        self.assertEqual(reversed_['trades'].iloc[0].exit_reason, 'reversal')
        self.assertEqual(reversed_['trades'].iloc[1].direction, -1)

    def test_costs_reduce_pnl(self):
        rows = [[10, 10, 10, 10], [10, 12.5, 9.5, 12]]
        free = self.run_with(rows, [1, 0])['trades'].iloc[0].pnl
        costly = self.run_with(rows, [1, 0], fee_bps=10, slippage=.01, spread=.02)['trades'].iloc[0].pnl
        self.assertLess(costly, free)


class ModelTests(unittest.TestCase):
    def test_every_available_model_trains_and_returns_three_ordered_probabilities(self):
        rng = np.random.default_rng(1)
        features = pd.DataFrame(rng.normal(size=(700, 5)), columns=list('abcde'))
        labels = pd.Series(np.where(features.a > .5, LONG, np.where(features.a < -.5, SHORT, NONE)).astype(float))
        for key, spec in MODELS.items():
            if not spec.available():
                continue
            model = fit_model(key, features, labels, slice(0, 600))
            probabilities = model.predict_rows(features, slice(600, 700))
            self.assertEqual(probabilities.shape, (100, 3), key)
            np.testing.assert_allclose(probabilities.sum(axis=1), 1, atol=1e-5, err_msg=key)

    def test_sequence_predictions_ignore_later_candles(self):
        if not MODELS['cnn_1d'].available():
            self.skipTest('PyTorch not installed')
        rng = np.random.default_rng(2)
        features = pd.DataFrame(rng.normal(size=(500, 4)), columns=list('abcd'))
        labels = pd.Series(np.where(features.a > 0, LONG, SHORT).astype(float))
        model = fit_model('cnn_1d', features, labels, slice(0, 400))
        before = model.predict_rows(features, slice(400, 450))
        changed = features.copy()
        changed.iloc[450:] = 99.
        np.testing.assert_allclose(model.predict_rows(changed, slice(400, 450)), before, atol=1e-6)


class WalkForwardTests(unittest.TestCase):
    def setUp(self):
        fold_cache.items.clear()

    def test_predictions_do_not_change_when_the_future_changes(self):
        frame = market(1600)
        features = build_features(frame, ['returns', 'volatility'])
        labels = triple_barrier(frame, (frame.high-frame.low).rolling(14).mean(), 6, 1.5, 1.)
        options = dict(start_index=1000, train_bars=700, retrain_every=200, horizon=6, models={'extra_trees': 1.}, key='t')
        first = walk_forward(features, labels, **options).probabilities
        altered = labels.copy()
        altered.iloc[1300:] = SHORT
        second = walk_forward(features, altered, **options).probabilities
        pd.testing.assert_frame_equal(first.iloc[:1200], second.iloc[:1200])
        self.assertTrue(first.iloc[:1000].isna().all().all())

    def test_signals_respect_threshold_edge_and_trade_mode(self):
        probabilities = pd.DataFrame(dict(p_short=[.1, .6, .4], p_none=[.2, .1, .2], p_long=[.7, .3, .4]))
        settings = MLSettings(entry_threshold=.55, min_edge=.1)
        np.testing.assert_array_equal(signals_from(probabilities, settings), [1, -1, 0])
        long_only = MLSettings(entry_threshold=.55, min_edge=.1, trade_mode='Long Only')
        np.testing.assert_array_equal(signals_from(probabilities, long_only), [1, 0, 0])


class StrategyTests(unittest.TestCase):
    def test_settings_validation(self):
        with self.assertRaises(ValueError):
            MLSettings(feature_groups=[])
        with self.assertRaises(ValueError):
            MLSettings(models={'lightgbm': 0.})
        with self.assertRaises(ValueError):
            MLSettings(entry_threshold=.2)

    def test_end_to_end_backtest_through_dashboard_adapter(self):
        from server.strategies.bb_reversal_adapter import run_strategy_backtest
        from server.strategies.strategy import BacktestRequest
        frame = market(2400)
        request = BacktestRequest(start_date=date(2026, 1, 6), end_date=date(2026, 1, 9), strategy='ml_ensemble',
                                  entry_timeframe='5m', capital=1000, fee_bps=0, slippage=0, spread=0, funding_bps=0,
                                  ml=dict(train_bars=800, retrain_every=200, horizon=6, models={'extra_trees': 1.},
                                          feature_groups=['returns', 'volatility', 'trend'], entry_threshold=.4,
                                          min_edge=0., min_reward_cost=0.))
        result = run_strategy_backtest(frame, request)
        self.assertEqual(result['strategy'], 'ml_ensemble')
        self.assertIsNotNone(result['model'])
        self.assertGreater(len(result['model']['folds']), 0)
        self.assertEqual(len(result['candles']), len(result['indicators']))
        for trade in result['backtest']['trades']:
            self.assertGreaterEqual(trade['entryTime'], int(pd.Timestamp('2026-01-06', tz='UTC').timestamp()))

    def test_ml_settings_reject_unknown_fields_in_request(self):
        from server.strategies.strategy import BacktestRequest
        with self.assertRaises(ValueError):
            BacktestRequest(start_date=date(2026, 1, 1), end_date=date(2026, 1, 2), strategy='ml_ensemble', ml={'bogus': 1})


if __name__ == '__main__':
    unittest.main()

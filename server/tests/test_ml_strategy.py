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
        self.assertTrue(first[['p_short', 'p_none', 'p_long']].iloc[:1000].isna().all().all())

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


class TuningTests(unittest.TestCase):
    def test_tuner_ranks_on_validation_and_returns_the_fine_tune_contract(self):
        from unittest.mock import patch
        from server.strategies.fine_tuning import _ranking_key
        from server.strategies.ml import tuning
        from server.strategies.strategy import BacktestRequest
        frame = market(3200)
        request = BacktestRequest(start_date=date(2026, 1, 5), end_date=date(2026, 1, 12), strategy='ml_ensemble',
                                  entry_timeframe='5m', capital=1000, fee_bps=0, slippage=0, spread=0, funding_bps=0,
                                  ml=dict(train_bars=700, retrain_every=300, models={'extra_trees': 1.}, exit_mode='fixed',
                                          feature_groups=['returns', 'volatility'], min_reward_cost=0.))
        with patch.object(tuning, 'MODEL_GRID', dict(horizon=(6,), take_profit_atr=(1., 1.5), stop_atr=(1.,))), \
             patch.object(tuning, 'CAPACITIES', ('light', 'standard')), \
             patch.object(tuning, 'ENTRY_GRID', dict(entry_threshold=(.4, .5), min_edge=(0., .1), reverse_on_signal=(True,))):
            steps = []
            result = tuning.ml_fine_tune(frame, request, progress=lambda percent, message: steps.append(percent))
        self.assertEqual(steps[-1], 100)
        self.assertEqual(result['candidatesEvaluated'], 2*4+2*4)  # grid + top-2 models at the other capacity
        validation = [case['periods']['validation']['metrics'] for case in result['candidates']]
        self.assertEqual(validation, sorted(validation, key=lambda m: _ranking_key(m, 'profit'), reverse=True))
        best = result['candidates'][0]
        for key, value in best['bestParameters'].items():
            self.assertEqual(best['bestSettings']['ml'][key], value)
        self.assertLess(result['periods']['validation']['end'], result['periods']['forwardTest']['end'])


class LearnedExitTests(unittest.TestCase):
    def test_excursions_measure_favourable_and_adverse_moves_in_atr(self):
        from server.strategies.ml.labels import excursions
        frame = bars([[10, 10, 10, 10], [10, 12, 9.5, 11], [11, 11.5, 8, 9], [9, 9, 9, 9]])
        table = excursions(frame, pd.Series(1., index=frame.index), horizon=2)
        self.assertAlmostEqual(table.long_mfe.iloc[0], 2.)
        self.assertAlmostEqual(table.long_mae.iloc[0], 2.)
        self.assertAlmostEqual(table.short_mfe.iloc[0], 2.)
        self.assertTrue(table.iloc[-2:].isna().all().all())

    def test_trailing_stop_activates_follows_and_never_loosens(self):
        frame = bars([[10, 10, 10, 10], [10, 11.2, 10, 11], [11, 12.2, 11, 12], [12, 12, 11.4, 11.6], [11.6, 11.7, 10.5, 10.6]])
        n = len(frame)
        settings = ExecutionSettings(initial_capital=1000, max_hold_bars=20)
        result = run_signal_backtest(frame, np.array([1, 0, 0, 0, 0], float), np.full(n, 2.), np.full(n, 9.), settings,
                                     trail_activation=np.full(n, 1.), trail_distance=np.full(n, .5))
        trade = result['trades'].iloc[0]
        self.assertEqual(trade.exit_reason, 'stop')
        self.assertAlmostEqual(trade.exit_price, 11.7)
        stops = [point['price'] for point in trade.stop_history]
        self.assertEqual(stops, sorted(stops))

    def test_exit_plan_uses_learned_distances_and_falls_back_to_fixed(self):
        from server.strategies.ml.strategy import exit_plan
        probabilities = pd.DataFrame(dict(p_short=[.1, .1], p_none=[.2, .2], p_long=[.7, .7],
                                          long_tp=[2., np.nan], long_sl=[.5, np.nan], short_tp=[1., 1.], short_sl=[1., 1.]))
        plan = exit_plan(probabilities, pd.Series([2., 2.]), MLSettings(take_profit_atr=1.5, stop_atr=1.))
        np.testing.assert_allclose(plan['long_target'], [4., 3.])
        np.testing.assert_allclose(plan['long_stop'], [1., 2.])
        np.testing.assert_allclose(plan['reward_risk'], [4., 1.5])

    def test_regimes_name_trend_and_volatility_clusters(self):
        from server.strategies.ml.exits import REGIME_NAMES, RegimeModel
        rng = np.random.default_rng(4)
        parts = [dict(ret_24=.02, realized_vol_48=.001), dict(ret_24=-.02, realized_vol_48=.001),
                 dict(ret_24=0., realized_vol_48=.001), dict(ret_24=0., realized_vol_48=.01)]
        rows = [{**{k: v+rng.normal(0, .0005) for k, v in part.items()}, 'efficiency_24': .5, 'adx_14': 20., 'ema_slope_50': 0.}
                for part in parts for _ in range(150)]
        features = pd.DataFrame(rows)
        model = RegimeModel.fit(features, slice(0, len(features)))
        predicted = model.predict(features, slice(0, len(features)))
        for block, name in enumerate(('Trend up', 'Trend down', 'Range', 'Volatile')):
            values, counts = np.unique(predicted[block*150:(block+1)*150], return_counts=True)
            self.assertEqual(REGIME_NAMES[values[np.argmax(counts)]], name)


class RecencyTests(unittest.TestCase):
    def test_weights_halve_every_half_life_and_zero_disables(self):
        from server.strategies.ml.models import recency_weights
        np.testing.assert_allclose(recency_weights(3, 1), [.25, .5, 1.])
        self.assertIsNone(recency_weights(3, 0))

    def test_every_model_trains_with_recency_weights(self):
        rng = np.random.default_rng(5)
        features = pd.DataFrame(rng.normal(size=(500, 4)), columns=list('abcd'))
        labels = pd.Series(np.where(features.a > .4, LONG, np.where(features.a < -.4, SHORT, NONE)).astype(float))
        for key, spec in MODELS.items():
            if spec.available():
                model = fit_model(key, features, labels, slice(0, 450), half_life=100)
                self.assertEqual(model.predict_rows(features, slice(450, 500)).shape, (50, 3), key)


class SplitPointTests(unittest.TestCase):
    def test_default_split_and_chosen_dates(self):
        from server.strategies.strategy import split_points
        index = pd.date_range('2026-01-01', periods=100, freq='D', tz='UTC')
        self.assertEqual(split_points(index), (60, 80))
        self.assertEqual(split_points(index, date(2026, 3, 1), date(2026, 3, 21)), (59, 79))
        with self.assertRaises(ValueError):
            split_points(index, date(2026, 3, 21), date(2026, 3, 1))
        with self.assertRaises(ValueError):
            split_points(index, date(2025, 12, 1), date(2026, 2, 1))


class SizeFilterTests(unittest.TestCase):
    def test_quiet_market_blocks_entries(self):
        frame = market(2400)
        common = dict(train_bars=800, retrain_every=300, horizon=6, models={'extra_trees': 1.}, exit_mode='fixed',
                      feature_groups=['returns', 'volatility'], entry_threshold=.35, min_edge=0., min_reward_cost=0.,
                      min_reward_risk=0., min_target=0.)
        start = frame.index[1200]
        loose = run_ml_backtest(frame, MLSettings(**common, min_atr=0.), initial_capital=1000, leverage=1, start=start)
        strict = run_ml_backtest(frame, MLSettings(**common, min_atr=10.), initial_capital=1000, leverage=1, start=start)
        self.assertGreater(len(loose['trades']), 0)
        self.assertEqual(len(strict['trades']), 0)
        self.assertGreater(strict['report']['blockedBySize'], 0)


    def test_let_profit_run_exits_only_by_stop_or_trailing(self):
        frame = market(2400)
        settings = MLSettings(train_bars=800, retrain_every=300, horizon=6, models={'extra_trees': 1.}, exit_mode='fixed',
                              feature_groups=['returns', 'volatility'], entry_threshold=.35, min_edge=0., min_reward_cost=0.,
                              min_reward_risk=0., min_target=.05, let_profit_run=True, reverse_on_signal=False)
        result = run_ml_backtest(frame, settings, initial_capital=1000, leverage=1, start=frame.index[1200], close_at_end=True)
        reasons = set(result['trades'].exit_reason)
        self.assertTrue(reasons)
        self.assertTrue(result['trades'].target.isna().all())  # No take-profit is published as empty, not infinity.
        self.assertTrue(reasons <= {'stop', 'trailing_stop_at_close', 'period_end', 'data_gap'}, reasons)


class QualityFilterTests(unittest.TestCase):
    def test_learns_when_direction_calls_are_right(self):
        from server.strategies.ml.meta import MetaModel
        rng = np.random.default_rng(11)
        n = 4000
        features = pd.DataFrame(dict(a=rng.normal(size=n), b=rng.normal(size=n), c=rng.normal(size=n)))
        reliable = features.b > 0
        direction = np.where(features.a > 0, LONG, SHORT)
        noise = rng.choice([LONG, SHORT], size=n)
        labels = pd.Series(np.where(reliable, direction, noise).astype(float))
        meta = MetaModel.fit(features, labels, slice(0, 3000), primary='lightgbm', capacity='light', half_life=0)
        self.assertIsNotNone(meta)
        rows = slice(3000, n)
        probabilities = np.column_stack([(features.a.iloc[rows] < 0)*.6+.2, np.full(1000, .1),
                                         (features.a.iloc[rows] > 0)*.6+.2])
        p_win = meta.predict(features, rows, probabilities)
        self.assertGreater(p_win[reliable.iloc[rows].to_numpy()].mean(), p_win[~reliable.iloc[rows].to_numpy()].mean()+.1)


class SearchStopTests(unittest.TestCase):
    def test_raising_from_progress_stops_the_ml_search(self):
        from unittest.mock import patch
        from server.strategies.ml import tuning
        from server.strategies.strategy import BacktestRequest

        class Stop(Exception):
            pass

        calls = []

        def progress(percent, message):
            calls.append(percent)
            if len(calls) >= 3:
                raise Stop()

        request = BacktestRequest(start_date=date(2026, 1, 5), end_date=date(2026, 1, 12), strategy='ml_ensemble',
                                  entry_timeframe='5m', capital=1000, fee_bps=0, slippage=0, spread=0, funding_bps=0,
                                  ml=dict(train_bars=700, retrain_every=300, models={'extra_trees': 1.}, exit_mode='fixed',
                                          feature_groups=['returns', 'volatility'], min_reward_cost=0., min_target=0.))
        from server.strategies.ml import walk_forward
        fold_cache.items.clear()
        # One training thread makes the stop point deterministic (parallel blocks may report once more).
        with patch.object(tuning, 'MODEL_GRID', dict(horizon=(6, 8), take_profit_atr=(1., 1.5), stop_atr=(1.,))),              patch.object(walk_forward, 'WORKERS', 1):
            with self.assertRaises(Stop):
                tuning.ml_fine_tune(market(3200), request, progress=progress)
        self.assertEqual(len(calls), 3)

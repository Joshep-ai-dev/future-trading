import unittest
from dataclasses import replace
from types import SimpleNamespace

import numpy as np
import pandas as pd

from server.strategies.execution import ExecutionSettings, run_signal_backtest
from server.strategies.ml.forecast_validation import proposal_returns, validate_forecasts
from server.strategies.ml.strategy import MLSettings, Prepared
from server.tests.test_ml_strategy import bars


class ForecastValidationTests(unittest.TestCase):
    def test_next_open_uses_previous_signal_and_does_not_capture_opening_gap(self):
        frame = bars([[100, 100, 100, 100], [110, 111, 109, 110], [110, 111, 109, 110]])
        result = run_signal_backtest(frame, [1, 0, 0], np.full(3, 2.), np.full(3, 3.),
                                     ExecutionSettings(initial_capital=1000., next_open=True), close_at_end=True)
        trade = result['trades'].iloc[0]
        self.assertEqual(trade.entry_time, frame.index[1])
        self.assertEqual(trade.entry_price, 110.)
        self.assertEqual(trade.pnl, 0.)
        self.assertTrue(result['audit']['passed'])

    def test_start_boundary_preserves_prior_closed_decision(self):
        frame = bars([[100, 100, 100, 100]]*3)
        result = run_signal_backtest(frame, [1, 0, 0], np.ones(3), np.ones(3),
                                     ExecutionSettings(next_open=True), start=frame.index[1])
        self.assertEqual(result['open_position']['entry_time'], frame.index[1])

    def test_next_open_does_not_trade_across_gap_at_start_boundary(self):
        frame = bars([[100, 100, 100, 100]]*4).drop(pd.Timestamp('2026-01-01 00:05', tz='UTC'))
        result = run_signal_backtest(frame, [1, 0, 0], np.ones(3), np.ones(3), ExecutionSettings(next_open=True),
                                     start=frame.index[1], bar_seconds=300)
        self.assertIsNone(result['open_position'])

    def test_stop_first_risk_sizing_and_cost_reconciliation(self):
        frame = bars([[100, 100, 100, 100], [100, 104, 96, 100], [100, 100, 100, 100]])
        result = run_signal_backtest(frame, [1, 0, 0], np.full(3, 2.), np.full(3, 3.),
                                     ExecutionSettings(initial_capital=1000., leverage=10, next_open=True,
                                                       risk_per_trade_pct=.5, max_hold_bars=3),
                                     fee_bps=6., spread=.02, slippage=.01, funding_bps=1., bar_seconds=300)
        trade = result['trades'].iloc[0]
        self.assertEqual(trade.exit_reason, 'stop')
        self.assertLessEqual(-trade.pnl, 5.)
        self.assertTrue(result['audit']['passed'])
        self.assertAlmostEqual(result['cash']-1000., trade.pnl)

    def test_daily_loss_halt_blocks_subsequent_entries(self):
        frame = bars([[100, 100, 100, 100], [100, 101, 97, 100], [100, 101, 97, 100], [100, 101, 97, 100]])
        result = run_signal_backtest(frame, [1]*4, np.full(4, 2.), np.full(4, 3.),
                                     ExecutionSettings(initial_capital=1000., leverage=10, next_open=True,
                                                       risk_per_trade_pct=2., daily_loss_pct=3., max_drawdown_pct=10.))
        self.assertTrue(result['halted'])
        self.assertAlmostEqual(result['cash'], 970.)
        self.assertEqual(len(result['trades']), 2)
        self.assertLess(len(result['bars']), len(frame))

    def test_holding_limit_closes_even_without_forecast_reversal(self):
        frame = bars([[100, 100.1, 99.9, 100]]*6)
        result = run_signal_backtest(frame, [1, 0, 0, 0, 0, 0], np.ones(6), np.full(6, 3.),
                                     ExecutionSettings(next_open=True, max_hold_bars=2))
        self.assertEqual(result['trades'].iloc[0].exit_reason, 'time_exit')
        self.assertEqual(result['trades'].iloc[0].exit_time, frame.index[3])

    def prepared(self, n=700):
        index = pd.date_range('2026-01-01', periods=n, freq='5min', tz='UTC')
        close = 100+np.arange(n)*.5
        frame = pd.DataFrame(dict(open=close-.5, high=close+.1, low=close-.6, close=close), index=index)
        p = pd.DataFrame(dict(p_long=.95, p_short=.05, p_none=0., forecast_up=1.6,
                              forecast_down=.1, forecast_trend=1.5), index=index)
        truth = pd.DataFrame(dict(up=1.6, down=.1, trend=1.5), index=index)
        truth.iloc[-3:] = np.nan
        return Prepared(frame, pd.Series(1., index=index), 1, pd.Series(1., index=index), 0,
                        SimpleNamespace(probabilities=p, folds=[], importance={}), truth)

    def validate(self, prepared, settings=None):
        return validate_forecasts(prepared, settings or MLSettings(horizon=3, train_bars=500,
                                  forecast_stop_buffer=1.5), np.ones(len(prepared.clean)),
                                  min_tick=.01, bar_seconds=300, fee_bps=0., slippage=0., spread=0., funding_bps=0.)

    def test_matured_successful_trials_can_pass_but_warmup_cannot(self):
        allowed, report, quality = self.validate(self.prepared())
        self.assertFalse(allowed[:100].any())
        self.assertTrue(allowed[-100:].any())
        self.assertGreater(quality.quality_samples.iloc[-1], 30)
        self.assertLess(report['modelMaeAtr'], report['baselineMaeAtr'])

    def test_future_prices_and_truth_do_not_change_prior_entry_checks(self):
        first = self.prepared()
        allowed, _, quality = self.validate(first)
        changed = self.prepared()
        changed.clean.iloc[500:] *= 2
        changed.forecast_targets.iloc[500:] *= 10
        altered, _, altered_quality = self.validate(changed)
        np.testing.assert_array_equal(allowed[:500], altered[:500])
        pd.testing.assert_frame_equal(quality.iloc[:500], altered_quality.iloc[:500])

    def test_bad_forecasts_do_not_pass_simple_baseline(self):
        prepared = self.prepared()
        prepared.walk.probabilities['forecast_trend'] = 10.
        allowed, report, _ = self.validate(prepared)
        self.assertFalse(allowed.any())
        self.assertGreater(report['modelMaeAtr'], report['baselineMaeAtr'])

    def test_proposal_labels_match_next_open_trade_with_fixed_exits(self):
        prepared = self.prepared(20)
        settings = MLSettings(horizon=3, forecast_adaptive_exits=False, forecast_stop_buffer=1.5)
        cost = dict(min_tick=.01, bar_seconds=300, fee_bps=6., slippage=.01, spread=.02, funding_bps=1.)
        signal = np.zeros(20)
        signal[0] = 1
        labels = proposal_returns(prepared.clean, prepared.walk.probabilities, prepared.atr, signal, settings, cost)
        result = run_signal_backtest(prepared.clean, signal, np.full(20, .15), np.full(20, 1.28),
                                     ExecutionSettings(initial_capital=1000., next_open=True, max_hold_bars=3), **{key: value for key, value in cost.items() if key != 'min_tick'})
        trade = result['trades'].iloc[0]
        self.assertAlmostEqual(labels.iloc[0], trade.pnl/trade.quantity)


    def test_adaptive_proposal_returns_match_event_execution_for_both_sides(self):
        from server.tests.test_ml_strategy import market
        frame = market(40)
        p = pd.DataFrame(dict(forecast_up=2., forecast_down=1., forecast_trend=1.), index=frame.index)
        p.loc[frame.index[4]:, 'forecast_trend'] = -1.
        settings = MLSettings(horizon=6)
        cost = dict(min_tick=.01, bar_seconds=300, fee_bps=6., slippage=.01, spread=.02, funding_bps=1.)
        for side in (-1, 1):
            with self.subTest(side=side):
                signal = np.zeros(len(frame)); signal[0] = side
                labels = proposal_returns(frame, p, np.ones(len(frame)), signal, settings, cost)
                forecast = dict(high=frame.close.to_numpy()+2., low=frame.close.to_numpy()-1.,
                                trend=p.forecast_trend.to_numpy(), target_fraction=.8, stop_buffer=1.)
                result = run_signal_backtest(frame, signal, np.full(len(frame), 1. if side == 1 else 2.),
                                             np.full(len(frame), 1.6 if side == 1 else .8),
                                             ExecutionSettings(initial_capital=1000., next_open=True, max_hold_bars=6),
                                             adaptive_forecast=forecast, **{key: value for key, value in cost.items() if key != 'min_tick'})
                trade = result['trades'].iloc[0]
                self.assertAlmostEqual(labels.iloc[0], trade.pnl/trade.quantity)
                self.assertTrue(result['audit']['passed'])

    def test_cache_identity_changes_when_training_data_is_corrected(self):
        from unittest.mock import patch
        from server.strategies.ml.walk_forward import _train_fold, fold_cache
        fold_cache.items.clear()
        self.addCleanup(fold_cache.items.clear)
        index = pd.date_range('2026-01-01', periods=600, freq='5min', tz='UTC')
        features = pd.DataFrame(dict(a=np.arange(600, dtype=float)), index=index)
        labels = pd.Series(1., index=index)
        targets = pd.DataFrame(dict(up=2., down=1., trend=1.), index=index)
        with patch('server.strategies.ml.walk_forward.ForecastModel.fit') as fit:
            for _ in range(2):
                _train_fold(features, labels, slice(0, 500), {'extra_trees': 1}, 'audit-test', forecast_targets=targets)
            self.assertEqual(fit.call_count, 1)
            features.iloc[100, 0] *= 2
            _train_fold(features, labels, slice(0, 500), {'extra_trees': 1}, 'audit-test', forecast_targets=targets)
            self.assertEqual(fit.call_count, 2)

    def test_risk_halted_candidates_cannot_be_reliable(self):
        from server.strategies.ml.tuning import _ml_ranking_key
        metrics = dict(trades=100, netPnl=100., winRate=80., maxDrawdownPct=-10.)
        self.assertEqual(_ml_ranking_key(metrics, metrics)[:2], (True, True))
        self.assertEqual(_ml_ranking_key(dict(metrics, halted=True), metrics)[:2], (True, False))


    def test_empty_waiting_period_keeps_engine_contract(self):
        frame = bars([[100, 100, 100, 100]]*3)
        result = run_signal_backtest(frame, [0, 0, 1], np.ones(3), np.ones(3),
                                     ExecutionSettings(next_open=True), start=frame.index[-1]+pd.Timedelta(minutes=5))
        self.assertTrue(result['bars'].empty)
        self.assertIn('equity', result['bars'])
        self.assertIn('stop', result['bars'])
        self.assertTrue(result['audit']['passed'])

    def test_api_rejects_invalid_risk_and_mismatched_guard_timing(self):
        from server.strategies.strategy import BacktestRequest
        for values in ({'risk_per_trade_pct': float('nan')}, {'daily_loss_pct': True},
                       {'forecast_max_hold_bars': -1}, {'forecast_next_open': False}):
            with self.subTest(values=values), self.assertRaises(ValueError):
                BacktestRequest(start_date='2026-01-01', end_date='2026-01-02', strategy='ml_ensemble', ml=values)

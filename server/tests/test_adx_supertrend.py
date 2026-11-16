import unittest
from dataclasses import replace

import numpy as np
import pandas as pd

from server.strategies.adx_supertrend import Settings, calculate, run_backtest, readiness
from server.strategies.registry import get_strategy
from server.strategies.strategy import BacktestRequest
from server.tests.test_ml_strategy import market


def plain(**overrides):
    """Core rules only; filters off unless a test enables them."""
    return Settings(**{'htf_filter': False, 'atr_filter': False, 'rsi_filter': False, **overrides})


class AdxSupertrendTests(unittest.TestCase):
    def setUp(self):
        self.frame = market(3000)

    def test_entries_need_adx_threshold_rising_and_a_trigger_in_supertrend_direction(self):
        bars = calculate(self.frame, plain(), bar_seconds=300)
        longs, shorts = bars[bars.entry_long], bars[bars.entry_short]
        self.assertGreater(len(longs)+len(shorts), 0)
        for frame, sign in ((longs, 1), (shorts, -1)):
            self.assertTrue((frame.adx >= 25).all())
            self.assertTrue(frame.adx_rising.all())
            self.assertTrue((frame.adx_cross | frame.st_flip).all())
            self.assertTrue((frame.st_direction == sign).all())

    def test_signals_are_causal(self):
        full = calculate(self.frame, plain(), bar_seconds=300)
        cut = calculate(self.frame.iloc[:2000], plain(), bar_seconds=300)
        columns = ['adx', 'st_line', 'st_direction', 'entry_long', 'entry_short']
        pd.testing.assert_frame_equal(full[columns].iloc[:2000], cut[columns], check_dtype=False)

    def test_higher_timeframe_filter_is_causal(self):
        s = plain(htf_filter=True, htf_timeframe='1h')
        full = calculate(self.frame, s, bar_seconds=300)
        cut = calculate(self.frame.iloc[:2000], s, bar_seconds=300)
        pd.testing.assert_series_equal(full.htf_direction.iloc[:2000], cut.htf_direction, check_names=False)

    def test_stop_follows_supertrend_and_never_loosens(self):
        result = run_backtest(self.frame, plain(), bar_seconds=300, close_at_end=True)
        trades = result['trades']
        self.assertGreater(len(trades), 0)
        for trade in trades.to_dict('records'):
            prices = [point['price'] for point in trade['stop_history']]
            steps = np.diff(prices)*trade['direction']
            self.assertTrue((steps >= -1e-12).all(), 'stop loosened')
            self.assertIn(trade['exit_reason'], {'supertrend_stop', 'supertrend_flip', 'reversal', 'period_end', 'data_gap'})
        self.assertAlmostEqual(result['bars'].equity.iloc[-1], result['cash'], places=6)

    def test_filters_only_remove_entries(self):
        base = calculate(self.frame, plain(), bar_seconds=300)
        filtered = calculate(self.frame, Settings(), bar_seconds=300)
        self.assertTrue((filtered.entry_long <= base.entry_long).all())
        self.assertTrue((filtered.entry_short <= base.entry_short).all())
        rsi = filtered.loc[filtered.entry_long, 'rsi']
        self.assertTrue((rsi <= 70).all())

    def test_minimum_atr_blocks_new_entries_only(self):
        base = calculate(self.frame, plain(), bar_seconds=300)
        limit = float(base.atr.median())
        filtered = calculate(self.frame, plain(atr_filter=True, atr_min=limit), bar_seconds=300)
        entries = filtered.entry_long | filtered.entry_short
        self.assertTrue((filtered.loc[entries, 'atr'] >= limit).all())
        blocked = (base.entry_long | base.entry_short) & (base.atr < limit)
        self.assertTrue(blocked.any())
        self.assertFalse(entries[blocked].any())
        # Legacy percentile settings from saved sessions still load.
        self.assertEqual(Settings.from_dict({'atr_window': 500, 'atr_min_pct': 10, 'atr_max_pct': 95}).atr_min, .03)
        with self.assertRaises(ValueError):
            Settings(atr_min=-1)

    def test_trade_mode_and_validation(self):
        bars = calculate(self.frame, plain(trade_mode='Long Only'), bar_seconds=300)
        self.assertFalse(bars.entry_short.any())
        with self.assertRaises(ValueError):
            Settings(rsi_oversold=80, rsi_overbought=70)
        with self.assertRaises(ValueError):
            Settings(forecast_filter=True)
        with self.assertRaises(ValueError):
            Settings.from_dict({'unknown_option': 1})
        with self.assertRaises(ValueError):
            BacktestRequest(start_date='2026-01-01', end_date='2026-01-02', strategy='adx_supertrend',
                            adx_supertrend={'adx_threshold': 150})

    def test_readiness_lists_core_and_enabled_filters(self):
        result = run_backtest(self.frame, Settings(), bar_seconds=300)
        state = readiness(result['bars'].iloc[-1], Settings())
        labels = [check['label'] for check in state['longChecks']]
        self.assertIn('Supertrend direction', labels)
        self.assertTrue(any('RSI' in label for label in labels))
        self.assertTrue(0 <= state['longReadiness'] <= 100)

    def test_registered_runner_works_through_backtest_adapter(self):
        from server.strategies.bb_reversal_adapter import run_strategy_backtest
        request = BacktestRequest(start_date=str(self.frame.index[1500].date()), end_date=str(self.frame.index[-1].date()),
                                  strategy='adx_supertrend', entry_timeframe='5m', adx_supertrend={'atr_filter': False})
        runner = get_strategy('adx_supertrend')
        self.assertFalse(runner.live_supported)
        self.assertGreaterEqual(runner.warmup_bars(request), 1500)
        result = run_strategy_backtest(self.frame, request)
        self.assertEqual(result['strategy'], 'adx_supertrend')
        self.assertIn('trades', result['backtest'])

    def test_forecast_filter_rejects_look_ahead_models(self):
        from unittest.mock import patch
        from server.strategies.ml.boost_forecast import BoostForecast
        model = BoostForecast.__new__(BoostForecast)
        metadata = dict(config=dict(model='boost', timeframe='5m', horizon=6, train_bars=900),
                        trainedThrough=str(self.frame.index[-1]), featureNames=[])
        s = plain(forecast_filter=True, forecast_model_id='a'*32, forecast_owner=7)
        with patch('server.forecast_models.load_model', return_value=(model, metadata)):
            with self.assertRaisesRegex(ValueError, 'look-ahead'):
                calculate(self.frame, s, bar_seconds=300, start=self.frame.index[100])


if __name__ == '__main__':
    unittest.main()

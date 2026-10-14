import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd

from .bb_outer_reversal import Settings, _rma, calculate, run_backtest


class BBOuterReversalTests(unittest.TestCase):
    def bars(self, candles):
        data = pd.DataFrame(candles, columns=['open', 'high', 'low', 'close'])
        return data.assign(bb_lower=99., bb_upper=101., atr=1., bb_width_pct=2.,
                           adx=30., sma_ready=True, sma_uptrend=True,
                           sma_downtrend=False)

    def run_bars(self, bars, **kwargs):
        with patch('server.bb_outer_reversal.calculate', return_value=bars):
            return run_backtest(bars, Settings(**kwargs))

    def test_wilder_seed_and_population_deviation(self):
        np.testing.assert_allclose(_rma([np.nan, 2, 4, 6], 2), [np.nan, np.nan, 3, 4.5], equal_nan=True)
        frame = pd.DataFrame(dict(open=[1., 3., 5.], high=[2., 4., 6.],
                                  low=[0., 2., 4.], close=[1., 3., 5.]))
        result = calculate(frame, Settings(bb_length=2, bb_mult=1))
        self.assertEqual(result.bb_upper.iloc[1], 3.)
        self.assertEqual(result.bb_lower.iloc[1], 1.)

    def test_gap_stop_and_alternation_after_stopout(self):
        bars = self.bars([(99.5, 100.5, 98.9, 100.),
                          (99., 100.5, 98.8, 100.),
                          (100.5, 101.2, 99.8, 100.)])
        result = self.run_bars(bars)
        self.assertEqual(result['trades'].iloc[0].exit_price, 99.)
        self.assertEqual(result['bars'].long_signal.tolist(), [True, False, False])
        self.assertEqual(result['bars'].short_signal.tolist(), [False, False, True])
        self.assertEqual(result['open_position']['direction'], -1)

    def test_blocked_rebound_consumes_touch(self):
        bars = self.bars([(99.5, 100.5, 98.9, 100.), (99.5, 100.5, 99.2, 100.)])
        bars.loc[0, 'adx'] = 20.  # Strict greater-than threshold.
        self.assertFalse(self.run_bars(bars)['bars'].long_signal.any())

    def test_trailing_update_does_not_use_entry_bar_high(self):
        bars = self.bars([(99.5, 105., 98.9, 100.),
                          (100., 101.4, 99.8, 101.1),
                          (101.1, 101.2, 100.7, 101.)])
        result = self.run_bars(bars, trade_mode='Long Only')
        self.assertEqual(result['bars'].stop.iloc[0], 99.5)
        self.assertAlmostEqual(result['bars'].stop.iloc[1], 100.8)
        self.assertAlmostEqual(result['trades'].iloc[0].exit_price, 100.8)

    def test_countertrend_distances_are_frozen(self):
        bars = self.bars([(99.5, 100.5, 98.9, 100.)])
        bars['sma_downtrend'] = True
        p = self.run_bars(bars)['open_position']
        self.assertEqual(p['stop'], 99.625)
        self.assertAlmostEqual(p['trail_trigger'], .9)
        self.assertAlmostEqual(p['trail_distance'], .45)

    def test_stop_history_preserves_activation_on_exit_candle(self):
        bars = self.bars([(99.5, 100.5, 98.9, 100.),
                          (100., 101.4, 99.8, 100.5)])
        bars.index = pd.date_range('2026-01-01', periods=2, freq='5min', tz='UTC')
        result = self.run_bars(bars, trade_mode='Long Only')
        trade = result['trades'].iloc[0]
        self.assertEqual(trade.exit_reason, 'trailing_stop_at_close')
        self.assertEqual([p['reason'] for p in trade.stop_history], ['initial', 'activation'])
        self.assertEqual(trade.stop_history[-1]['time'], int(bars.index[-1].timestamp()))
        self.assertAlmostEqual(trade.stop_history[-1]['price'], 100.8)
        self.assertTrue(np.isnan(result['bars'].stop.iloc[-1]))

    def test_sma_disabled_uses_normal_distances_without_sma_warmup(self):
        bars = self.bars([(99.5, 100.5, 98.9, 100.)])
        bars['sma_downtrend'] = True
        bars['sma_ready'] = False
        self.assertIsNone(self.run_bars(bars)['open_position'])
        p = self.run_bars(bars, use_sma_trend_adjustment=False)['open_position']
        self.assertFalse(p['countertrend'])
        self.assertEqual(p['stop'], 99.5)
        self.assertAlmostEqual(p['trail_trigger'], 1.2)
        self.assertAlmostEqual(p['trail_distance'], .6)

    def test_sma_disabled_hides_indicator_values(self):
        frame = pd.DataFrame(dict(open=[100.]*5, high=[101.]*5,
                                  low=[99.]*5, close=[100.]*5))
        result = calculate(frame, Settings(sma_length=2, use_sma_trend_adjustment=False))
        self.assertTrue(result.trend_sma.isna().all())

    def test_leverage_sizes_each_entry_and_pnl_from_current_balance(self):
        bars = self.bars([(99.5, 100.5, 98.9, 100.),
                          (99., 100.5, 98.8, 100.),
                          (100.5, 101.2, 99.8, 100.)])
        result = self.run_bars(bars, initial_capital=1000, leverage=3)
        trade = result['trades'].iloc[0]
        self.assertEqual(trade.quantity, 30)
        self.assertEqual(trade.pnl, -30)
        self.assertEqual(result['open_position']['quantity'], 29.1)
        self.assertEqual(result['open_position']['direction'], -1)

    def test_tick_size_supports_price_and_percent_of_entry(self):
        bars = self.bars([(99.5, 100.5, 98.9, 100.)])
        absolute = self.run_bars(bars, min_tick=2)['open_position']
        percent = self.run_bars(bars, min_tick=2, min_tick_unit='percent')['open_position']
        self.assertEqual(absolute['initial_stop'], 98.)
        self.assertEqual(percent['initial_stop'], 98.)
        self.assertEqual(percent['trail_trigger'], 2.)
        self.assertEqual(percent['trail_distance'], 2.)
        bars[['open','high','low','close','bb_lower','bb_upper']] *= 2
        absolute = self.run_bars(bars, min_tick=2)['open_position']
        percent = self.run_bars(bars, min_tick=2, min_tick_unit='percent')['open_position']
        self.assertEqual(absolute['initial_stop'], 198.)
        self.assertEqual(percent['initial_stop'], 196.)

    def test_amount_per_trade_percent_and_dollars_before_leverage(self):
        bars = self.bars([(99.5, 100.5, 98.9, 100.)])
        for unit, amount in [('percent', 50), ('price', 1000)]:
            result = self.run_bars(bars, initial_capital=2000, leverage=3,
                                   amount_unit=unit, amount_per_trade=amount)
            self.assertEqual(result['open_position']['quantity'], 30)

    def test_fixed_dollar_allocation_is_capped_after_loss(self):
        bars = self.bars([(99.5,100.5,98.9,100.),(99.,100.5,98.8,100.),
                          (100.5,101.2,99.8,100.)])
        result = self.run_bars(bars, initial_capital=1000, leverage=3,
                               amount_unit='price', amount_per_trade=1000)
        self.assertEqual(result['cash'],970)
        self.assertEqual(result['open_position']['quantity'],29.1)

    def test_no_new_trade_after_zero_or_negative_balance_including_reversal(self):
        for exit_price in (50., 40.):
            bars = self.bars([(99.5,100.5,98.9,100.),
                              (exit_price,101.2,exit_price,100.)])
            # Intrabar gap stop followed by a short rebound on the same candle.
            stopped = self.run_bars(bars, initial_capital=1000, leverage=2)
            self.assertLessEqual(stopped['cash'],0)
            self.assertIsNone(stopped['open_position'])
            self.assertFalse(stopped['bars'].short_signal.any())
            # Reversal closes the long first, then rechecks the balance.
            bars.iloc[1] = self.bars([(100.,101.2,exit_price,exit_price)]).iloc[0]
            bars.loc[1,'bb_lower'] = 1.
            reversed_result = self.run_bars(bars, initial_capital=1000, leverage=2,
                                            initial_sl=90)
            self.assertLessEqual(reversed_result['cash'],0)
            self.assertIsNone(reversed_result['open_position'])
            self.assertFalse(reversed_result['bars'].short_signal.any())


if __name__ == '__main__':
    unittest.main()

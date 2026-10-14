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


if __name__ == '__main__':
    unittest.main()

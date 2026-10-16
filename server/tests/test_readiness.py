from types import SimpleNamespace
import unittest

from server.strategies.readiness import strategy_readiness


def signal(**overrides):
    values = dict(atr=0.05, bb_width_pct=1.0, adx=25., sma_ready=True, long_rebound=True, short_rebound=False,
                  long_direction_allowed=True, short_direction_allowed=False, long_signal=True, short_signal=False)
    values.update(overrides)
    return SimpleNamespace(**values)


CONFIG = dict(min_atr=0.03, min_bb_width_pct=0.8, adx_threshold=20, use_sma_trend_adjustment=True)


class StrategyReadinessTests(unittest.TestCase):
    def test_counts_passing_checks_per_side(self):
        state = strategy_readiness(signal(), CONFIG)
        self.assertEqual(state['longReadiness'], 100)
        self.assertEqual(state['shortReadiness'], 67)
        self.assertEqual(state['signal'], 'long')
        self.assertEqual([check['label'] for check in state['longChecks']],
                         ['ATR', 'BB width', 'ADX', 'Trend ready', 'Band rebound', 'Direction allowed'])

    def test_adx_threshold_is_strict_and_nan_metrics_become_none(self):
        state = strategy_readiness(signal(adx=20., atr=float('nan'), long_signal=False), CONFIG)
        checks = {check['label']: check for check in state['longChecks']}
        self.assertFalse(checks['ADX']['passed'])
        self.assertIsNone(checks['ATR']['value'])
        self.assertIsNone(state['signal'])

    def test_trend_check_passes_when_adjustment_is_disabled(self):
        state = strategy_readiness(signal(sma_ready=False), {**CONFIG, 'use_sma_trend_adjustment': False})
        self.assertTrue(next(c for c in state['longChecks'] if c['label'] == 'Trend ready')['passed'])

    def test_reports_indicator_values_and_missing_ones_as_none(self):
        state = strategy_readiness(signal(bb_upper=58.2, bb_basis=57.8, bb_lower=57.4, trend_sma=float('nan')), CONFIG, 61.5)
        self.assertEqual(state['indicators']['bbUpper'], 58.2)
        self.assertEqual(state['indicators']['adx'], 25.)
        self.assertEqual(state['indicators']['rsi'], 61.5)
        self.assertIsNone(state['indicators']['trendSma'])


if __name__ == '__main__':
    unittest.main()

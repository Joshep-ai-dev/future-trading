import unittest

from .fine_tuning import _combined_scores, _select_models, _candidate_set, MODES
from .bb_outer_reversal import Settings


class RecommendationTests(unittest.TestCase):
    def metrics(self, **changes):
        return {**dict(trades=30, losses=10, averageLossPct=2.,
                       maxDrawdownPct=-10., netPnl=100.), **changes}

    def test_every_mode_rewards_every_requested_goal(self):
        base = self.metrics()
        for mode, _, _ in MODES:
            for improvement in ({'netPnl': 200.}, {'averageLossPct': 1.},
                                {'losses': 5}, {'trades': 60}):
                with self.subTest(mode=mode, improvement=improvement):
                    scores = _combined_scores([base, self.metrics(**improvement)], mode)
                    self.assertGreater(scores[1], scores[0])

    def test_models_are_distinct_and_avoid_empty_samples(self):
        rows = [(self.metrics(netPnl=100+i), {}, {'case': i}) for i in range(4)]
        rows.append((self.metrics(trades=0, losses=0, averageLossPct=0., netPnl=0.), {}, {'case': 99}))
        models = _select_models(rows)
        self.assertEqual(len(models), 4)
        self.assertEqual(len({model[2]['case'] for model in models}), 4)
        self.assertNotIn(99, {model[2]['case'] for model in models})


class CandidateParameterTypeTests(unittest.TestCase):
    def test_whole_number_float_settings_can_be_sampled(self):
        base = Settings(bb_mult=3, leverage=1, initial_sl=1,
                        trail_trigger=1, trail_distance=1,
                        trail_multiplier=2, min_atr=0, amount_per_trade=25)
        candidates = _candidate_set(base, 8, seed=1729)
        self.assertEqual(len(candidates), 8)
        for params in candidates:
            Settings(**params)
            self.assertIn('bb_mult', params)


class RecommendationIntegrationTests(unittest.TestCase):
    def test_pipeline_returns_four_distinct_models_and_baseline(self):
        from unittest.mock import patch, Mock
        import numpy as np
        import pandas as pd
        from .fine_tuning import fine_tune
        from .strategy import BacktestRequest

        index = pd.date_range('2026-01-01', periods=400, freq='5min', tz='UTC')
        close = 100 + np.sin(np.arange(400)/4)
        frame = pd.DataFrame(dict(open=close, high=close+.3,
                                  low=close-.3, close=close), index=index)
        request = BacktestRequest(start_date='2026-01-01', end_date='2026-01-02',
                                  bb_reversal={'bb_mult': 3})
        model = Mock()
        model.predict.side_effect = lambda features: np.zeros(len(features))
        with patch('server.fine_tuning.TRIALS', 8), \
             patch('server.fine_tuning.ADAPTIVE_TRIALS', 0), \
             patch('server.fine_tuning._tune_model_hyperparameters', return_value=({}, 0.)), \
             patch('server.fine_tuning._fit_ensemble', return_value=model):
            result = fine_tune(frame, request)
        self.assertEqual(len(result['candidates']), 4)
        self.assertIn('baselineMetrics', result)
        keys = {tuple(sorted(case['bestParameters'].items())) for case in result['candidates']}
        self.assertEqual(len(keys), 4)
        self.assertEqual(result['candidates'][0]['label'], 'Balanced')

import unittest

import numpy as np
import pandas as pd

from server.strategies.ml.sequence_forecast import SequenceForecast
from server.strategies.ml.strategy import MLSettings, prepare
from server.strategies.ml.walk_forward import fold_cache
from server.tests.test_ml_strategy import market


class SequenceForecastTests(unittest.TestCase):
    def test_recurrent_architectures_produce_causal_bounded_forecasts(self):
        rng = np.random.default_rng(7)
        features = pd.DataFrame(rng.normal(size=(520, 3)))
        targets = pd.DataFrame({'up': 2+features[0].abs(), 'down': 1+features[1].abs(), 'trend': features[2]})
        for kind in ('rnn', 'lstm', 'gru'):
            with self.subTest(kind=kind):
                model = SequenceForecast.fit(features, targets, slice(0, 450), kind=kind,
                                             lookback=100, epochs=1, horizon=5, device='cpu')
                self.assertEqual(model.lookback, 100)
                # 351 complete sequences, 85% training boundary at index 397;
                # purged training ends at 391 inclusive.
                np.testing.assert_allclose(model.mean, features.iloc[:392].mean(), rtol=1e-5)
                output = model.forecast_rows(features, slice(450, 470))
                self.assertEqual(output.shape, (20, 3))
                self.assertTrue(np.isfinite(output).all())
                self.assertTrue((output[:, :2] >= 0).all())
                self.assertTrue((output[:, 2] <= output[:, 0]).all())
                self.assertTrue((output[:, 2] >= -output[:, 1]).all())
                np.testing.assert_allclose(model.predict_rows(features, slice(450, 470)).sum(axis=1), 1.)
                changed = features.copy()
                changed.iloc[470:] *= 100
                np.testing.assert_allclose(output, model.forecast_rows(changed, slice(450, 470)))
                self.assertEqual(model.importance(), {})

    def test_walk_forward_routes_selected_forecast_and_preserves_model_identity(self):
        frame = market(750)
        config = MLSettings(forecast_model='gru', sequence_epochs=1, train_bars=600, horizon=5)
        fold_cache.items.clear()
        self.addCleanup(fold_cache.items.clear)
        result = prepare(frame, config, start=frame.index[700])
        self.assertTrue(np.isfinite(result.walk.probabilities.forecast_trend.iloc[700:]).all())
        self.assertNotEqual(config.model_key(), MLSettings().model_key())
        for kwargs in ({'forecast_model': 'invalid'}, {'sequence_lookback': 0}, {'sequence_epochs': 101}):
            with self.assertRaises(ValueError):
                MLSettings(**kwargs)


if __name__ == '__main__':
    unittest.main()

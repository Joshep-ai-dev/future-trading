import unittest
from unittest.mock import patch

import numpy as np

from server.forecast_research import ForecastRequest, run_forecast_test
from server.tests.test_ml_strategy import market


class ForecastResearchTests(unittest.TestCase):
    def request(self, **overrides):
        values = dict(model='extra_trees', timeframe='5m', start_date='2026-01-04',
                      end_date='2026-01-05', train_bars=600, horizon=6, epochs=1)
        return ForecastRequest(**{**values, **overrides})

    def test_holdout_predictions_and_metrics_are_aligned_and_causal(self):
        frame = market(1500)
        result = run_forecast_test(frame, self.request())
        self.assertEqual(result['metrics']['samples'], 1440-864-6)
        self.assertEqual(result['trainingRows'], 600)
        point = result['predictions'][0]
        self.assertEqual(point['originTime'], int(frame.index[865].timestamp()))
        self.assertEqual(point['targetTime'], int(frame.index[871].timestamp()))
        self.assertEqual(point['actualClose'], frame.close.iloc[870])
        self.assertEqual(point['actualHigh'], frame.high.iloc[865:871].max())
        self.assertEqual(point['actualLow'], frame.low.iloc[865:871].min())
        self.assertLess(result['trainEnd'], '2026-01-04')
        changed = frame.copy()
        changed.iloc[900:, :4] *= 1.1
        second = run_forecast_test(changed, self.request())
        for first_point, second_point in zip(result['predictions'][:36], second['predictions'][:36]):
            self.assertEqual(first_point['predictedClose'], second_point['predictedClose'])
        error = np.mean([abs(p['predictedClose']-p['actualClose']) for p in result['predictions']])
        self.assertAlmostEqual(result['metrics']['closeMae'], error)

    def test_neural_forecast_works_without_strategy_execution(self):
        result = run_forecast_test(market(1200), self.request(model='gru'))
        self.assertEqual(result['epochsTrained'], 1)
        self.assertTrue(np.isfinite(result['metrics']['closeMae']))
        self.assertNotIn('trades', result)

    def test_rejects_gaps_short_history_and_invalid_dates(self):
        frame = market(1500)
        with self.assertRaises(ValueError):
            run_forecast_test(frame.drop(frame.index[800]), self.request())
        with self.assertRaises(ValueError):
            run_forecast_test(frame, self.request(start_date='2026-01-02'))
        with self.assertRaises(ValueError):
            self.request(end_date='2026-01-01')

    def test_api_loads_silver_and_returns_forecast(self):
        from server.app import forecast_test
        with patch('server.app.load_bars', return_value=(market(1200), {})) as loader:
            result = forecast_test(self.request())
        loader.assert_called_once_with('5m', instrument='xag')
        self.assertGreater(result['metrics']['samples'], 0)


if __name__ == '__main__':
    unittest.main()

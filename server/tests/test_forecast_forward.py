import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pandas as pd

from server.forecast_forward import ForwardForecastRequest, issue_forward_forecast, observed_outcome
from server.storage.user_data_store import UserDataStore
from server.tests.test_ml_strategy import market


class ForwardForecastTests(unittest.TestCase):
    def setUp(self):
        self.frame = market(1400)
        self.now = int(self.frame.index[1000].timestamp())+20
        self.config = ForwardForecastRequest(model='extra_trees', timeframe='5m', train_bars=600, horizon=6)

    def test_issue_uses_only_known_candles_and_saves_future_target(self):
        first = issue_forward_forecast(self.frame, self.config, clock=lambda: self.now)
        changed = self.frame.copy()
        changed.iloc[1000:, :4] *= 2
        second = issue_forward_forecast(changed, self.config, clock=lambda: self.now)
        self.assertEqual(first, second)
        self.assertEqual(first['originClose'], self.frame.close.iloc[999])
        self.assertEqual(first['originTime'], int(self.frame.index[1000].timestamp()))
        self.assertEqual(first['targetTime'], int(self.frame.index[1006].timestamp()))
        self.assertLess(first['issuedAt'], first['targetTime'])
        self.assertNotIn('actual', first)

    def test_rolling_prediction_advances_with_new_closed_candles_without_training(self):
        from server.forecast_research import forecast_inputs
        from unittest.mock import Mock
        import numpy as np
        features, _, _, _ = forecast_inputs(self.frame, self.config, pd.Timedelta(minutes=5))
        metadata = dict(id='a'*32, trainingRows=600, featureNames=list(features.columns))
        model = Mock()
        model.forecast_rows.return_value = np.array([[1., 1., .1]])
        with patch('server.strategies.ml.forecast.ForecastModel.fit', side_effect=AssertionError('Must not train')):
            first = issue_forward_forecast(self.frame, self.config, clock=lambda: self.now, saved_model=model, metadata=metadata)
            same = issue_forward_forecast(self.frame, self.config, clock=lambda: self.now+10, saved_model=model, metadata=metadata)
            later = issue_forward_forecast(self.frame, self.config, clock=lambda: self.now+300, saved_model=model, metadata=metadata)
        self.assertEqual(first['originTime'], same['originTime'])
        self.assertEqual(first['predictedClose'], same['predictedClose'])
        self.assertEqual(later['originTime'], first['originTime']+300)
        self.assertEqual(later['targetTime'], first['targetTime']+300)
        self.assertNotEqual(later['originClose'], first['originClose'])

    def test_verification_waits_for_target_and_every_completed_candle(self):
        prediction = issue_forward_forecast(self.frame, self.config, clock=lambda: self.now)
        self.assertIsNone(observed_outcome(prediction, self.frame, prediction['targetTime']-1))
        missing = self.frame.drop(self.frame.index[1003])
        self.assertIsNone(observed_outcome(prediction, missing, prediction['targetTime']))
        partial = self.frame.copy()
        partial.loc[partial.index[1003], 'close'] = float('nan')
        self.assertIsNone(observed_outcome(prediction, partial, prediction['targetTime']))
        actual = observed_outcome(prediction, self.frame, prediction['targetTime'])
        self.assertEqual(actual['close'], self.frame.close.iloc[1005])
        self.assertEqual(actual['high'], self.frame.high.iloc[1000:1006].max())
        self.assertEqual(actual['low'], self.frame.low.iloc[1000:1006].min())
        self.assertEqual(actual['closeAbsoluteError'], abs(prediction['predictedClose']-actual['close']))

    def test_rejects_stale_data_and_training_finished_after_target(self):
        with self.assertRaisesRegex(ValueError, 'stale'):
            issue_forward_forecast(self.frame.iloc[:800], self.config, clock=lambda: self.now)
        with self.assertRaisesRegex(ValueError, 'after the forecast target'):
            issue_forward_forecast(self.frame, self.config, clock=Mock(side_effect=[self.now, self.now+3600]))

    def test_database_scopes_records_and_only_updates_actual_once(self):
        store = UserDataStore()
        store._run = Mock(return_value=12)
        saved = store.save_forward_forecast(7, {'targetTime': 123})
        self.assertEqual(saved['id'], 12)
        self.assertEqual(store._run.call_args.args[1][0], 7)
        store._run.return_value = [{'id': 12, 'prediction': '{"targetTime":123}', 'actual': None}]
        self.assertIsNone(store.list_forward_forecasts(7)[0]['actual'])
        self.assertEqual(store._run.call_args.args[1], (7,))
        store.settle_forward_forecast(7, 12, {'close': 50})
        sql, params = store._run.call_args.args
        self.assertIn('actual IS NULL', sql)
        self.assertNotIn('SET prediction', sql)
        self.assertEqual(params[1:], (7, 12))

    def test_api_issues_to_signed_in_account_and_settles_without_retraining(self):
        from server.app import create_forward_forecast, list_forward_forecasts
        request = SimpleNamespace(state=SimpleNamespace(user={'id': 7}))
        with patch('server.app.refresh_service') as refresh, patch('server.app.load_bars', return_value=(self.frame, {})), patch('server.app.issue_forward_forecast', return_value={'targetTime': 123}), patch('server.app.user_data_store') as store:
            create_forward_forecast(self.config, request)
            store.save_forward_forecast.assert_called_once_with(7, {'targetTime': 123})
        prediction = issue_forward_forecast(self.frame, self.config, clock=lambda: self.now)
        with patch('server.app.time.time', return_value=prediction['targetTime']), patch('server.app.refresh_service') as refresh, patch('server.app.load_bars', return_value=(self.frame, {})), patch('server.app.user_data_store') as store:
            refresh.status.return_value = {'running': False, 'lastSuccess': prediction['targetTime']}
            store.list_forward_forecasts.return_value = [{'id': 12, 'prediction': prediction, 'actual': None}]
            result = list_forward_forecasts(request)
            self.assertEqual(result[0]['status'], 'verified')
            self.assertEqual(store.settle_forward_forecast.call_args.args[:2], (7, 12))


if __name__ == '__main__':
    unittest.main()

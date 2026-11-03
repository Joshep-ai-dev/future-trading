import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd

from server.forecast_models import TrainForecastRequest, train_saved_model, list_models, load_model
from server.forecast_forward import ForwardForecastRequest, issue_forward_forecast
from server.forecast_research import ForecastRequest, run_forecast_test, forecast_inputs
from server.tests.test_ml_strategy import market


class SavedModelTests(unittest.TestCase):
    def test_remove_model_only_deletes_the_owners_artifacts(self):
        from server.forecast_models import delete_model
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            owner = root/'7'
            owner.mkdir()
            model_id = 'a'*32
            (owner/f'{model_id}.json').write_text('{}', encoding='utf-8')
            (owner/f'{model_id}.joblib').write_bytes(b'model')
            (owner/'prediction-history.json').write_text('[]', encoding='utf-8')
            self.assertFalse(delete_model(8, model_id, root))
            self.assertTrue((owner/f'{model_id}.json').exists())
            with self.assertRaises(ValueError):
                delete_model(7, '../outside', root)
            self.assertTrue(delete_model(7, model_id, root))
            self.assertFalse((owner/f'{model_id}.json').exists())
            self.assertFalse((owner/f'{model_id}.joblib').exists())
            self.assertTrue((owner/'prediction-history.json').exists())
            self.assertFalse(delete_model(7, model_id, root))

    def test_all_architectures_survive_reload_and_are_account_scoped(self):
        frame = market(1400)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for kind in ('extra_trees', 'rnn', 'lstm', 'gru'):
                with self.subTest(kind=kind):
                    config = TrainForecastRequest(name='Silver GRU', model=kind, timeframe='5m', horizon=6, epochs=1,
                                                  training_end='2026-01-02', train_bars=600)
                    metadata = train_saved_model(frame, config, 7, root)
                    model, restored_meta = load_model(7, metadata['id'], root)
                    self.assertEqual(metadata, restored_meta)
                    self.assertEqual(metadata['config']['model'], kind)
                    self.assertTrue(metadata['config']['path_forecast'])
                    self.assertEqual(metadata['name'], 'Silver '+('Extra Trees' if kind == 'extra_trees' else kind.upper()))
                    features, _, _, _ = forecast_inputs(frame, config, pd.Timedelta(minutes=5))
                    expected = model.forecast_rows(features, slice(900, 910))
                    restored, _ = load_model(7, metadata['id'], root)
                    np.testing.assert_allclose(expected, restored.forecast_rows(features, slice(900, 910)), rtol=1e-5)
                    path = restored.forecast_path_rows(features, slice(900, 910))
                    self.assertEqual(path.shape, (10, 6))
                    self.assertTrue(np.isfinite(path).all())
                    np.testing.assert_allclose(path[:, -1], expected[:, 2], rtol=1e-5)
                    np.testing.assert_allclose(path, model.forecast_path_rows(features, slice(900, 910)), rtol=1e-5)
                    self.assertEqual(metadata['trainedThrough'], '2026-01-03T00:00:00+00:00')
                    self.assertTrue(metadata['trainingRows'] >= 300)
                    quality = metadata['validation']
                    self.assertGreater(quality['samples'], 0)
                    self.assertLess(quality['end'], metadata['trainedThrough'])
                    self.assertAlmostEqual(quality['skillPct'], 100*(1-quality['closeMae']/quality['baselineMae']))
                    self.assertEqual(quality['beatsBaseline'], quality['closeMae'] < quality['baselineMae'])
                    with self.assertRaisesRegex(ValueError, 'this account'):
                        load_model(8, metadata['id'], root)
                    self.assertEqual(list_models(8, root), [])
            self.assertEqual(len(list_models(7, root)), 4)
            with self.assertRaises(ValueError):
                load_model(7, '../outside', root)

    def test_saved_model_api_uses_account_and_saved_configuration(self):
        from types import SimpleNamespace
        from server.app import create_forward_forecast, test_saved_forecast, SavedForecastTestRequest
        owner = SimpleNamespace(state=SimpleNamespace(user={'id': 7}))
        metadata = {'id': 'a'*32, 'config': dict(model='gru', timeframe='5m', horizon=6,
                    lookback=100, epochs=1, train_bars=600)}
        sentinel = object()
        with patch('server.app.load_model', return_value=(sentinel, metadata)) as load, patch('server.app.load_bars', return_value=(market(1400), {})), patch('server.app.refresh_service'), patch('server.app.issue_forward_forecast', return_value={'modelId': metadata['id']}) as issue, patch('server.app.user_data_store'):
            create_forward_forecast(ForwardForecastRequest(model_id=metadata['id'], timeframe='1d'), owner)
            load.assert_called_once_with(7, metadata['id'])
            self.assertEqual(issue.call_args.args[1].timeframe, '5m')
            self.assertIs(issue.call_args.kwargs['saved_model'], sentinel)
        with patch('server.app.load_model', return_value=(sentinel, metadata)) as load, patch('server.app.load_bars', return_value=(market(1400), {})), patch('server.app.run_forecast_test', return_value={}) as run:
            test_saved_forecast(metadata['id'], SavedForecastTestRequest(start_date='2026-01-04', end_date='2026-01-05'), owner)
            load.assert_called_once_with(7, metadata['id'])
            self.assertIs(run.call_args.kwargs['saved_model'], sentinel)

    def test_saved_model_reused_without_fit_for_historical_and_live_tests(self):
        frame = market(1400)
        config = TrainForecastRequest(model='extra_trees', timeframe='5m', horizon=6, epochs=1,
                                      training_end='2026-01-02', train_bars=600)
        with tempfile.TemporaryDirectory() as directory:
            metadata = train_saved_model(frame, config, 7, Path(directory))
            model, _ = load_model(7, metadata['id'], Path(directory))
            with patch('server.strategies.ml.forecast.ForecastModel.fit', side_effect=AssertionError('Must not retrain')):
                request = ForecastRequest(**metadata['config'], start_date='2026-01-04', end_date='2026-01-05')
                result = run_forecast_test(frame, request, saved_model=model, metadata=metadata)
                self.assertEqual(result['modelId'], metadata['id'])
                with self.assertRaisesRegex(ValueError, 'training cutoff'):
                    run_forecast_test(frame, request.model_copy(update={'start_date': pd.Timestamp('2026-01-02').date()}), saved_model=model, metadata=metadata)
                now = int(frame.index[1200].timestamp())+10
                live = issue_forward_forecast(frame, ForwardForecastRequest(**metadata['config'], model_id=metadata['id']),
                                              clock=lambda: now, saved_model=model, metadata=metadata)
                self.assertEqual(live['modelId'], metadata['id'])
                self.assertLess(live['issuedAt'], live['targetTime'])
                self.assertEqual(len(live['history']), 100)
                self.assertEqual(len(live['path']), 6)
                self.assertEqual(live['path'][-1]['time'], live['targetTime'])
                self.assertAlmostEqual(live['path'][-1]['close'], live['predictedClose'])
                self.assertEqual(live['path'][0]['time'], live['originTime']+300)


if __name__ == '__main__':
    unittest.main()

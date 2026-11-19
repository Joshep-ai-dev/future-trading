import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import MagicMock, patch

from server.market import datasets, dataset_sync


class DatasetSyncTests(unittest.TestCase):
    def test_sync_appends_completed_candles_and_preserves_history(self) -> None:
        with TemporaryDirectory() as directory, patch.object(datasets, 'ROOT', Path(directory)):
            dataset_sync._success.clear()
            start = 1800000000000
            saved = datasets.save_minutes('mexc', 'BTC/USDT:USDT',
                [[start, 100, 101, 99, 100, 1]], start, start+60000)
            exchange = MagicMock()
            exchange.fetch_ohlcv.return_value = [
                [start, 100, 102, 99, 101, 2],
                [start+60000, 101, 103, 100, 102, 3],
                [start+120000, 102, 104, 101, 103, 4],
            ]
            with patch.object(dataset_sync, 'public_exchange', return_value=exchange) as create, \
                 patch.object(dataset_sync.time, 'time', return_value=(start+120000)/1000):
                result = dataset_sync.sync_dataset(saved['id'])
                cached = dataset_sync.sync_dataset(saved['id'])
            self.assertEqual(result['bars'], 2)
            self.assertEqual(result['end'], (start+60000)//1000)
            self.assertEqual(result, cached)
            create.assert_called_once_with('mexc')
            exchange.fetch_ohlcv.assert_called_once()
            exchange.close.assert_called_once()
            frame = __import__('pandas').read_csv(datasets.dataset_path(saved['id']))
            self.assertEqual(list(frame.close), [101, 102])

    def test_missing_dataset_never_opens_exchange(self) -> None:
        with TemporaryDirectory() as directory, patch.object(datasets, 'ROOT', Path(directory)), \
             patch.object(dataset_sync, 'public_exchange') as create:
            with self.assertRaises(ValueError):
                dataset_sync.sync_dataset('dataset:'+'0'*64)
            create.assert_not_called()

    def test_failed_sync_preserves_saved_data_and_retries(self) -> None:
        with TemporaryDirectory() as directory, patch.object(datasets, 'ROOT', Path(directory)):
            dataset_sync._success.clear()
            start = 1800000000000
            saved = datasets.save_minutes('htx', 'ETH/USDT:USDT',
                [[start, 100, 101, 99, 100, 1]], start, start+60000)
            original = datasets.dataset_path(saved['id']).read_bytes()
            with patch.object(dataset_sync, 'public_exchange', side_effect=OSError('offline')) as create:
                for _ in range(2):
                    with self.assertRaises(OSError):
                        dataset_sync.sync_dataset(saved['id'])
            self.assertEqual(create.call_count, 2)
            self.assertEqual(datasets.dataset_path(saved['id']).read_bytes(), original)

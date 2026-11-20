import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import MagicMock, patch

import pandas as pd

from server.market import datasets
from server.market.data import load_bars
from server.app import PaperStartRequest
from server.paper.paper_trading import PaperTrading


class DatasetTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.patch = patch.object(datasets, 'ROOT', Path(self.temp.name) / 'markets')
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.start = int(pd.Timestamp('2026-01-01', tz='UTC').timestamp())*1000

    def save(self, venue='htx', symbol='BTC/USDT:USDT', offset=0):
        rows = [[self.start+i*60000, 100+offset, 101+offset, 99+offset, 100+offset, 2] for i in range(10)]
        return datasets.save_minutes(venue, symbol, rows, self.start, self.start+10*60000)

    def test_exchange_and_symbol_histories_stay_separate(self) -> None:
        first, second = self.save(), self.save('mexc', offset=50)
        self.assertNotEqual(first['id'], second['id'])
        frame, _ = load_bars('1m', instrument=second['id'])
        self.assertEqual(frame.close.iloc[0], 150)
        self.assertEqual(len(datasets.list_datasets()), 2)
        self.assertEqual(len(load_bars('5m', instrument=first['id'])[0].dropna()), 2)

    def test_updates_merge_without_duplicate_timestamps(self) -> None:
        self.save()
        result = self.save(offset=10)
        frame, _ = load_bars('1m', instrument=result['id'])
        self.assertEqual(len(frame), 10)
        self.assertEqual(frame.close.iloc[-1], 110)
        self.assertEqual(result['missingBars'], 0)

    def test_invalid_identifiers_and_ohlcv_are_rejected(self) -> None:
        for value in ('../../credentials', 'dataset:../secrets', 'random'):
            with self.assertRaises(ValueError):
                datasets.dataset_path(value)
        with self.assertRaises(ValueError):
            datasets.save_minutes('htx', 'BTC', [[self.start, 100, 90, 99, 100, 2]], self.start, self.start+60000)
        self.assertFalse(datasets.ROOT.exists())

    def test_download_stops_on_repeated_or_unavailable_pages(self) -> None:
        exchange = MagicMock()
        exchange.fetch_ohlcv.return_value = [[self.start, 100, 101, 99, 100, 1]]
        with patch('server.market.datasets.time.time', return_value=self.start/1000+120):
            result = datasets.download_minutes(exchange, {'symbol': 'BTC/USDT:USDT'}, 'htx', 1)
        self.assertEqual(result['downloadedBars'], 1)
        self.assertEqual(exchange.fetch_ohlcv.call_count, 2)
        self.assertNotIn('limit', exchange.fetch_ohlcv.call_args.kwargs)

    def test_replay_loads_the_selected_dataset_and_uses_virtual_funds(self) -> None:
        saved = self.save()
        request = PaperStartRequest(strategy='adx_supertrend', market=saved['id'], paper_mode='replay',
                                    replay_start='2026-01-01', replay_end='2026-01-01', entry_timeframe='1m')
        service = PaperTrading(Path(self.temp.name)/'paper.json', now=lambda:self.start/1000+86400)
        response = service.begin(request)
        self.assertEqual(response['session']['settings']['market'], saved['id'])
        self.assertEqual(service.state['replayCandles'][0]['close'], 100)
        self.assertEqual(len(service.state['replayCandles']), 10)
        self.assertEqual(response['session']['balance'], request.capital)
        live = PaperStartRequest(strategy='adx_supertrend', market=saved['id'], paper_mode='live')
        self.assertEqual(live.market, saved['id'])

    def test_forward_pagination_honors_smaller_exchange_page_caps(self) -> None:
        rows = [[self.start+i*60000, 100, 101, 99, 100, 1] for i in range(600)]
        exchange = MagicMock()
        exchange.fetch_ohlcv.side_effect = lambda symbol, timeframe, since=None, limit=None: [row for row in rows if row[0]>=since][:100]
        with patch('server.market.datasets.time.time', return_value=self.start/1000+600*60):
            result = datasets.download_minutes(exchange, {'symbol':'BTC/USDT:USDT'}, 'mexc', 1)
        self.assertEqual(result['downloadedBars'], 600)
        self.assertEqual(result['missingBars'], 0)
        self.assertEqual(exchange.fetch_ohlcv.call_count, 6)

    def test_custom_date_range_filters_to_requested_completed_candles(self) -> None:
        rows = [[self.start+i*60000, 100, 101, 99, 100, 1] for i in range(10)]
        exchange = MagicMock()
        exchange.fetch_ohlcv.return_value = rows
        result = datasets.download_minutes(exchange, {'symbol':'BTC/USDT:USDT'}, 'mexc',
                                          start_ms=self.start+2*60000, end_ms=self.start+5*60000)
        self.assertEqual(result['downloadedBars'], 3)
        self.assertEqual(result['downloadedStart'], self.start//1000+120)
        self.assertEqual(result['downloadedEnd'], self.start//1000+240)

    def test_date_range_request_requires_valid_paired_bounded_dates(self) -> None:
        from server.app import HistoryDownloadRequest
        base = dict(venue='htx', symbol='BTC/USDT:USDT')
        valid = HistoryDownloadRequest(**base, start_date='2026-01-01', end_date='2026-01-30')
        self.assertEqual(valid.start_date.isoformat(), '2026-01-01')
        for dates in (dict(start_date='2026-01-01'),
                      dict(start_date='2026-01-02', end_date='2026-01-01'),
                      dict(start_date='2026-01-01', end_date='2026-01-31'),
                      dict(start_date='2099-01-01', end_date='2099-01-02')):
            with self.assertRaises(ValueError):
                HistoryDownloadRequest(**base, **dates)

    def test_hyperliquid_pages_are_bounded_and_retention_is_reported(self) -> None:
        latest = self.start+7*86400000
        earliest = latest-4999*60000
        exchange = MagicMock()
        def page(symbol, timeframe, since=None, limit=None, params=None):
            stop = min(params['until']+1, latest)
            return [[stamp,100,101,99,100,1] for stamp in range(since, stop, 60000)]
        exchange.fetch_ohlcv.side_effect = page
        with patch('server.market.datasets.time.time', return_value=latest/1000):
            result = datasets.download_minutes(exchange, {'symbol':'XYZ-SILVER/USDC:USDC'}, 'hyperliquid', 7)
        self.assertEqual(result['downloadedBars'], 4999)
        self.assertTrue(result['limitedHistory'])
        self.assertEqual(result['requestedStart'], self.start//1000)
        self.assertEqual(result['downloadedStart'], earliest//1000)
        for call in exchange.fetch_ohlcv.call_args_list:
            self.assertLessEqual(call.kwargs['params']['until']-call.kwargs['since'], 500*60000)

    def test_hyperliquid_old_range_fails_with_a_specific_retention_message(self) -> None:
        exchange = MagicMock()
        with patch('server.market.datasets.time.time', return_value=self.start/1000+10*86400):
            with self.assertRaisesRegex(ValueError, 'latest 5000'):
                datasets.download_minutes(exchange, {'symbol':'BTC/USDC:USDC'}, 'hyperliquid',
                                          start_ms=self.start, end_ms=self.start+86400000)
        exchange.fetch_ohlcv.assert_not_called()

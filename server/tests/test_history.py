import json
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd
from pydantic import ValidationError

from server.app import CandleRequest, Parameters, candle_page, history, run
from server.market.data import _complete_chart_bars, load_chart_bars


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.frame = pd.DataFrame({k: np.arange(12, dtype=float)+100 for k in ['open','high','low','close']},
                                  index=pd.date_range('2020', periods=12, freq='5min', tz='UTC'))
        self.frame.iloc[5] = np.nan

    def test_pages_are_exclusive_ordered_and_exhaust_history_without_duplicates(self):
        page = candle_page(self.frame, limit=4)
        pages = [page]
        while page['hasMore']:
            older = candle_page(self.frame, before=page['nextBefore'], limit=4)
            self.assertLess(older['candles'][-1]['time'], page['candles'][0]['time'])
            pages.append(older)
            page = older
        candles = [c for p in reversed(pages) for c in p['candles']]
        expected = [int(t.timestamp()) for t in self.frame.dropna().index]
        self.assertEqual([c['time'] for c in candles], expected)
        self.assertEqual(len(candles), len(set(c['time'] for c in candles)))
        self.assertFalse(page['hasMore'])
        json.dumps(pages, allow_nan=False)

    def test_forward_pages_stop_before_the_current_chart_window(self) -> None:
        times = [int(stamp.timestamp()) for stamp in self.frame.index]
        with patch('server.app.load_chart_bars', return_value=self.frame):
            first = history(CandleRequest(timeframe='5m', after=times[3], before=times[10], limit=3))
            self.assertEqual([row['time'] for row in first['candles']], [times[4], times[6], times[7]])
            self.assertTrue(first['hasMore'])
            second = history(CandleRequest(
                timeframe='5m', after=first['candles'][-1]['time'], before=times[10], limit=3,
            ))
            self.assertEqual([row['time'] for row in second['candles']], times[8:10])
            self.assertFalse(second['hasMore'])

    def test_empty_page_at_start_and_exact_page_boundary(self):
        first = int(self.frame.index[0].timestamp())
        self.assertEqual(candle_page(self.frame, before=first), dict(candles=[],hasMore=False,nextBefore=None))
        self.assertFalse(candle_page(self.frame, limit=11)['hasMore'])

    def test_chart_cache_reloads_when_a_source_file_changes(self) -> None:
        self.addCleanup(_complete_chart_bars.cache_clear)
        _complete_chart_bars.cache_clear()
        with (
            patch('server.market.data.load_bars', return_value=(self.frame, {})) as loader,
            patch('server.market.data._file_version', return_value=(1, 100, 1)) as version,
        ):
            first = load_chart_bars('5m', 'xag')
            self.assertIs(load_chart_bars('5m', 'xag'), first)
            self.assertEqual(len(first), 11)
            version.return_value = (2, 100, 1)
            self.assertIsNot(load_chart_bars('5m', 'xag'), first)
            self.assertEqual(loader.call_count, 2)

    def test_api_accepts_timeframe_and_forwards_cursor(self):
        before = int(self.frame.index[8].timestamp())
        with patch('server.app.load_chart_bars', return_value=self.frame) as loader:
            response = history(CandleRequest(timeframe='5m', before=before, limit=3))
            loader.assert_called_once_with('5m', instrument='xag')
            self.assertEqual(response, candle_page(self.frame, before, 3))
        with patch('server.app.load_bars', return_value=(self.frame, {})):
            initial = run(Parameters(timeframe='5m'))
            self.assertEqual(initial['history']['nextBefore'], int(self.frame.index[0].timestamp()))
            self.assertFalse(initial['history']['hasMore'])

    def test_request_bounds(self):
        for values in [dict(limit=0),dict(limit=5001),dict(before=-1),dict(before=10**20),dict(timeframe='2m')]:
            with self.assertRaises(ValidationError):
                CandleRequest(**values)

    def test_weekend_prices_are_preserved_in_preview_and_paginated_history(self):
        index = pd.date_range('2026-11-13 23:55', '2026-11-16 00:05', freq='5min', tz='UTC')
        frame = pd.DataFrame({k: np.full(len(index), 70.) for k in ['open','high','low','close']}, index=index)
        expected = [int(stamp.timestamp()) for stamp in index]
        with patch('server.app.load_bars', return_value=(frame, {})):
            preview = run(Parameters(timeframe='5m'))
            self.assertEqual([row['time'] for row in preview['candles']], expected)
        with patch('server.app.load_chart_bars', return_value=frame):
            page = history(CandleRequest(timeframe='5m', limit=200))
            pages = [page]
            while page['hasMore']:
                page = history(CandleRequest(timeframe='5m', before=page['nextBefore'], limit=200))
                pages.append(page)
        candles = [row for page in reversed(pages) for row in page['candles']]
        self.assertEqual([row['time'] for row in candles], expected)
        self.assertTrue(all(right['time']-left['time'] == 300 for left, right in zip(candles, candles[1:])))


if __name__ == '__main__':
    unittest.main()

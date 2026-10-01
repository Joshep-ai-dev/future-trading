import json
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd
from pydantic import ValidationError

from .app import CandleRequest, Parameters, candle_page, history, run


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

    def test_empty_page_at_start_and_exact_page_boundary(self):
        first = int(self.frame.index[0].timestamp())
        self.assertEqual(candle_page(self.frame, before=first), dict(candles=[],hasMore=False,nextBefore=None))
        self.assertFalse(candle_page(self.frame, limit=11)['hasMore'])

    def test_api_accepts_timeframe_and_forwards_cursor(self):
        before = int(self.frame.index[8].timestamp())
        with patch('server.app.load_bars', return_value=(self.frame, {})) as loader:
            response = history(CandleRequest(timeframe='5m', before=before, limit=3))
            loader.assert_called_once_with('5m')
            self.assertEqual(response, candle_page(self.frame, before, 3))
            initial = run(Parameters(timeframe='5m'))
            self.assertEqual(initial['history']['nextBefore'], int(self.frame.index[0].timestamp()))
            self.assertFalse(initial['history']['hasMore'])

    def test_request_bounds(self):
        for values in [dict(limit=0),dict(limit=5001),dict(before=-1),dict(before=10**20),dict(timeframe='2m')]:
            with self.assertRaises(ValidationError):
                CandleRequest(**values)


if __name__ == '__main__':
    unittest.main()

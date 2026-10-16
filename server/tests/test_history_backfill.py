import tempfile
import time
import unittest
from pathlib import Path

import pandas as pd

from server.market.history_backfill import HistoryBackfill
from server.market.market_refresh import COLUMNS

MINUTE = 60_000


def row(stamp, confirmed='1'):
    return [str(stamp), '10', '11', '9', '10.5', '3', '0', '0', confirmed]


class HistoryBackfillTests(unittest.TestCase):
    def run_backfill(self, fetch, days=10_000 // 1440 + 1, flush_pages=2):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        source, history = Path(folder.name)/'source.csv', Path(folder.name)/'history.csv'
        start = int(time.time()*1000)//MINUTE*MINUTE-5*MINUTE
        pd.DataFrame([[start, 10, 11, 9, 10.5, 1]], columns=COLUMNS).to_csv(source, index=False)
        backfill = HistoryBackfill(sources=(source,), history=history, fetch=lambda after: fetch(after, start),
                                   flush_pages=flush_pages, pause=0)
        backfill.start(days)
        backfill.thread.join(5)
        return backfill, history, source, start

    def test_pages_backwards_until_okx_has_no_more_and_keeps_source_untouched(self):
        def fetch(after, start):
            if after <= start-6*MINUTE:
                return []
            return [row(after-MINUTE), row(after-2*MINUTE), row(after-3*MINUTE, confirmed='0')]
        backfill, history, source, start = self.run_backfill(fetch)
        saved = pd.read_csv(history)
        self.assertTrue(backfill.status()['reachedStart'])
        self.assertIsNone(backfill.status()['error'])
        self.assertTrue((saved.timestamp_ms < start).all())
        self.assertEqual(len(saved), saved.timestamp_ms.nunique())
        self.assertEqual(len(pd.read_csv(source)), 1)

    def test_stops_at_requested_start(self):
        def fetch(after, start):
            return [row(after-MINUTE*i) for i in range(1, 101)]
        backfill, history, _, start = self.run_backfill(fetch, days=1)
        saved = pd.read_csv(history)
        self.assertGreaterEqual(saved.timestamp_ms.min(), backfill.status()['targetStart']*1000)
        self.assertLessEqual(len(saved), 1440)

    def test_invalid_candles_are_rejected(self):
        def fetch(after, start):
            return [[str(after-MINUTE), '10', '9', '11', '10', '1', '0', '0', '1']] if after > start-3*MINUTE else []
        backfill, history, _, _ = self.run_backfill(fetch, flush_pages=1)
        self.assertIn('Invalid OHLCV', backfill.status()['error'])
        self.assertFalse(history.exists())


if __name__ == '__main__':
    unittest.main()

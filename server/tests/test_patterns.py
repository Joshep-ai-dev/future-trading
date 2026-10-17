import unittest

import numpy as np
import pandas as pd

from server.market.patterns import find_similar


def series(close):
    close = np.asarray(close, float)
    index = pd.date_range('2026-01-01', periods=len(close), freq='15min', tz='UTC')
    return pd.DataFrame(dict(open=close, high=close*1.001, low=close*.999, close=close), index=index)


class PatternTests(unittest.TestCase):
    def setUp(self):
        rng = np.random.default_rng(9)
        self.motif = np.r_[np.linspace(0, .02, 20), np.linspace(.02, -.01, 20)]
        noise = np.cumsum(rng.normal(0, .002, 2000))
        log_close = np.log(50)+noise
        self.planted = [300, 900, 1500]
        for start in self.planted:
            log_close[start:start+40] = log_close[start]+self.motif
        log_close[-40:] = log_close[-41]+self.motif  # Query ends with the same motif.
        self.bars = series(np.exp(log_close))

    def test_planted_patterns_rank_first(self):
        result = find_similar(self.bars, window=40, horizon=10, top_k=3)
        starts = sorted(int((pd.Timestamp(m['start'], unit='s', tz='UTC')-self.bars.index[0]).total_seconds()//900)
                        for m in result['matches'])
        self.assertEqual(starts, self.planted)
        self.assertTrue(all(m['correlation'] > .99 for m in result['matches']))

    def test_matches_never_overlap_the_present(self):
        result = find_similar(self.bars, window=40, horizon=10, top_k=20)
        latest_allowed = self.bars.index[-1-10]
        for match in result['matches']:
            future_end = pd.Timestamp(match['end'], unit='s', tz='UTC')+pd.Timedelta(minutes=15*10)
            self.assertLessEqual(future_end, self.bars.index[-1])
            self.assertLessEqual(pd.Timestamp(match['end'], unit='s', tz='UTC'), latest_allowed)

    def test_projection_bands_are_ordered_and_sized(self):
        result = find_similar(self.bars, window=40, horizon=10, top_k=15)
        projection = result['projection']
        for step in range(10):
            self.assertLessEqual(projection['low']['p10'][step], projection['low']['p50'][step])
            self.assertLessEqual(projection['close']['p10'][step], projection['close']['p90'][step])
            self.assertLessEqual(projection['high']['p50'][step], projection['high']['p90'][step])
        self.assertEqual(len(result['query']), 40)
        self.assertTrue(0 <= result['summary']['probabilityUp'] <= 1)

    def test_rejects_too_little_data(self):
        with self.assertRaises(ValueError):
            find_similar(self.bars.iloc[:60], window=40, horizon=10)


if __name__ == '__main__':
    unittest.main()

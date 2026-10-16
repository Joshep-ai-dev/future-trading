import unittest
import numpy as np
import pandas as pd
from server.strategies.indicators import atr


class AtrTests(unittest.TestCase):
    def test_wilder_seed_gap_and_reset(self):
        data = pd.DataFrame(np.zeros((6,4)), columns=['open','high','low','close'])
        data.iloc[:] = [[10,11,9,10],[14,15,13,14],[14,16,12,14],[np.nan]*4,[10,11,9,10],[10,12,8,10]]
        values = atr(data, 2)
        self.assertTrue(np.isnan(values[0]))
        self.assertEqual(values[1], 3.5)
        self.assertEqual(values[2], 3.75)
        self.assertTrue(np.isnan(values[4]))
        self.assertEqual(values[5], 3)


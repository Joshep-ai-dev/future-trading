import unittest
import numpy as np
import pandas as pd
from .indicators import rsi


class RsiTests(unittest.TestCase):
    def test_wilder_seed_and_updates(self):
        actual = rsi(pd.DataFrame(dict(close=[10.,11.,10.,12.,11.,13.])),3)
        self.assertTrue(np.isnan(actual[:3]).all())
        self.assertAlmostEqual(actual[3],75.)
        self.assertAlmostEqual(actual[4],600./11.)
        self.assertAlmostEqual(actual[5],75.)

    def test_one_sided_flat_and_missing_close(self):
        self.assertEqual(rsi(pd.DataFrame(dict(close=[1.,2.,3.])),2)[-1],100.)
        self.assertEqual(rsi(pd.DataFrame(dict(close=[3.,2.,1.])),2)[-1],0.)
        self.assertEqual(rsi(pd.DataFrame(dict(close=[1.,1.,1.])),2)[-1],50.)
        values = rsi(pd.DataFrame(dict(close=[1.,2.,3.,np.nan,4.,5.,6.])),2)
        self.assertTrue(np.isnan(values[3:6]).all())
        self.assertEqual(values[-1],100.)

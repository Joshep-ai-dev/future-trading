import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
import numpy as np
import pandas as pd
from .data import load_bars


class DataTests(unittest.TestCase):
    def test_csv_complete_bars_and_validation(self):
        with TemporaryDirectory() as folder:
            path=Path(folder)/'test.csv'
            ts=pd.date_range('2020',periods=120,freq='min',tz='UTC')
            df=pd.DataFrame(dict(timestamp_ms=ts.as_unit('ms').asi8,open=100,high=101,low=99,close=100,volume_contracts=1))
            df.drop(index=10).to_csv(path,index=False)
            bars,q=load_bars('1h',path)
            self.assertEqual(q['missingMinutes'],1)
            self.assertTrue(np.isnan(bars.close.iloc[0]))
            self.assertEqual(q['completeBars'],1)
            minute,q=load_bars('1m',path)
            self.assertEqual(len(minute),120)
            self.assertTrue(np.isnan(minute.close.iloc[10]))
            for timeframe, expected in [('3m', 39), ('5m', 23), ('10m', 11), ('30m', 3)]:
                aggregated, quality = load_bars(timeframe, path)
                self.assertEqual(quality['completeBars'], expected)
                self.assertEqual(quality['excludedBars'], 1)
            pd.concat([df,df.iloc[:1]]).to_csv(path,index=False)
            with self.assertRaises(ValueError): load_bars('1m',path)


if __name__ == '__main__': unittest.main()

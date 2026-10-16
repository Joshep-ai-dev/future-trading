import unittest
import pandas as pd
from server.market.chart_view import chart_view


class ChartViewTests(unittest.TestCase):
    def setUp(self):
        self.index = pd.date_range('2026-01-05', periods=15, freq='min', tz='UTC')
        self.start = int(self.index[0].timestamp())
        self.frame = pd.DataFrame(dict(open=range(100,115), high=range(102,117),
            low=range(99,114), close=range(101,116)), index=self.index)
        self.settings = dict(bb_length=2,bb_mult=2,sma_length=2)

    def test_five_minute_aggregation_and_causal_indicators(self):
        result = chart_view(self.frame, [], '5m', self.start+600, self.settings, True)
        self.assertEqual(len(result['candles']),2)
        self.assertEqual(result['candles'][0], dict(time=self.start,open=100.,high=106.,low=99.,close=105.))
        self.assertEqual(result['indicators'][-1]['bbBasis'],107.5)
        self.assertTrue(all(c['time']+300<=self.start+600 for c in result['candles']))

    def test_partial_bucket_and_missing_minutes(self):
        result = chart_view(self.frame, [], '5m', self.start+330, self.settings, True)
        self.assertEqual(len(result['candles']),1)
        self.assertEqual(result['forming']['time'],self.start+300)
        self.assertEqual(result['forming']['open'],105.)
        self.assertTrue(all(m['time']<=self.start+330 for m in result['minutes']))
        broken = chart_view(self.frame.drop(self.index[2]), [], '5m',self.start+600,self.settings,True)
        self.assertEqual([c['time'] for c in broken['candles']],[self.start+300])

    def test_snapshot_overrides_disk_and_timeframes_do_not_mutate_source(self):
        snapshot = [dict(time=self.start,open=120.,high=125.,low=119.,close=121.)]
        result = chart_view(self.frame,snapshot,'1m',self.start+60,self.settings,False)
        self.assertEqual(result['candles'][0]['close'],121.)
        self.assertEqual(self.frame.iloc[0].close,101)
        self.assertEqual(len(chart_view(self.frame,[],'15m',self.start+900,self.settings,True)['candles']),1)
        self.assertEqual(chart_view(self.frame,[],'1h',self.start+900,self.settings,True)['candles'],[])

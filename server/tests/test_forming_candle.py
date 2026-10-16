import unittest

from server.market.forming_candle import forming_candle, interpolate_minute


class FormingCandleTests(unittest.TestCase):
    def rows(self):
        return [dict(time=i*60,open=100+i,high=110+i,low=90+i,close=105+i) for i in range(10)]

    def test_one_second_replay_price_path_reveals_only_visited_extremes(self):
        row=self.rows()[0]
        first=interpolate_minute(row,1)
        second=interpolate_minute(row,2)
        self.assertNotEqual(first['close'],second['close'])
        self.assertLess(first['high'],row['high'])
        self.assertGreater(first['low'],row['low'])
        self.assertEqual(interpolate_minute(row,60),row)

    def test_five_minute_candle_combines_completed_and_partial_minutes(self):
        rows=self.rows()
        partial=forming_candle(rows,121,300,synthetic=True)
        self.assertEqual(partial['time'],0)
        self.assertEqual(partial['open'],100)
        self.assertEqual(partial['high'],111)
        self.assertEqual(partial['low'],90)
        self.assertEqual(partial['close'],interpolate_minute(rows[2],1)['close'])
        complete=forming_candle(rows,299.999,300,synthetic=True)
        self.assertEqual(complete['high'],114)
        self.assertEqual(complete['low'],90)
        self.assertAlmostEqual(complete['close'],109,places=2)
        next_bar=forming_candle(rows,300,300,synthetic=True)
        self.assertEqual(next_bar['time'],300)
        self.assertEqual(next_bar['open'],105)

    def test_other_timeframes_and_live_actual_minute_values(self):
        rows=self.rows()
        self.assertEqual(forming_candle(rows,121,60,synthetic=True)['time'],120)
        live=forming_candle(rows,121,600)
        self.assertEqual(live['close'],107)
        self.assertEqual(live['high'],112)
        self.assertEqual(live['time'],0)

    def test_missing_minutes_do_not_create_fake_candles(self):
        self.assertIsNone(forming_candle(self.rows()[1:],121,300,synthetic=True))
        self.assertIsNone(forming_candle(self.rows()[:1],121,300,synthetic=True))

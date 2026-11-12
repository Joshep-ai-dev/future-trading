import csv
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from server.market.orderflow_recorder import COLUMNS, MinuteAggregator, OrderflowRecorder, append_rows

MINUTE = 1794300000000


def book(ts, bid_size=3., ask_size=1., bid=51.0, ask=51.02):
    return dict(ts=str(ts), bids=[[str(bid), str(bid_size), '0', '1']]*5, asks=[[str(ask), str(ask_size), '0', '1']]*5)


class AggregatorTests(unittest.TestCase):
    def test_first_partial_minute_is_dropped_then_minutes_are_aggregated(self):
        agg = MinuteAggregator()
        self.assertEqual(agg.trade(dict(ts=MINUTE+30000, sz='5', px='51', side='buy')), [])
        rows = agg.book(book(MINUTE+60000))  # Rolls the partial first minute: nothing written.
        self.assertEqual(rows, [])
        agg.trade(dict(ts=MINUTE+61000, sz='2', px='51', side='buy'))
        agg.trade(dict(ts=MINUTE+62000, sz='6', px='52', side='sell'))
        agg.book(book(MINUTE+63000, bid_size=1., ask_size=3.))
        [row] = agg.trade(dict(ts=MINUTE+120000, sz='1', px='51', side='buy'))
        self.assertEqual(row['timestamp_ms'], MINUTE+60000)
        self.assertEqual((row['buy_volume'], row['sell_volume'], row['buy_trades'], row['sell_trades']), (2., 6., 1, 1))
        self.assertAlmostEqual(row['vwap'], (2*51+6*52)/8)
        self.assertEqual(row['largest_trade'], 6.)
        self.assertEqual(row['book_samples'], 2)
        self.assertAlmostEqual(row['imbalance_top5'], 0.)          # (+0.5 and -0.5) averaged
        self.assertAlmostEqual(row['imbalance_top5_last'], -.5)
        self.assertAlmostEqual(row['spread_mean'], .02)

    def test_recorder_routes_channels_and_writes_csv(self):
        with TemporaryDirectory() as folder:
            path = Path(folder)/'flow.csv'
            recorder = OrderflowRecorder(path)
            agg = MinuteAggregator(); agg.partial = False
            recorder.handle(agg, dict(arg=dict(channel='open-interest'), data=[dict(oi='1234')]))
            recorder.handle(agg, dict(arg=dict(channel='funding-rate'), data=[dict(fundingRate='0.0001')]))
            recorder.handle(agg, dict(arg=dict(channel='books5'), data=[book(MINUTE)]))
            rows = recorder.handle(agg, dict(arg=dict(channel='trades'), data=[dict(ts=str(MINUTE+60000), sz='1', px='51', side='sell')]))
            recorder._write(rows)
            append_rows(agg.flush(), path)
            with path.open() as handle:
                written = list(csv.DictReader(handle))
            self.assertEqual(list(written[0]), COLUMNS)
            self.assertEqual(len(written), 2)
            self.assertEqual(float(written[0]['open_interest']), 1234.)
            self.assertEqual(float(written[0]['funding_rate']), .0001)
            self.assertEqual(recorder.status()['rows'], 1)


if __name__ == '__main__':
    unittest.main()

import unittest

from server.market.okx_public_stream import LocalBook, ticker_view


class PublicTickerTests(unittest.TestCase):
    def test_reads_24_hour_statistics_and_base_volume(self) -> None:
        ticker = ticker_view(dict(last='66', open24h='60', high24h='68', low24h='59',
                                  volCcy24h='12345', vol24h='24690', ts='100'))
        self.assertEqual(ticker['last'], 66)
        self.assertAlmostEqual(ticker['percentage'], 10)
        self.assertEqual((ticker['high'], ticker['low'], ticker['baseVolume']), (68, 59, 12345))


class LocalBookTests(unittest.TestCase):
    def test_snapshot_then_updates_with_removals(self) -> None:
        book = LocalBook()
        self.assertTrue(book.apply('snapshot', {'bids': [['30.0', '10', '0', '1'], ['29.9', '5', '0', '1']],
                                                'asks': [['30.1', '4', '0', '1']], 'seqId': 1, 'ts': '100'}))
        self.assertTrue(book.apply('update', {'bids': [['29.9', '0', '0', '0'], ['30.05', '2', '0', '1']],
                                              'asks': [], 'seqId': 2, 'prevSeqId': 1, 'ts': '101'}))
        view = book.view(0.5)
        self.assertEqual(view['bids'], [[30.05, 1.0], [30.0, 5.0]])
        self.assertEqual(view['asks'], [[30.1, 2.0]])
        self.assertEqual(view['timestamp'], 101)

    def test_sequence_gap_requests_resubscribe(self) -> None:
        book = LocalBook()
        book.apply('snapshot', {'bids': [], 'asks': [], 'seqId': 5, 'ts': '1'})
        self.assertFalse(book.apply('update', {'bids': [], 'asks': [], 'seqId': 9, 'prevSeqId': 7}))


if __name__ == '__main__':
    unittest.main()

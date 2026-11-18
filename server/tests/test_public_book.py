import unittest

from server.market.public_book import snapshot


class PublicBookTests(unittest.TestCase):
    def test_okx_rows_convert_to_stream_shapes_in_base_units(self) -> None:
        books = [{'bids': [['30.10', '20', '0', '3']], 'asks': [['30.12', '10', '0', '1']], 'ts': '1700000000000'}]
        trades = [{'tradeId': '9', 'side': 'buy', 'px': '30.11', 'sz': '4', 'ts': '1700000000500'}]
        result = snapshot(books, trades, 0.5)
        self.assertEqual(result['orderBook'], {'bids': [[30.10, 10.0]], 'asks': [[30.12, 5.0]], 'timestamp': 1700000000000})
        self.assertEqual(result['trades'], [{'id': '9', 'side': 'buy', 'price': 30.11, 'quantity': 2.0, 'timestamp': 1700000000500}])

    def test_empty_response_gives_empty_book(self) -> None:
        result = snapshot([], [], 1.0)
        self.assertEqual(result['orderBook']['bids'], [])
        self.assertEqual(result['trades'], [])


if __name__ == '__main__':
    unittest.main()

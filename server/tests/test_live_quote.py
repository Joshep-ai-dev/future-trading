import unittest
from unittest.mock import patch

from server.market import live_quote


class LiveQuoteTests(unittest.TestCase):
    def payload(self, price='50.25', stamp='1000000'):
        return {'code': '0', 'data': [{'instId': 'XAG-USDT-SWAP', 'last': price, 'ts': stamp}]}

    def test_live_quote_preserves_exchange_price_and_timestamp(self):
        quote = live_quote.parse_quote(self.payload(), 1002)
        self.assertEqual(quote['price'], 50.25)
        self.assertEqual(quote['time'], 1000)
        self.assertFalse(quote['stale'])
        self.assertTrue(live_quote.parse_quote(self.payload(), 1061)['stale'])

    def test_invalid_and_future_quotes_are_rejected(self):
        for price in ('nan', 'inf', '-1', '0'):
            with self.subTest(price=price), self.assertRaises(ValueError):
                live_quote.parse_quote(self.payload(price=price), 1000)
        with self.assertRaises(ValueError):
            live_quote.parse_quote(self.payload(stamp='2000000'), 1000)
        with self.assertRaises(ValueError):
            live_quote.parse_quote({'code': '1', 'data': []}, 1000)

    def test_cache_limits_calls_and_does_not_mask_feed_failure(self):
        quote = live_quote.parse_quote(self.payload(), 1000)
        with patch.object(live_quote, '_CACHE', None), patch.object(live_quote, '_FETCHED', 0), patch.object(live_quote, 'fetch_silver_quote', return_value=quote) as fetch, patch.object(live_quote.time, 'time', side_effect=[1000, 1001, 1003]):
            self.assertEqual(live_quote.silver_quote()['price'], 50.25)
            live_quote.silver_quote()
            fetch.assert_called_once()
            fetch.side_effect = OSError('offline')
            with self.assertRaises(OSError):
                live_quote.silver_quote()

    def test_quote_api_reports_outage_instead_of_inventing_price(self):
        from fastapi import HTTPException
        from server.app import forecast_quote
        with patch('server.app.silver_quote', side_effect=OSError('offline')):
            with self.assertRaises(HTTPException) as caught:
                forecast_quote()
        self.assertEqual(caught.exception.status_code, 503)


if __name__ == '__main__':
    unittest.main()

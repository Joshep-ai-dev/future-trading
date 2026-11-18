import threading
import unittest
from unittest.mock import patch

import ccxt

from server.exchanges.live_exchange import LiveExchange, RateLimitedError


class DisplayReadTests(unittest.TestCase):
    def setUp(self) -> None:
        self.service = LiveExchange()
        self.service.clients['hyperliquid'] = object()
        self.calls = 0

    def fetch(self):
        self.calls += 1
        return self.calls

    def test_identical_reads_share_one_request_until_invalidated(self) -> None:
        self.assertEqual(self.service.display_read('hyperliquid', 'positions', 5, self.fetch), 1)
        self.assertEqual(self.service.display_read('hyperliquid', 'positions', 5, self.fetch), 1)
        self.service.invalidate_reads('hyperliquid')
        self.assertEqual(self.service.display_read('hyperliquid', 'positions', 5, self.fetch), 2)

    def test_rate_limit_reuses_last_value_and_pauses_requests(self) -> None:
        self.service.display_read('hyperliquid', 'orders', 0, self.fetch)

        def limited():
            raise ccxt.RateLimitExceeded('429 Too Many Requests')

        self.assertEqual(self.service.display_read('hyperliquid', 'orders', 0, limited), 1)
        # During the cooldown no request is sent and the cached value is reused.
        self.assertEqual(self.service.display_read('hyperliquid', 'orders', 0, self.fetch), 1)
        self.assertEqual(self.calls, 1)

    def test_rate_limit_without_cached_value_raises_a_clear_error(self) -> None:
        def limited():
            raise ccxt.DDoSProtection('429')

        with self.assertRaises(RateLimitedError):
            self.service.display_read('hyperliquid', 'history', 0, limited)
        with self.assertRaises(RateLimitedError):
            self.service.display_read('hyperliquid', 'history', 0, self.fetch)
        self.assertEqual(self.calls, 0)

    def test_concurrent_reads_wait_for_one_request(self) -> None:
        gate = threading.Event()

        def slow():
            gate.wait(1)
            return self.fetch()

        results = []
        threads = [threading.Thread(target=lambda: results.append(self.service.display_read('hyperliquid', 'balance', 5, slow)))
                   for _ in range(4)]
        for thread in threads:
            thread.start()
        gate.set()
        for thread in threads:
            thread.join()
        self.assertEqual(results, [1, 1, 1, 1])
        self.assertEqual(self.calls, 1)


if __name__ == '__main__':
    unittest.main()

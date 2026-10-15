import io
import json
import unittest
from unittest.mock import patch
from .htx_costs import fetch_htx_costs


class HTXCostTests(unittest.TestCase):
    def test_interval_conversion_and_spread(self):
        payloads = [dict(status='ok', data=dict(funding_rate='.0001', funding_time=0, next_funding_time=14400000)),
                    dict(status='ok', tick=dict(bid=[80,1], ask=[80.02,1]))]
        with patch('server.htx_costs.urlopen', side_effect=[io.BytesIO(json.dumps(p).encode()) for p in payloads]):
            result = fetch_htx_costs()
        self.assertAlmostEqual(result['funding_bps'], 2.)
        self.assertAlmostEqual(result['spread'], .02)
        self.assertEqual(result['intervalHours'], 4.)

    def test_api_error_does_not_invent_rates(self):
        with patch('server.htx_costs.urlopen', return_value=io.BytesIO(b'{"status":"error"}')):
            with self.assertRaises(ValueError):
                fetch_htx_costs()

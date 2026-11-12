import io
import json
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from server.app import live_chart_candles
from server.market.forming_candle import fetch_live_minutes


class LiveChartCandleTests(unittest.TestCase):
    def test_display_feed_runs_without_creating_a_trading_workspace(self):
        rows = [dict(time=960, open=10, high=12, low=9, close=11, volume=7)]
        with patch('server.app.workspaces.minute_feed', return_value=rows) as feed, \
                patch('server.app.workspaces.get') as workspace, patch('server.app.time.time', return_value=1000):
            result = live_chart_candles()
        feed.assert_called_once_with(300)
        workspace.assert_not_called()
        self.assertEqual(result['candles'], rows)
        self.assertEqual(result['checkedAt'], 1000)
        self.assertFalse(result['stale'])

    def test_stale_feed_is_labeled_and_failures_are_reported(self):
        with patch('server.app.workspaces.minute_feed', return_value=[dict(time=60)]), \
                patch('server.app.time.time', return_value=1000):
            self.assertTrue(live_chart_candles()['stale'])
        for value in ([], OSError('offline')):
            with self.subTest(value=value), patch('server.app.workspaces.minute_feed') as feed:
                if isinstance(value, Exception):
                    feed.side_effect = value
                else:
                    feed.return_value = value
                with self.assertRaises(HTTPException) as caught:
                    live_chart_candles()
                self.assertEqual(caught.exception.status_code, 503)

    def test_live_minutes_preserve_exchange_volume_and_sort(self):
        payload = dict(code='0', data=[['120000', '10', '12', '9', '11', '7'],
                                       ['60000', '10', '12', '9', '10', '3']])
        with patch('server.market.forming_candle.urlopen', return_value=io.StringIO(json.dumps(payload))):
            rows = fetch_live_minutes(300)
        self.assertEqual([row['time'] for row in rows], [60, 120])
        self.assertEqual([row['volume'] for row in rows], [3, 7])
        for volume in ('nan', '-1'):
            payload['data'][0][5] = volume
            with self.subTest(volume=volume), \
                    patch('server.market.forming_candle.urlopen', return_value=io.StringIO(json.dumps(payload))), \
                    self.assertRaises(ValueError):
                fetch_live_minutes()

import unittest
import json
import numpy as np
import pandas as pd
from pydantic import ValidationError
from .test_mtf import settings, frame, fake_indicators
from .indicators import indicators
from .mtf import build_orders, alignment
from .strategy import session_at, simulate, seconds


class IndicatorSettingsTests(unittest.TestCase):
    def test_custom_periods_seed_and_update(self):
        result = indicators(frame(closes=np.arange(1, 15)), 3, 5, 2)
        self.assertTrue(np.isnan(result.ema20.iloc[1]))
        self.assertEqual(result.ema20.iloc[2], 2)
        self.assertEqual(result.ema20.iloc[3], 3)
        self.assertEqual(result.ema50.iloc[4], 3)
        self.assertEqual(result.ema50.iloc[5], 4)
        self.assertTrue(np.isnan(result.rsi20.iloc[1]))
        self.assertEqual(result.rsi20.iloc[2], 100)
        result = indicators(frame(closes=[10, 12, 11, 13]), 1, 2, 2)
        self.assertAlmostEqual(result.rsi20.iloc[2], 100-100/3)
        self.assertAlmostEqual(result.rsi20.iloc[3], 100-100/7)

    def test_rsi_disabled_does_not_block_ema_or_require_rsi_warmup(self):
        data = frame(count=5)
        calc = fake_indicators(data)
        calc.rsi20 = np.nan
        cfg = settings(direction_active=False, setup_active=False, rsi_active=False)
        orders = build_orders({'5m': data}, cfg, {'5m': calc})
        self.assertIn(0, orders)
        self.assertIsNone(orders[0]['confirmations'][0]['rsi20'])
        json.dumps(orders, allow_nan=False)
        cfg = settings(direction_active=False, setup_active=False, rsi_active=True)
        self.assertEqual(build_orders({'5m': data}, cfg, {'5m': calc}), {})
        self.assertEqual(alignment([101, 100, 55], threshold=60), 0)
        self.assertEqual(alignment([101, 100, 65], threshold=60), 1)
        self.assertEqual(alignment([99, 100, 55], threshold=60), -1)

    def test_invalid_settings(self):
        for change in [dict(ema_fast=50), dict(ema_fast=0), dict(ema_slow=1),
                       dict(rsi_period=0), dict(rsi_threshold=100), dict(rsi_threshold=0)]:
            with self.assertRaises(ValidationError):
                settings(**change)

    def test_weekends_use_selected_timezone(self):
        cfg = settings(session_timezone='Asia/Shanghai')
        stamp = lambda s: int(pd.Timestamp(s).timestamp())
        self.assertIsNotNone(session_at(stamp('2026-09-25T15:55Z'), cfg))
        self.assertIsNone(session_at(stamp('2026-09-25T16:00Z'), cfg))
        self.assertIsNone(session_at(stamp('2026-09-27T15:55Z'), cfg))
        self.assertIsNotNone(session_at(stamp('2026-09-27T16:00Z'), cfg))

    def test_friday_position_closes_and_weekend_orders_cannot_fill(self):
        for strategy in ['mtf', 'sweep']:
            cfg = settings(strategy=strategy, start_date='2026-09-25', validation_date='2026-09-28', end_date='2026-09-29')
            data = frame(count=580)
            data.index = pd.date_range('2026-09-25T23:45Z', periods=len(data), freq='5min')
            order = dict(direction=1, orderType='market', trigger=None, stop=90,
                         obstacle=None, blocked=False, swingHighs=[], swingLows=[], sweepLevel=None)
            orders = {i: order for i in range(len(data))}
            result = simulate(data, [], cfg, seconds(cfg.start_date), seconds(cfg.validation_date), 'Test', 300, orders)
            self.assertEqual(len(result['trades']), 1)
            trade = result['trades'][0]
            self.assertEqual(trade['exitReason'], 'session_end')
            self.assertEqual(pd.Timestamp(trade['exitTime'], unit='s', tz='UTC').isoformat(), '2026-09-25T23:55:00+00:00')

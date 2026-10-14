import unittest
from datetime import date

import numpy as np
import pandas as pd
from pydantic import ValidationError

from .chartart_v12 import build_orders, run_chartart_v12_backtest, weekday_bars
from .strategy import BacktestRequest, seconds, simulate


class ChartArtV12Tests(unittest.TestCase):
    def test_open_position_survives_excluded_weekend_bars(self):
        index = pd.to_datetime(['2026-04-03T23:45Z', '2026-04-03T23:50Z',
                                '2026-04-04T00:00Z', '2026-04-06T00:00Z',
                                '2026-04-06T00:05Z'])
        frame = pd.DataFrame({'open': [100.] * 5, 'high': [101.] * 5,
                              'low': [99.] * 5, 'close': [100.] * 5}, index=index)
        frame.iloc[2, :] = np.nan
        cfg = BacktestRequest(strategy='chartart_v12', start_date='2026-04-03',
                              validation_date='2026-04-07', end_date='2026-04-08',
                              fee_bps=0, spread=0, slippage=0, stop_mode='none')
        order = dict(direction=1, orderType='market', trigger=None, stop=99.,
                     sweepLevel=None, obstacle=None, blocked=False,
                     swingHighs=[], swingLows=[])
        result = simulate(frame, [], cfg, seconds(date(2026, 4, 3)),
                          seconds(date(2026, 4, 7)), 'Test', 300,
                          {0: order}, excluded=np.array([False, False, True, False, False]))
        self.assertEqual(len(result['trades']), 1)
        self.assertEqual(result['trades'][0]['entryTime'], int(index[1].timestamp()))
        self.assertEqual(result['trades'][0]['exitTime'], int(index[-1].timestamp()))
        self.assertEqual(result['trades'][0]['exitReason'], 'period_end')

    def test_entry_needs_both_crossovers_and_only_goes_long(self):
        index = pd.date_range('2026-04-06', periods=4, freq='5min', tz='UTC')
        frame = pd.DataFrame({'low': [9.] * 4}, index=index)
        # basis, upper, RSI, close, lower
        values = np.array([[10, 12, 49, 9, 10], [10, 12, 51, 11, 10],
                           [10, 12, 49, 9, 10], [10, 12, 51, 9.5, 10]], dtype=float)
        orders = build_orders(frame, values, 300)
        self.assertEqual(list(orders), [1])
        self.assertEqual((orders[1]['direction'], orders[1]['trigger']), (1, 10.))
        self.assertEqual(orders[1]['stop'], 9.)

    def test_unsupported_stop_management_is_rejected(self):
        with self.assertRaises(ValidationError):
            BacktestRequest(strategy='chartart_v12', start_date='2026-04-06',
                            validation_date='2026-04-07', end_date='2026-04-08',
                            stop_mode='trailing')
        for stop_pct in (0, 100):
            with self.assertRaises(ValidationError):
                BacktestRequest(strategy='chartart_v12', start_date='2026-04-06',
                                validation_date='2026-04-07', end_date='2026-04-08',
                                chartart_stop_pct=stop_pct)

    def test_simultaneous_crossunders_close_next_open(self):
        index = pd.date_range('2026-04-06', periods=4, freq='5min', tz='UTC')
        frame = pd.DataFrame({'open': [100.] * 4, 'high': [102.] * 4,
                              'low': [98.] * 4, 'close': [100.] * 4}, index=index)
        cfg = BacktestRequest(strategy='chartart_v12', start_date='2026-04-06',
                              validation_date='2026-04-07', end_date='2026-04-08',
                              fee_bps=0, spread=0, slippage=0, stop_mode='none')
        order = dict(direction=1, orderType='stop', trigger=100., stop=98.,
                     sweepLevel=None, obstacle=None, blocked=False,
                     swingHighs=[], swingLows=[])
        values = np.array([[100, 101, 49, 100, 99], [100, 101, 51, 102, 99],
                           [100, 101, 49, 100, 99], [100, 101, 49, 100, 99]], dtype=float)
        trade = simulate(frame, [], cfg, seconds(date(2026, 4, 6)),
                         seconds(date(2026, 4, 7)), 'Test', 300,
                         {0: order}, values)['trades'][0]
        self.assertEqual(trade['exitReason'], 'rsi_bb_close')
        self.assertEqual(trade['exitTime'], int(index[3].timestamp()))
        self.assertIsNone(trade['stop'])
        self.assertIsNone(trade['target'])

    def test_enabled_stop_loss_uses_selected_percent_below_entry(self):
        index = pd.date_range('2026-04-06', periods=4, freq='5min', tz='UTC')
        frame = pd.DataFrame({'open': [100., 100., 101., 99.],
                              'high': [101., 102., 102., 100.],
                              'low': [99., 99.5, 97., 98.],
                              'close': [100., 101., 99., 99.]}, index=index)
        cfg = BacktestRequest(strategy='chartart_v12', start_date='2026-04-06',
                              validation_date='2026-04-07', end_date='2026-04-08',
                              fee_bps=0, spread=0, slippage=0,
                              chartart_stop_pct=1.5)
        order = dict(direction=1, orderType='stop', trigger=100., stop=98.,
                     sweepLevel=None, obstacle=None, blocked=False,
                     swingHighs=[], swingLows=[])
        trade = simulate(frame, [], cfg, seconds(date(2026, 4, 6)),
                         seconds(date(2026, 4, 7)), 'Test', 300,
                         {0: order})['trades'][0]
        self.assertEqual(trade['exitReason'], 'stop')
        self.assertEqual(trade['exitTime'], int(index[2].timestamp()))
        self.assertEqual(trade['stop'], 98.5)
        self.assertIsNone(trade['target'])

    def test_weekend_candles_are_excluded_and_monday_warms_up(self):
        index = pd.date_range('2026-04-03 23:00', '2026-04-06 01:00', freq='5min', tz='UTC')
        close = np.linspace(70., 72., len(index))
        frame = pd.DataFrame({'open': close, 'high': close+.1,
                              'low': close-.1, 'close': close}, index=index)
        cfg = BacktestRequest(strategy='chartart_v12', start_date='2026-04-03',
            validation_date='2026-04-06', end_date='2026-04-06',
            entry_timeframe='5m', bb_period=3, rsi_period=2)
        result = run_chartart_v12_backtest(frame, cfg)
        self.assertTrue(all(pd.Timestamp(c['time'], unit='s', tz='UTC').dayofweek < 5 for c in result['candles']))
        self.assertTrue(all(t['direction'] == 1 for period in ('research','validation') for t in result[period]['trades']))
        monday = [p for p in result['indicators'] if pd.Timestamp(p['time'], unit='s', tz='UTC').dayofweek == 0]
        self.assertIsNone(monday[0]['bbBasis'])
        self.assertIsNotNone(monday[2]['bbBasis'])
        local = pd.date_range('2026-04-03 15:55', periods=2, freq='5min', tz='UTC')
        self.assertEqual(weekday_bars(local, 300, 'Asia/Shanghai').tolist(), [True, False])


if __name__ == '__main__':
    unittest.main()

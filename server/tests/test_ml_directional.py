import unittest
from types import SimpleNamespace

import numpy as np
import pandas as pd

from server.strategies.ml.directional import (FOLD_CACHE, DirectionalSettings, barrier_labels, build_features,
                                              directional_readiness, fold_bounds, run_directional)
from server.strategies.registry import MLDirectional, get_strategy
from server.strategies.strategy import BacktestRequest

FAST = dict(train_days=7, trade_days=3, trees=20, min_leaf=20, max_hold_bars=12, take_profit_atr=1.5, stop_atr=1.,
            min_probability=0., min_ev_r=-10., min_gap=0., vol_low_pct=0., vol_high_pct=100.)


def candles(count=6000, seed=3, start='2026-01-01'):
    rng = np.random.default_rng(seed)
    close = 50+np.cumsum(rng.normal(0, .05, count))
    open_ = np.r_[close[0], close[:-1]]
    spread = np.abs(rng.normal(0, .03, count))
    index = pd.date_range(start, periods=count, freq='5min', tz='UTC')
    return pd.DataFrame(dict(open=open_, high=np.maximum(open_, close)+spread, low=np.minimum(open_, close)-spread,
                             close=close, volume=rng.uniform(100, 200, count)), index=index)


class LabelTests(unittest.TestCase):
    def frame(self, rows):
        index = pd.date_range('2026-01-01', periods=len(rows), freq='5min', tz='UTC')
        return pd.DataFrame(rows, columns=['open', 'high', 'low', 'close'], index=index)

    def test_target_before_stop_is_a_win(self):
        frame = self.frame([[10, 10, 10, 10], [10, 10.5, 9.9, 10.4], [10.4, 12, 10.3, 11.9], [12, 12, 12, 12]])
        settings = DirectionalSettings(take_profit_atr=1.5, stop_atr=1., max_hold_bars=2)
        long, short = barrier_labels(frame, np.ones(4), settings, 300)
        self.assertEqual(long[0], 1.)  # entry 10 at bar 1 open, target 11.5 hit on bar 2
        self.assertEqual(short[0], 0.)  # short target 8.5 never reached, stop 11 hit on bar 2

    def test_bar_touching_both_barriers_is_a_loss_and_incomplete_window_is_nan(self):
        frame = self.frame([[10, 10, 10, 10], [10, 12, 8, 10], [10, 10, 10, 10]])
        settings = DirectionalSettings(take_profit_atr=1.5, stop_atr=1., max_hold_bars=2)
        long, short = barrier_labels(frame, np.ones(3), settings, 300)
        self.assertEqual((long[0], short[0]), (0., 0.))
        self.assertTrue(np.isnan(long[2]))

    def test_window_across_data_gap_is_unlabelled(self):
        frame = self.frame([[10, 10, 10, 10]]*6)
        frame.index = frame.index[:3].append(frame.index[3:]+pd.Timedelta(hours=5))
        long, _ = barrier_labels(frame, np.ones(6), DirectionalSettings(max_hold_bars=2), 300)
        self.assertTrue(np.isnan(long[1]))
        self.assertEqual(long[3], 0.)


class FeatureTests(unittest.TestCase):
    def test_features_do_not_use_future_candles(self):
        frame = candles(2000)
        atr = pd.Series(np.ones(len(frame)), index=frame.index)
        base = build_features(frame, 300, atr)
        changed = frame.copy()
        changed.iloc[1500:, :4] *= 1.5
        after = build_features(changed, 300, atr)
        pd.testing.assert_frame_equal(base.iloc[:1500], after.iloc[:1500])

    def test_fold_bounds_are_calendar_aligned(self):
        settings = DirectionalSettings(trade_days=30)
        period = 30*86400
        self.assertEqual(fold_bounds(period+5, 3*period-1, settings), [period, 2*period])


class BacktestTests(unittest.TestCase):
    def setUp(self):
        FOLD_CACHE.clear()

    def test_engine_contract_audit_and_report(self):
        frame = candles()
        start = frame.index[3500]
        result = run_directional(frame, DirectionalSettings(**FAST), initial_capital=1000, leverage=1, start=start,
                                 close_at_end=True, bar_seconds=300, fee_bps=5, slippage=.01, spread=.01)
        self.assertTrue({'bars', 'trades', 'open_position', 'cash', 'report'} <= set(result))
        self.assertTrue(result['audit']['passed'])
        self.assertGreater(len(result['trades']), 0)
        self.assertTrue((result['trades'].entry_time > start).all())  # Entries fill at the next open.
        self.assertEqual(result['bars'].index[0], start)
        report = result['report']
        self.assertEqual(report['kind'], 'ml_directional')
        self.assertTrue(report['folds'])
        for fold in report['folds']:
            self.assertLess(fold['trainEnd'], fold['start'])
        comparison = report['predictionVsActual']
        self.assertEqual(comparison['trades'], len(result['trades']))
        self.assertEqual(len(comparison['rows']), len(result['trades']))
        bars, trades = result['bars'], result['trades']
        for row, (_, trade) in zip(comparison['rows'], trades.iterrows()):
            signal = bars.index[bars.index.get_loc(trade.entry_time)-1]  # Signal candle = candle before the next-open entry.
            expected = bars.at[signal, 'p_long' if trade.direction == 1 else 'p_short']
            self.assertAlmostEqual(row['predicted'], expected)
            self.assertEqual(row['reachedTarget'], trade.exit_reason == 'take_profit')

    def test_trading_decisions_do_not_change_when_future_candles_change(self):
        frame = candles()
        settings = DirectionalSettings(**FAST)
        start, cut = frame.index[3500], 4500
        first = run_directional(frame.iloc[:cut], settings, initial_capital=1000, leverage=1, start=start, bar_seconds=300)
        changed = frame.copy()
        changed.iloc[cut:, :4] *= 1.2
        second = run_directional(changed, settings, initial_capital=1000, leverage=1, start=start, bar_seconds=300)
        columns = ['p_long', 'p_short', 'ml_signal']
        pd.testing.assert_frame_equal(first['bars'][columns].iloc[:-1], second['bars'][columns].iloc[:cut-3500-1])

    def test_long_only_never_shorts(self):
        result = run_directional(candles(), DirectionalSettings(**{**FAST, 'trade_mode': 'Long Only'}),
                                 initial_capital=1000, leverage=1, start=candles().index[3500], bar_seconds=300)
        self.assertTrue((result['trades'].direction == 1).all())

    def test_trades_per_day_mode_caps_entries_per_utc_day(self):
        frame = candles(9000)
        settings = DirectionalSettings(**{**FAST, 'trades_per_day': 1})
        result = run_directional(frame, settings, initial_capital=1000, leverage=1, start=frame.index[3500],
                                 close_at_end=True, bar_seconds=300)
        trades = result['trades']
        self.assertGreater(len(trades), 5)
        self.assertEqual(trades.entry_time.dt.floor('D').value_counts().max(), 1)
        bars = result['bars']
        signalled = bars[bars.ml_signal != 0]
        best = signalled[['p_long', 'p_short']].max(axis=1)
        self.assertTrue((best > signalled.rank_threshold).all())  # Beats the trailing window's best score.
        self.assertTrue(result['audit']['passed'])

    def test_readiness_reports_probabilities_and_checks(self):
        bar = SimpleNamespace(p_long=.6, p_short=.3, ev_long=.4, ev_short=-.3, vol_ok=True, ml_signal=1., atr=.1)
        state = directional_readiness(bar, DirectionalSettings())
        self.assertEqual(state['signal'], 'long')
        self.assertEqual(state['longReadiness'], 100)
        self.assertLess(state['shortReadiness'], 100)
        self.assertEqual(state['indicators']['pLong'], .6)


class DailyCapTests(unittest.TestCase):
    def test_engine_allows_at_most_n_entries_per_utc_day(self):
        from server.strategies.execution import ExecutionSettings, run_signal_backtest
        index = pd.date_range('2026-01-01 20:00', periods=60, freq='5min', tz='UTC')
        bars = pd.DataFrame(dict(open=100., high=100.5, low=99.5, close=100.), index=index)
        signals = np.ones(len(bars))  # Wants to enter on every candle.
        settings = ExecutionSettings(initial_capital=1000, max_hold_bars=1, reverse_on_signal=False, next_open=True,
                                     max_entries_per_day=1)
        result = run_signal_backtest(bars, signals, np.full(len(bars), 5.), np.full(len(bars), 5.), settings, bar_seconds=300)
        days = result['trades'].entry_time.dt.floor('D').value_counts()
        self.assertEqual(sorted(days.tolist()), [1, 1])  # One entry on each of the two UTC days.
        with self.assertRaises(ValueError):
            ExecutionSettings(max_entries_per_day=-1)


class RunnerTests(unittest.TestCase):
    def test_registered_backtest_and_paper_only(self):
        runner = get_strategy('ml_directional')
        self.assertFalse(runner.live_supported)

    def test_request_validates_settings(self):
        request = BacktestRequest(start_date='2026-01-01', end_date='2026-01-02', strategy='ml_directional',
                                  ml_directional={'stop_atr': 2})
        self.assertEqual(request.ml_directional['stop_atr'], 2)
        for bad in ({'stop_atr': 0}, {'unknown': 1}, {'vol_low_pct': 90, 'vol_high_pct': 50}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                BacktestRequest(start_date='2026-01-01', end_date='2026-01-02', strategy='ml_directional', ml_directional=bad)

    def test_short_paper_frame_is_extended_from_market_history(self):
        FOLD_CACHE.clear()
        full = candles()
        calls = []

        def loader(timeframe, instrument='xag'):
            calls.append((timeframe, instrument))
            return full, None
        runner = MLDirectional(loader=loader)
        request = SimpleNamespace(ml_directional=FAST, entry_timeframe='5m', market='xag', capital=1000, max_leverage=1,
                                  tick_size=.01, fee_bps=0, slippage=0, spread=0, funding_bps=0)
        start = full.index[5000]
        short = runner.run(full.iloc[4800:], request, start=start, bar_seconds=300)
        complete = runner.run(full, request, start=start, bar_seconds=300)
        self.assertEqual(calls[0], ('5m', 'xag'))
        np.testing.assert_allclose(short['bars'].p_long.to_numpy(), complete['bars'].p_long.to_numpy(), atol=1e-6)


if __name__ == '__main__':
    unittest.main()

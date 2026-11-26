import unittest
from dataclasses import replace

import numpy as np
import pandas as pd

from server.strategies.st_scalper import Settings, entries, indicators, metrics, news_blocked, run_backtest, simulate, variant
from server.strategies.st_scalper_lab import Lab, compare, optimize, splits
from server.tests.test_ml_strategy import market

OPEN = dict(use_trend_filter=False, use_adx_filter=False, use_rsi_filter=False, use_volatility_filter=False,
            use_session_filter=False, use_news_filter=False, use_regime_filter=False)


def flat_frame(prices, start='2026-03-02 00:00'):
    """Hand-made 5m candles: (open, high, low, close) rows."""
    index = pd.date_range(start, periods=len(prices), freq='5min', tz='UTC')
    return pd.DataFrame(prices, columns=['open', 'high', 'low', 'close'], index=index, dtype=float)


class ScalperTests(unittest.TestCase):
    def setUp(self):
        self.frame = market(4000)

    def test_default_entries_require_a_flip_and_atr_strictly_above_minimum(self) -> None:
        settings = Settings()
        bars = pd.DataFrame({
            'st_line': [10.] * 6,
            'atr': [.02, .03, .031, .031, .031, np.nan],
            'flip_up': [True, True, True, False, False, True],
            'flip_down': [False, False, False, True, False, False],
        })

        signals = entries(bars, settings, 300)

        self.assertEqual(settings.st_multiplier, 1.5)
        self.assertEqual(signals.entry_long.tolist(), [False, False, True, False, False, False])
        self.assertEqual(signals.entry_short.tolist(), [False, False, False, True, False, False])

    def test_signals_and_higher_timeframe_are_causal(self):
        s = Settings(**{**OPEN, 'use_trend_filter': True, 'use_adx_filter': True, 'use_rsi_filter': True})
        full = indicators(self.frame, s, 300)
        cut = indicators(self.frame.iloc[:2500], s, 300)
        columns = ['st_line', 'st_direction', 'ema_fast', 'htf_close', 'htf_ema', 'adx', 'rsi', 'atr', 'regime']
        pd.testing.assert_frame_equal(full[columns].iloc[:2500], cut[columns], check_dtype=False)
        a, b = entries(full, s, 300), entries(cut, s, 300)
        pd.testing.assert_frame_equal(a.iloc[:2500], b, check_dtype=False)

    def test_htf_value_is_the_last_completed_15m_candle(self):
        s = Settings(htf_ema_length=2)
        bars = indicators(self.frame, s, 300)
        t = bars.index[1000]
        # The 5m candle opening at t closes at t+5m; the newest 15m candle known then closed at or before t+5m.
        known = (t+pd.Timedelta(minutes=5)).floor('15min')
        expected = self.frame.close.loc[:known-pd.Timedelta(minutes=5)].iloc[-1]
        self.assertAlmostEqual(bars.htf_close.loc[t], expected)

    def test_entries_fill_at_the_next_open_with_costs(self):
        s = Settings(**OPEN, use_atr_exits=False)
        result = run_backtest(self.frame, s, bar_seconds=300, slippage=.01, spread=.02, fee_bps=0)
        trades = result['trades']
        self.assertGreater(len(trades), 3)
        for trade in trades.head(5).to_dict('records'):
            signal = trade['entry_time']
            nxt = self.frame.index[self.frame.index.get_loc(signal)+1]
            self.assertAlmostEqual(trade['reference_entry'], self.frame.open.loc[nxt])
            self.assertAlmostEqual(trade['entry_price'], self.frame.open.loc[nxt]+trade['direction']*(.01+.01))

    def test_stop_first_and_gap_fills(self):
        s = Settings(**OPEN, stop_atr=1, target_atr=1, breakeven_atr=0, trail_atr=0, max_hold_bars=50, exit_on_flip=False)
        rows = [(10, 10.2, 9.8, 10)]*40
        frame = flat_frame(rows)
        bars = indicators(frame, s, 300)
        bars['atr'] = 1.
        signals = pd.DataFrame(False, index=bars.index, columns=['entry_long', 'entry_short'])
        signals.iloc[30, 0] = True
        # Candle 31 (entry at its open 10) touches both 9 and 11: counted as the stop.
        bars.iloc[31, bars.columns.get_loc('high')] = 11.5
        bars.iloc[31, bars.columns.get_loc('low')] = 8.5
        trade = simulate(bars, signals, s, bar_seconds=300)['trades'].iloc[0]
        self.assertEqual((trade.exit_reason, trade.exit_price), ('stop', 9.))
        # A gap below the stop fills at the (worse) open.
        bars.iloc[31, bars.columns.get_loc('high')] = 10.1
        bars.iloc[31, bars.columns.get_loc('low')] = 9.9
        bars.iloc[32, bars.columns.get_loc('open')] = 8.
        bars.iloc[32, bars.columns.get_loc('low')] = 7.9
        trade = simulate(bars, signals, s, bar_seconds=300)['trades'].iloc[0]
        self.assertEqual((trade.exit_reason, trade.exit_price), ('stop_gap', 8.))

    def test_breakeven_applies_from_the_next_candle_only_when_safe(self):
        s = Settings(**OPEN, stop_atr=1, target_atr=10, breakeven_atr=1, trail_atr=0, max_hold_bars=50, exit_on_flip=False)
        frame = flat_frame([(10, 10.1, 9.9, 10)]*40)
        bars = indicators(frame, s, 300)
        bars['atr'] = 1.
        signals = pd.DataFrame(False, index=bars.index, columns=['entry_long', 'entry_short'])
        signals.iloc[30, 0] = True
        # Candle 31 reaches +1.2 and closes at 10.5: stop moves to 10 for candle 32, which dips to 9.95.
        bars.iloc[31, bars.columns.get_loc('high')] = 11.2
        bars.iloc[31, bars.columns.get_loc('close')] = 10.5
        bars.iloc[32, bars.columns.get_loc('low')] = 9.95
        trade = simulate(bars, signals, s, bar_seconds=300)['trades'].iloc[0]
        self.assertEqual((trade.exit_reason, trade.exit_price), ('breakeven', 10.))
        # Same move but closing back below entry: the stop is not moved above the market.
        bars.iloc[31, bars.columns.get_loc('close')] = 9.95
        trade = simulate(bars, signals, s, bar_seconds=300)['trades'].iloc[0]
        self.assertNotEqual(trade.exit_reason, 'stop_gap')

    def test_news_window(self):
        s = Settings()
        times = np.arange(0, 7200, 300, dtype=np.int64)+1_000_000
        blocked = news_blocked(times, [(1_000_000+3600, 'cpi'), (1_000_000+600, 'unknown')], s)
        # CPI at +60 min: blocked from -15 min to +30 min.
        self.assertEqual(list(times[blocked]-1_000_000), list(range(2700, 5401, 300)))

    def test_baseline_is_stop_and_reverse_and_variants_differ(self):
        base = Settings()
        baseline = variant(base, 'baseline')
        self.assertFalse(baseline.use_atr_exits or baseline.use_trend_filter or baseline.use_news_filter)
        result = run_backtest(self.frame, baseline, bar_seconds=300, events=[])
        reasons = set(result['trades'].exit_reason)
        self.assertTrue(reasons <= {'reversal', 'supertrend_flip', 'period_end', 'data_gap'}, reasons)
        m = metrics(result, base.initial_capital)
        self.assertEqual(m['trades'], len(result['trades']))
        self.assertAlmostEqual(result['bars'].equity.iloc[-1], result['cash'], places=6)
        with self.assertRaises(ValueError):
            Settings(rsi_long_min=70, rsi_long_max=60)
        with self.assertRaises(ValueError):
            Settings.from_dict({'mystery': 1})

    def test_registered_runner_and_request(self):
        from server.strategies.bb_reversal_adapter import run_strategy_backtest
        from server.strategies.registry import get_strategy
        from server.strategies.strategy import BacktestRequest
        request = BacktestRequest(start_date=str(self.frame.index[1500].date()), end_date=str(self.frame.index[-1].date()),
                                  strategy='st_scalper', entry_timeframe='5m', st_scalper={'use_news_filter': False, 'sessions': ['asia', 'london']})
        runner = get_strategy('st_scalper')
        self.assertFalse(runner.live_supported)
        result = run_strategy_backtest(self.frame, request)
        self.assertEqual(result['strategy'], 'st_scalper')
        with self.assertRaises(ValueError):
            BacktestRequest(start_date='2026-01-01', end_date='2026-01-02', strategy='st_scalper', st_scalper={'sessions': ['mars']})

    def test_lab_compare_and_search_keep_the_test_period_out_of_selection(self):
        lab = Lab(self.frame, dict(fee_bps=6, slippage=.01, spread=.02, funding_bps=1), events=[])
        periods = splits(lab.frame.index)
        self.assertLess(periods['train'][1], periods['test'][0])
        report = compare(lab, Settings())
        self.assertEqual([row['key'] for row in report['variants']], ['baseline', 'ema', 'adx', 'rsi', 'atr_exits', 'full'])
        base = replace(Settings(), **{k: False for k in ('use_news_filter', 'use_session_filter', 'use_regime_filter')})
        found = optimize(lab, base, {'st_multiplier': [2, 3], 'stop_atr': [1, 2]}, trials=6, min_trades=1, max_drawdown_pct=100)
        self.assertLessEqual(found['trials'], 6)
        for row in found['ranked']:
            self.assertIn('validation', row)
            self.assertTrue(2 <= row['params']['st_multiplier'] <= 3)
        with self.assertRaises(ValueError):
            optimize(lab, base, {'st_multiplier': [1, 9]}, trials=2)


if __name__ == '__main__':
    unittest.main()

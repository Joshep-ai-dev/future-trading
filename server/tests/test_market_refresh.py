import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import pandas as pd

from server.market.data import load_bars
from server.market.market_refresh import COLUMNS, MarketRefresh


def candle(stamp, confirm='1', close='100'):
    return [str(stamp), '100', '101', '99', close, '2', '2', '200', confirm]


class MarketRefreshTests(unittest.TestCase):
    def test_pagination_confirm_filter_merge_and_repeat(self):
        with TemporaryDirectory() as folder:
            source, cache = Path(folder)/'source.csv', Path(folder)/'cache.csv'
            pd.DataFrame([[60000, 100, 101, 99, 100, 1]], columns=COLUMNS).to_csv(source,index=False)
            pages = iter([[candle(240000,'0'),candle(180000)], [candle(120000),candle(60000)]])
            calls=[]
            def fetch(after):
                calls.append(after)
                return next(pages)
            job=MarketRefresh(source,cache,fetch)
            status=job.refresh()
            self.assertIsNone(status['error'])
            self.assertEqual(calls,[None,180000])
            self.assertEqual(pd.read_csv(cache).timestamp_ms.tolist(),[120000,180000])
            original=source.read_bytes()
            with patch('server.market.data.CSV',source):
                # Overlay's filename is derived from the default source filename.
                overlay=source.with_name('OKX_XAG-USDT-SWAP_1m_updates.csv')
                overlay.write_bytes(cache.read_bytes())
                bars,_=load_bars('1m',source)
                self.assertEqual(len(bars),3)
            job.fetch=lambda after:[candle(180000),candle(120000)]
            self.assertEqual(job.refresh()['addedRows'],0)
            self.assertEqual(source.read_bytes(),original)

    def test_failure_preserves_cache_and_reports_error(self):
        with TemporaryDirectory() as folder:
            source,cache=Path(folder)/'source.csv',Path(folder)/'cache.csv'
            pd.DataFrame([[60000,100,101,99,100,1]],columns=COLUMNS).to_csv(source,index=False)
            cache.write_bytes(source.read_bytes())
            original=cache.read_bytes()
            job=MarketRefresh(source,cache,lambda after:[candle(120000,close='999'),candle(60000)])
            with self.assertLogs('server.market.market_refresh',level='ERROR'):
                status=job.refresh()
            self.assertIn('Invalid OHLCV',status['error'])
            self.assertEqual(cache.read_bytes(),original)
            self.assertIsNone(status['lastSuccess'])


class BBIntegrationTests(unittest.TestCase):
    def test_full_period_keeps_position_across_old_validation_boundary(self):
        from server.strategies.bb_reversal_adapter import run_bb_reversal_backtest
        from server.strategies.strategy import BacktestRequest, seconds
        cfg=BacktestRequest(start_date='2026-01-01',end_date='2026-01-03',
            validation_date='2026-01-02',bb_reversal={'use_sma_trend_adjustment':False})
        index=pd.date_range('2026-01-01T23:55Z',periods=3,freq='5min')
        frame=pd.DataFrame(dict(open=[99.5,100.,100.],high=[100.5]*3,
            low=[98.9,99.8,99.8],close=[100.]*3),index=index)
        def calculated(data,*args,**kwargs):
            return data.assign(bb_basis=100.,bb_lower=99.,bb_upper=101.,atr=1.,
                bb_width_pct=2.,adx=30.,trend_sma=100.,sma_ready=True,
                sma_uptrend=False,sma_downtrend=False)
        with patch('server.strategies.bb_outer_reversal.calculate',side_effect=calculated):
            result=run_bb_reversal_backtest(frame,cfg)
        trades=result['backtest']['trades']
        self.assertEqual(len(trades),1)
        self.assertLess(trades[0]['entryTime'],seconds(cfg.validation_date))
        self.assertGreater(trades[0]['exitTime'],seconds(cfg.validation_date))
        self.assertEqual(trades[0]['exitReason'],'period_end')
        self.assertIsNone(BacktestRequest(start_date='2026-01-01',end_date='2026-01-01').validation_date)

    def test_active_api_only_accepts_bb_strategy(self):
        from server.app import BBBacktestRequest, PaperStartRequest
        from pydantic import ValidationError
        dates=dict(start_date='2026-01-01',validation_date='2026-01-02',end_date='2026-01-03')
        self.assertEqual(BBBacktestRequest(**dates).strategy,'bb_outer_reversal')
        for removed in ('sweep','mtf','chartart_v12'):
            with self.assertRaises(ValidationError):
                BBBacktestRequest(strategy=removed,**dates)
            with self.assertRaises(ValidationError):
                PaperStartRequest(strategy=removed)

    def test_both_directions_and_all_execution_timeframes(self):
        from server.strategies.strategy import BacktestRequest
        from server.market.data import TIMEFRAMES
        for timeframe in TIMEFRAMES:
            cfg=BacktestRequest(strategy='bb_outer_reversal',start_date='2026-01-01',
                validation_date='2026-01-02',end_date='2026-01-03',entry_timeframe=timeframe,
                max_leverage=5,bb_reversal={'trade_mode':'Long Only'})
            self.assertEqual(cfg.bb_reversal['trade_mode'],'Both')
            self.assertEqual(cfg.max_leverage,5)

    def test_api_strategy_and_period_output_are_json_serializable(self):
        from server.app import backtest
        from server.strategies.strategy import BacktestRequest
        cfg=BacktestRequest(strategy='bb_outer_reversal',start_date='2026-01-01',
            validation_date='2026-01-02',end_date='2026-01-03',bb_reversal={'bb_length':5})
        index=pd.date_range('2025-12-31',periods=900,freq='5min',tz='UTC')
        import numpy as np
        close=100+np.sin(np.arange(len(index))/3)
        frame=pd.DataFrame(dict(open=close-.1,high=close+.3,low=close-.3,close=close),index=index)
        with patch('server.app.load_bars',return_value=(frame,{})):
            result=backtest(cfg)
        json.dumps(result,allow_nan=False)
        self.assertEqual(result['executionTimeframe'],'5m')
        self.assertNotIn('research',result)
        self.assertNotIn('validation',result)
        self.assertEqual(result['backtest']['name'],'Backtest')
        self.assertIn('bbUpper',result['indicators'][0])
        self.assertIn('trendSma',result['indicators'][0])
        self.assertGreater(result['backtest']['summary']['fees'],0)

    def test_backtest_volume_is_optional_when_strategy_output_drops_it(self):
        from server.app import backtest
        from server.strategies.strategy import BacktestRequest
        cfg=BacktestRequest(start_date='2026-01-01',end_date='2026-01-03')
        index=pd.date_range('2025-12-31',periods=900,freq='5min',tz='UTC')
        import numpy as np
        close=100+np.sin(np.arange(len(index))/3)
        frame=pd.DataFrame(dict(open=close-.1,high=close+.3,low=close-.3,
                                close=close,volume=np.ones(len(index))),index=index)
        with patch('server.app.load_bars',return_value=(frame,{})):
            result=backtest(cfg)
        json.dumps(result,allow_nan=False)
        self.assertEqual(result['candles'][0]['volume'],1.)

    def test_unknown_or_invalid_strategy_parameters_are_rejected(self):
        from server.strategies.strategy import BacktestRequest
        from pydantic import ValidationError
        for params in ({'unknown':1},{'bb_length':0},{'trade_mode':'bad'}):
            with self.assertRaises(ValidationError):
                BacktestRequest(strategy='bb_outer_reversal',start_date='2026-01-01',
                    validation_date='2026-01-02',end_date='2026-01-03',bb_reversal=params)

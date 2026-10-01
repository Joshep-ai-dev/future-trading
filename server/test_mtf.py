import itertools
import json
import unittest
from datetime import date

import numpy as np
import pandas as pd
from pydantic import ValidationError

from .data import TIMEFRAMES
from .mtf import active_stages, alignment, build_orders, execution_stage, indicators, run_mtf_backtest
from .strategy import BacktestRequest, seconds, simulate


def settings(**changes):
    values = dict(strategy='mtf',start_date='2020-01-01',validation_date='2020-01-02',end_date='2020-01-03',
                  fee_bps=0,spread=0,slippage=0,funding_bps=0,max_leverage=100)
    values.update(changes)
    return BacktestRequest(**values)


def frame(timeframe='5m', count=100, closes=None):
    close = np.array(closes, dtype=float) if closes is not None else np.full(count,100.)
    return pd.DataFrame(dict(open=close,high=close+2,low=close-2,close=close),
                        index=pd.date_range('2020',periods=len(close),freq=f'{TIMEFRAMES[timeframe]}s',tz='UTC'))


def fake_indicators(data, side=1):
    return pd.DataFrame(dict(ema20=101. if side==1 else 99.,ema50=100.,rsi20=60. if side==1 else 40.),index=data.index)


class IndicatorTests(unittest.TestCase):
    def test_sma_seeded_ema_and_monotonic_rsi(self):
        result=indicators(frame(closes=np.arange(1,61)))
        self.assertTrue(np.isnan(result.ema20.iloc[18]))
        self.assertEqual(result.ema20.iloc[19],10.5)
        self.assertAlmostEqual(result.ema20.iloc[-1],50.5)
        self.assertTrue(np.isnan(result.ema50.iloc[48]))
        self.assertEqual(result.ema50.iloc[49],25.5)
        self.assertAlmostEqual(result.ema50.iloc[-1],35.5)
        self.assertEqual(result.rsi20.iloc[20],100)
        self.assertEqual(indicators(frame(closes=np.arange(60,0,-1))).rsi20.iloc[-1],0)
        self.assertEqual(indicators(frame()).rsi20.iloc[-1],50)

    def test_wilder_rsi_reference_step(self):
        result=indicators(frame(closes=[100]*20+[120,100]))
        self.assertTrue(np.isnan(result.rsi20.iloc[19]))
        self.assertEqual(result.rsi20.iloc[20],100)
        self.assertAlmostEqual(result.rsi20.iloc[21],100-100/(1+.95))

    def test_gap_restarts_all_indicator_warmups(self):
        result=indicators(frame(closes=np.r_[np.arange(1,61),np.nan,np.arange(1,61)]))
        self.assertTrue(result.iloc[60:80].ema20.isna().all())
        self.assertEqual(result.ema20.iloc[80],10.5)
        self.assertTrue(result.iloc[60:110].ema50.isna().all())
        self.assertEqual(result.ema50.iloc[110],25.5)

    def test_strict_thresholds_and_direction_ignores_rsi(self):
        self.assertEqual(alignment([101,100,50]),0)
        self.assertEqual(alignment([100,100,60]),0)
        self.assertEqual(alignment([101,100,np.nan],False),1)
        self.assertEqual(alignment([99,100,40]),-1)
        self.assertEqual(alignment([101,100,40]),0)


class ConfirmationTests(unittest.TestCase):
    def test_all_switch_combinations_and_fallback(self):
        for flags in itertools.product([False,True], repeat=3):
            changes=dict(zip(['direction_active','setup_active','entry_active'],flags))
            if not any(flags):
                with self.assertRaises(ValidationError): settings(**changes)
                continue
            cfg=settings(**changes)
            stage,tf=execution_stage(cfg)
            expected='entry' if flags[2] else 'setup' if flags[1] else 'direction'
            self.assertEqual(stage,expected)
            frames={t:frame(t,count=100) for _,t in active_stages(cfg)}
            calculated={t:fake_indicators(f) for t,f in frames.items()}
            signal_index=max(TIMEFRAMES[t] for _,t in active_stages(cfg))//TIMEFRAMES[tf]+2
            calculated[tf].iloc[:signal_index,0]=100
            orders=build_orders(frames,cfg,calculated)
            self.assertEqual(list(orders),[signal_index],msg=str(flags))
            self.assertEqual(len(orders[signal_index]['confirmations']),sum(flags))

    def test_all_active_filters_must_agree(self):
        cfg=settings()
        frames={t:frame(t) for _,t in active_stages(cfg)}
        calculated={t:fake_indicators(f) for t,f in frames.items()}
        calculated['5m'].iloc[:12,0]=100
        self.assertIn(12,build_orders(frames,cfg,calculated))
        for tf in ['1h','15m']:
            changed={t:v.copy() for t,v in calculated.items()}
            changed[tf]=fake_indicators(frames[tf],side=-1)
            self.assertEqual(build_orders(frames,cfg,changed),{})
        calculated['15m'].rsi20=50.
        self.assertEqual(build_orders(frames,cfg,calculated),{})

    def test_unfinished_hour_not_used_and_exact_close_available(self):
        cfg=settings(setup_active=False)
        frames={'1h':frame('1h'),'5m':frame()}
        calculated={t:fake_indicators(f) for t,f in frames.items()}
        calculated['5m'].ema20=100.
        calculated['5m'].iloc[10,0]=101.  # 00:55: no completed 1H yet
        calculated['5m'].iloc[12,0]=101.  # 01:05: hour ending 01:00 is available
        calculated['1h'].iloc[1:]=[99.,100.,40.]  # unfinished 01:00-02:00 hour is bearish
        orders=build_orders(frames,cfg,calculated)
        self.assertEqual(list(orders),[12])
        confirm=orders[12]['confirmations'][0]
        self.assertEqual(confirm['closeTime'],seconds(date(2020,1,1))+3600)
        calculated['5m'].iloc[10,0]=100.
        calculated['5m'].iloc[11,0]=101.  # exact 01:00 boundary may use the hour just closed
        self.assertIn(11,build_orders(frames,cfg,calculated))

    def test_3m_entry_uses_latest_closed_5m_setup(self):
        cfg=settings(direction_active=False,setup_timeframe='5m',entry_timeframe='3m')
        frames={'5m':frame(),'3m':frame('3m')}
        calculated={t:fake_indicators(f) for t,f in frames.items()}
        calculated['3m'].iloc[0,0]=100
        order=build_orders(frames,cfg,calculated)[1]
        self.assertEqual(order['signalCloseTime']-order['confirmations'][0]['closeTime'],60)

    def test_disabled_timeframe_never_loaded_or_used(self):
        cfg=settings(direction_active=False,setup_active=False)
        self.assertEqual(active_stages(cfg),[('entry','5m')])
        data=frame()
        self.assertTrue(build_orders({'5m':data},cfg,{'5m':fake_indicators(data)}))

    def test_fresh_alignment_only_not_every_bar_or_late_filter_confirmation(self):
        cfg=settings(direction_active=False,setup_active=False)
        data=frame(count=8)
        calculated=fake_indicators(data)
        calculated.iloc[3]=[100,100,50]
        calculated.iloc[6:]=[99,100,40]
        self.assertEqual(list(build_orders({'5m':data},cfg,{'5m':calculated})),[0,4,6])

    def test_future_prices_cannot_change_past_indicators_or_orders(self):
        cfg=settings(direction_active=False,setup_active=False)
        values=100+np.sin(np.arange(240)/8)*5
        before=frame(closes=values)
        after=before.copy();after.iloc[160:]*=3
        a,b=indicators(before),indicators(after)
        pd.testing.assert_frame_equal(a.iloc[:160],b.iloc[:160])
        orders_a=build_orders({'5m':before},cfg)
        orders_b=build_orders({'5m':after},cfg)
        self.assertEqual({i:v for i,v in orders_a.items() if i<160},{i:v for i,v in orders_b.items() if i<160})

    def test_stale_higher_timeframe_is_not_carried_forward(self):
        cfg=settings(setup_active=False)
        frames={'1h':frame('1h',count=1),'5m':frame(count=30)}
        calculated={t:fake_indicators(f) for t,f in frames.items()}
        calculated['5m'].iloc[:24,0]=100
        self.assertEqual(build_orders(frames,cfg,calculated),{})

    def test_options_are_validated(self):
        for change in [dict(direction_timeframe='5m'),dict(setup_timeframe='3m'),dict(entry_timeframe='1h')]:
            with self.assertRaises(ValidationError): settings(**change)
        settings(direction_timeframe='30m',setup_timeframe='30m',entry_timeframe='3m')


class ExecutionTests(unittest.TestCase):
    def test_market_entry_at_next_open_3m_and_target(self):
        cfg=settings(direction_active=False,setup_active=False,entry_timeframe='3m')
        data=frame('3m',count=4)
        data.iloc[0]=[100,102,98,101]
        data.iloc[1]=[101,102,100,101]
        data.iloc[2]=[102,108,101,107]
        calculated=fake_indicators(data)
        orders=build_orders({'3m':data},cfg,{'3m':calculated})
        r=simulate(data,[],cfg,seconds(cfg.start_date),seconds(cfg.validation_date),'Test',180,orders)
        t=r['trades'][0]
        self.assertEqual(t['entryTime']-t['signalTime'],180)
        self.assertEqual(t['entry'],101)
        self.assertEqual(t['stop'],98)
        self.assertEqual(t['target'],107)
        self.assertEqual(t['exitReason'],'target')
        self.assertAlmostEqual(t['netR'],2)
        self.assertAlmostEqual(r['equity'][-1]['value'],2020)
        json.dumps(r,allow_nan=False)

    def test_entry_beyond_signal_stop_is_skipped(self):
        cfg=settings(direction_active=False,setup_active=False)
        data=frame(count=4)
        orders=build_orders({'5m':data},cfg,{'5m':fake_indicators(data)})
        data.iloc[1]=[97,98,96,97]
        r=simulate(data,[],cfg,seconds(cfg.start_date),seconds(cfg.validation_date),'Test',300,orders)
        self.assertEqual(r['trades'],[])
        self.assertEqual(r['diagnostics']['invalidEntries'],1)

    def test_coarse_bars_cannot_fill_outside_session(self):
        cfg=settings(direction_timeframe='4h',setup_active=False,entry_active=False,session_start=9,session_end=17)
        data=frame('4h',count=6)
        calculated=fake_indicators(data)
        calculated.iloc[:3,0]=100  # 12:00-16:00 signal, next 16:00-20:00 bar crosses session end
        orders=build_orders({'4h':data},cfg,{'4h':calculated})
        self.assertIn(3,orders)
        result=simulate(data,[],cfg,seconds(cfg.start_date),seconds(cfg.validation_date),'Test',14400,orders)
        self.assertEqual(result['trades'],[])

    def test_setup_and_direction_fallback_metadata_and_json(self):
        for changes,tf in [(dict(entry_active=False),'15m'),(dict(entry_active=False,setup_active=False),'1h')]:
            cfg=settings(**changes)
            frames={t:frame(t,closes=100+np.sin(np.arange(150)/8)) for _,t in active_stages(cfg)}
            frames[tf].iloc[0]=np.nan
            result=run_mtf_backtest(frames,cfg)
            self.assertEqual([p['time'] for p in result['indicators']],[c['time'] for c in result['candles']])
            self.assertEqual(result['executionTimeframe'],tf)
            self.assertEqual(result['barSeconds'],TIMEFRAMES[tf])
            self.assertEqual(result['validation']['equity'][0]['value'],cfg.capital)
            json.dumps(result,allow_nan=False)


if __name__=='__main__': unittest.main()

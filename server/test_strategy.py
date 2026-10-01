import unittest
import json
from datetime import date
import numpy as np
import pandas as pd
from pydantic import ValidationError
from .strategy import (BacktestRequest, structure_events, setup_order, simulate,
                       exit_on_bar, session_at, seconds, run_backtest)


def settings(**changes):
    values = dict(start_date='2020-01-01', validation_date='2020-01-02', end_date='2020-01-03',
                  fee_bps=0, spread=0, slippage=0, funding_bps=0, max_leverage=100)
    values.update(changes)
    return BacktestRequest(**values)


def frame(rows, freq='5min', start='2020-01-01'):
    return pd.DataFrame(rows, columns=['open', 'high', 'low', 'close'],
                        index=pd.date_range(start,periods=len(rows),freq=freq,tz='UTC'))


def trend(direction=1, time=0, obstacle=None):
    return dict(time=time,trend=direction,highs=[110.,112.] if direction==1 else [112.,110.],
                lows=[98.,99.] if direction==1 else [99.,98.],
                resistance=[] if obstacle is None or direction==-1 else [obstacle],
                support=[] if obstacle is None or direction==1 else [obstacle])


def sample():
    # 6 completed candles, sweep, then breakout. Entry=100.01, stop=97.99, target=104.05.
    return [[100,101,99,100]]*6+[[99.5,100,98,99.5],[100,102,99,101],[102,105,101,104]]


def run(rows, cfg=None, state=None):
    data=frame(rows)
    return simulate(data,[state or trend()],cfg or settings(),seconds(date(2020,1,1)),seconds(date(2020,1,2)),'Test')


class StrategyTests(unittest.TestCase):
    def test_swings_confirm_only_after_two_following_closes(self):
        data=frame([[99,100,98,99],[100,101,99,100],[104,105,100,104],
                    [101,102,99,101],[100,101,98,100]],'15min')
        events=structure_events(data)
        self.assertEqual(events[3]['highs'],[])
        self.assertEqual(events[4]['highs'],[105])
        self.assertEqual(events[4]['time'],int(data.index[2].timestamp())+3*900)
        changed=data.copy();changed.iloc[4,1]=106
        self.assertEqual(structure_events(changed)[:4],events[:4])
        self.assertEqual(structure_events(changed)[4]['highs'],[])

    def test_equal_highs_are_not_swings_and_gaps_reset(self):
        data=frame([[99,100,98,99],[100,105,99,100],[104,105,100,104],
                    [101,102,99,101],[100,101,98,100],[np.nan]*4],'15min')
        events=structure_events(data)
        self.assertEqual(events[4]['highs'],[])
        self.assertEqual(events[-1]['trend'],0)

    def test_direction_needs_both_rising_highs_and_lows(self):
        highs=[10,11,15,12,11,12,13,18,14,13,14,15,19,16,15]
        lows= [8, 7, 9, 6, 4, 7, 8,10, 7, 5, 8, 9,11, 8, 6]
        data=frame([[(h+l)/2,h,l,(h+l)/2] for h,l in zip(highs,lows)],'15min')
        e=structure_events(data)
        self.assertEqual(e[-1]['trend'],1)
        self.assertEqual(e[-1]['highs'],[18,19])
        self.assertEqual(e[-1]['lows'],[4,5])
        mirrored=30-data
        mirrored[['high','low']]=mirrored[['low','high']].to_numpy()
        self.assertEqual(structure_events(mirrored)[-1]['trend'],-1)

    def test_no_entry_on_signal_candle_and_two_r_target(self):
        result=run(sample())
        json.dumps(result, allow_nan=False)
        self.assertEqual(len(result['trades']),1)
        t=result['trades'][0]
        self.assertEqual(t['entryTime']-t['signalTime'],300)
        self.assertAlmostEqual(t['entry'],100.01)
        self.assertAlmostEqual(t['stop'],97.99)
        self.assertAlmostEqual(t['target'],104.05)
        self.assertEqual(t['exitReason'],'target')
        self.assertAlmostEqual(t['netR'],2)
        self.assertAlmostEqual(t['plannedRisk'],10)

    def test_short_is_symmetric(self):
        rows=np.array(sample())
        mirrored=200-rows
        mirrored[:,[1,2]]=mirrored[:,[2,1]]
        t=run(mirrored,state=trend(-1))['trades'][0]
        self.assertEqual(t['direction'],-1)
        self.assertEqual(t['exitReason'],'target')
        self.assertAlmostEqual(t['netR'],2)

    def test_pending_order_expires_after_exactly_three_bars(self):
        waiting=[[99.5,100,99,99.5]]
        result=run(sample()[:7]+waiting*3+sample()[7:])
        self.assertEqual(result['trades'],[])
        self.assertEqual(result['diagnostics']['expiredOrders'],1)
        result=run(sample()[:7]+waiting*2+sample()[7:])
        self.assertEqual(len(result['trades']),1)
        self.assertEqual(result['trades'][0]['entryTime']-result['trades'][0]['signalTime'],900)

    def test_nearby_resistance_blocks_and_gap_fill_rechecks(self):
        self.assertEqual(run(sample(),state=trend(obstacle=103))['trades'],[])
        rows=sample();rows[7]=[104,105,103,104]
        r=run(rows,state=trend(obstacle=105))
        self.assertEqual(r['trades'],[])
        self.assertEqual(r['diagnostics']['blockedByLevel'],1)

    def test_stop_first_and_entry_candle_never_uses_pre_entry_open_as_gap(self):
        p=dict(direction=1,stop=98,target=104)
        self.assertEqual(exit_on_bar(p,[97,105,96,100],.01), (96.99,'stop',True))
        self.assertEqual(exit_on_bar(p,[97,105,96,100],.01,True), (97.99,'stop',True))
        rows=sample();rows[7]=[100,105,97,100]
        trade=run(rows)['trades'][0]
        self.assertEqual(trade['exitReason'],'stop')
        self.assertTrue(trade['ambiguous'])
        self.assertAlmostEqual(trade['netR'],-1)

    def test_costs_risk_cap_and_equity_reconcile(self):
        r=run(sample(),settings(fee_bps=5,spread=.02,slippage=.01,max_leverage=1))
        t=r['trades'][0]
        self.assertGreater(t['fees'],0)
        self.assertGreater(t['executionCost'],0)
        self.assertLessEqual(t['entry']*t['quantity'],2000)
        self.assertLessEqual(t['plannedRisk'],10)
        self.assertAlmostEqual(r['equity'][-1]['value'],2000+t['netPnl'])
        self.assertAlmostEqual(t['netPnl'],t['grossPnl']-t['fees']-t['funding'])
        rows=sample();rows[8]=[101,102,97,99]
        loss=run(rows,settings(fee_bps=5,spread=.02,slippage=.01))['trades'][0]
        self.assertAlmostEqual(loss['netPnl'],-10)

    def test_two_trades_and_two_losses_per_session(self):
        rows=sample();rows[8]=[101,102,97,99]
        r=run(rows*5)
        self.assertEqual(len(r['trades']),2)
        self.assertTrue(all(t['netPnl']<0 for t in r['trades']))

    def test_session_timezone_overnight_and_forced_close(self):
        cfg=settings(session_start=22,session_end=2,session_timezone='Asia/Shanghai')
        self.assertEqual(session_at(int(pd.Timestamp('2020-01-02T17:00Z').timestamp()),cfg),'2020-01-02')
        self.assertIsNone(session_at(int(pd.Timestamp('2020-01-02T19:00Z').timestamp()),cfg))
        rows=sample()[:8]+[[101,102,100,101]]*10
        r=run(rows,settings(session_start=0,session_end=1))
        self.assertEqual(r['trades'][0]['exitReason'],'session_end')
        self.assertEqual(r['trades'][0]['exitTime'],int(pd.Timestamp('2020-01-01T00:55Z').timestamp()))

    def test_funding_charges_long_and_credits_short_at_boundary(self):
        rows=sample()[:8]+[[101,102,100,101]]*90
        data=frame(rows)
        cfg=settings(funding_bps=1)
        a=simulate(data,[trend()],cfg,seconds(date(2020,1,1)),seconds(date(2020,1,2)),'Test')
        self.assertGreater(a['trades'][0]['funding'],0)
        self.assertAlmostEqual(a['equity'][-1]['value'],2000+a['trades'][0]['netPnl'])
        mirrored=200-data;mirrored[['high','low']]=mirrored[['low','high']].to_numpy()
        b=simulate(mirrored,[trend(-1)],cfg,seconds(date(2020,1,1)),seconds(date(2020,1,2)),'Test')
        self.assertLess(b['trades'][0]['funding'],0)

    def test_gap_flattens_and_breaks_sweep_lookback(self):
        rows=sample()[:8]+[[np.nan]*4]+sample()[8:]
        t=run(rows)['trades'][0]
        self.assertEqual(t['exitReason'],'data_gap')
        self.assertEqual(t['exitTime'],t['entryTime'])
        rows=sample();rows[5]=[np.nan]*4
        self.assertIsNone(setup_order(np.array(rows),6,trend(),settings()))

    def test_future_data_cannot_change_closed_trades(self):
        rows=sample()+[[101,102,100,101]]*20
        before=run(rows)['trades']
        rows[15:]=[[101,200,1,101]]*len(rows[15:])
        after=run(rows)['trades']
        self.assertEqual(before[0],after[0])

    def test_api_rejects_bad_dates_costs_and_sessions(self):
        for overrides in [dict(validation_date='2020-01-01'),dict(fee_bps=-1),dict(tick_size=0),
                          dict(session_start=12,session_end=12),dict(spread=float('nan'))]:
            with self.assertRaises(ValidationError): settings(**overrides)

    def test_validation_account_resets_and_empty_period_is_explicit(self):
        data=frame(sample())
        result=run_backtest(data,frame(sample(),'15min'),settings())
        self.assertEqual(result['validation']['equity'][0]['value'],2000)
        self.assertEqual(result['validation']['status'],'no_complete_bars')


if __name__=='__main__': unittest.main()

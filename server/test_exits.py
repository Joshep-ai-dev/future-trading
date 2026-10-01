import json
import unittest

import numpy as np
from pydantic import ValidationError

from .exits import indicator_exit, updated_stop
from .strategy import simulate, seconds
from .test_mtf import frame, settings


def run_case(rows=None, direction=1, values=None, **changes):
    cfg=settings(direction_active=False,setup_active=False,**changes)
    rows=rows or [[100,105,95,100]]*5
    data=frame(count=len(rows));data.iloc[:]=rows
    order=dict(direction=direction,orderType='market',trigger=None,stop=90 if direction==1 else 110,
               sweepLevel=None,obstacle=None,blocked=False,swingHighs=[],swingLows=[])
    result=simulate(data,[],cfg,seconds(cfg.start_date),seconds(cfg.validation_date),'Test',300,{0:order},values)
    json.dumps(result,allow_nan=False)
    return result


class CloseConditionTests(unittest.TestCase):
    def test_each_condition_and_both_directions(self):
        for d,previous,current in [(1,[105,100,60],[99,100,40]),(-1,[95,100,40],[101,100,60])]:
            self.assertEqual(indicator_exit(d,previous,current,'ema'),'ema_exit')
            self.assertEqual(indicator_exit(d,previous,current,'rsi'),'rsi_exit')
            self.assertEqual(indicator_exit(d,previous,current,'either'),'ema_rsi_exit')
            self.assertIsNone(indicator_exit(d,previous,current,'none'))
        self.assertEqual(indicator_exit(1,[105,100,40],[99,100,40],'either'),'ema_exit')
        self.assertEqual(indicator_exit(1,[105,100,60],[105,100,40],'either'),'rsi_exit')

    def test_no_repeated_signal_or_nan_signal(self):
        self.assertIsNone(indicator_exit(1,[99,100,40],[98,100,30],'either'))
        self.assertIsNone(indicator_exit(1,[np.nan,100,np.nan],[99,100,40],'either'))
        self.assertIsNone(indicator_exit(1,[105,100,60],[np.nan,100,np.nan],'either'))
        self.assertEqual(indicator_exit(1,[100,100,50],[99,100,49],'either'),'ema_rsi_exit')

    def test_indicator_close_is_next_open_before_that_bars_high_low(self):
        values=np.array([[105,100,60],[99,100,40],[98,100,30],[98,100,30],[98,100,30]])
        rows=[[100,105,95,100],[100,105,95,102],[103,130,80,110],[100,105,95,100],[100,105,95,100]]
        for mode,reason in [('ema','ema_exit'),('rsi','rsi_exit'),('either','ema_rsi_exit')]:
            trade=run_case(rows,values=values,exit_condition=mode)['trades'][0]
            self.assertEqual(trade['exitReason'],reason)
            self.assertEqual(trade['exit'],103)
            self.assertEqual(trade['exitTime']-trade['entryTime'],300)
            self.assertEqual(trade['exitSignal']['closeTime'],trade['exitTime'])

    def test_short_close_and_costs_reconcile(self):
        values=np.array([[95,100,40],[101,100,60],[102,100,70],[102,100,70],[102,100,70]])
        rows=[[100,105,95,100],[100,105,95,99],[97,105,95,100],[100,105,95,100],[100,105,95,100]]
        r=run_case(rows,direction=-1,values=values,exit_condition='either',fee_bps=5,spread=.02,slippage=.01)
        trade=r['trades'][0]
        self.assertEqual(trade['exitReason'],'ema_rsi_exit')
        self.assertAlmostEqual(trade['exit'],97.02)
        self.assertGreater(trade['fees'],0)
        self.assertGreater(trade['executionCost'],0)
        self.assertAlmostEqual(r['equity'][-1]['value'],2000+trade['netPnl'])

    def test_protective_orders_win_at_open_and_before_indicator_close(self):
        values=np.array([[105,100,60],[99,100,40],[98,100,30],[98,100,30]])
        for opening,reason,fill in [(85,'stop',85),(125,'target',120)]:
            rows=[[100,105,95,100],[100,105,95,102],[opening,opening+1,opening-1,opening],[100,105,95,100]]
            trade=run_case(rows,values=values,exit_condition='either')['trades'][0]
            self.assertEqual(trade['exitReason'],reason)
            self.assertEqual(trade['exit'],fill)
        rows=[[100,105,95,100],[100,121,95,102],[103,105,95,100],[100,105,95,100]]
        trade=run_case(rows,values=values,exit_condition='either')['trades'][0]
        self.assertEqual(trade['exitReason'],'target')
        self.assertNotIn('exitSignal',trade)

    def test_period_end_does_not_queue_an_unfillable_close(self):
        values=np.array([[105,100,60],[99,100,40]])
        trade=run_case([[100,105,95,100],[100,105,95,102]],values=values,exit_condition='either')['trades'][0]
        self.assertEqual(trade['exitReason'],'period_end')
        self.assertNotIn('exitSignal',trade)


class StopManagementTests(unittest.TestCase):
    def test_breakeven_waits_for_next_bar_and_preserves_initial_risk_target(self):
        rows=[[100,105,90,100],[100,111,95,105],[102,108,99,105],[105,108,102,105]]
        trade=run_case(rows,stop_mode='breakeven')['trades'][0]
        self.assertEqual(trade['exitReason'],'stop')
        self.assertEqual(trade['exitTime']-trade['entryTime'],300)
        self.assertEqual(trade['exit'],100)
        self.assertEqual(trade['stop'],90)
        self.assertEqual(trade['finalStop'],100)
        self.assertEqual(trade['initialRisk'],10)
        self.assertEqual(trade['target'],120)
        self.assertEqual(trade['stopHistory'][1]['time'],trade['entryTime']+300)
        self.assertEqual(trade['stopHistory'][1]['reason'],'breakeven')
        self.assertEqual(trade['netPnl'],0)

    def test_short_breakeven_is_symmetric(self):
        rows=[[100,110,95,100],[100,105,89,95],[98,101,92,95],[95,98,92,95]]
        trade=run_case(rows,direction=-1,stop_mode='breakeven')['trades'][0]
        self.assertEqual(trade['exit'],100)
        self.assertEqual(trade['stop'],110)
        self.assertEqual(trade['finalStop'],100)
        self.assertEqual(trade['target'],80)

    def test_target_hit_prevents_later_stop_update(self):
        rows=[[100,105,90,100],[100,121,95,105],[105,108,99,105]]
        trade=run_case(rows,stop_mode='breakeven_trailing')['trades'][0]
        self.assertEqual(trade['exitReason'],'target')
        self.assertEqual(len(trade['stopHistory']),1)

    def test_trailing_never_loosens_and_combined_chooses_tighter(self):
        long=dict(direction=1,entry=100,stop=90,initialRisk=10)
        self.assertEqual(updated_stop(long,[100,111,96,105],'breakeven_trailing',.01),dict(price=100.,reason='breakeven'))
        self.assertEqual(updated_stop(long,[106,112,105,110],'breakeven_trailing',.01),dict(price=104.99,reason='trailing'))
        long['stop']=106
        self.assertIsNone(updated_stop(long,[108,112,105,110],'breakeven_trailing',.01))
        short=dict(direction=-1,entry=100,stop=110,initialRisk=10)
        self.assertEqual(updated_stop(short,[94,95,88,90],'breakeven_trailing',.01),dict(price=95.01,reason='trailing'))
        short['stop']=94
        self.assertIsNone(updated_stop(short,[92,95,88,90],'breakeven_trailing',.01))

    def test_trailing_stop_path_effective_next_bar(self):
        rows=[[100,105,90,100],[100,105,95,100],[101,106,96,102],[102,108,95.5,105],[105,108,102,105]]
        trade=run_case(rows,stop_mode='trailing')['trades'][0]
        self.assertAlmostEqual(trade['exit'],95.99)
        self.assertEqual([h['price'] for h in trade['stopHistory']],[90,94.99,95.99])
        self.assertTrue(all(h['confirmedAt']==h['time'] for h in trade['stopHistory'][1:]))
        self.assertEqual(trade['initialRisk'],10)

    def test_gap_exit_does_not_activate_pending_stop(self):
        rows=[[100,105,90,100],[100,111,95,105],[np.nan]*4,[105,108,102,105]]
        trade=run_case(rows,stop_mode='breakeven')['trades'][0]
        self.assertEqual(trade['exitReason'],'data_gap')
        self.assertEqual(len(trade['stopHistory']),1)
        self.assertEqual(trade['finalStop'],90)

    def test_fixed_stop_and_disabled_close_keep_baseline(self):
        values=np.array([[105,100,60],[99,100,40],[98,100,30],[98,100,30],[98,100,30]])
        trade=run_case(values=values)['trades'][0]
        self.assertEqual(trade['exitReason'],'period_end')
        self.assertEqual(trade['stop'],trade['finalStop'])
        self.assertEqual(len(trade['stopHistory']),1)

    def test_invalid_settings_rejected_for_both_strategies(self):
        for strategy in ['sweep','mtf']:
            for change in [dict(stop_mode='unknown'),dict(exit_condition='unknown')]:
                with self.assertRaises(ValidationError): settings(strategy=strategy,**change)


if __name__=='__main__': unittest.main()

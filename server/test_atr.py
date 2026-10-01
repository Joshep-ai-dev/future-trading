import unittest
import numpy as np
from pydantic import ValidationError
from .indicators import atr
from .test_mtf import settings, frame, fake_indicators
from .mtf import build_orders
from .strategy import simulate, seconds


class AtrTests(unittest.TestCase):
    def test_wilder_seed_gap_and_reset(self):
        data = frame(count=6)
        data.iloc[:] = [[10,11,9,10],[14,15,13,14],[14,16,12,14],[np.nan]*4,[10,11,9,10],[10,12,8,10]]
        values = atr(data, 2)
        self.assertTrue(np.isnan(values[0]))
        self.assertEqual(values[1], 3.5)
        self.assertEqual(values[2], 3.75)
        self.assertTrue(np.isnan(values[4]))
        self.assertEqual(values[5], 3)

    def test_signal_atr_uses_only_completed_signal_data(self):
        data = frame(count=5)
        calc = fake_indicators(data)
        calc.iloc[:2,0] = 100
        cfg = settings(direction_active=False,setup_active=False,atr_active=True,atr_period=2,atr_multiplier=3)
        orders = build_orders({'5m':data},cfg,{'5m':calc})
        self.assertEqual(orders[2]['atrDistance'],12)
        data.iloc[3] = [100,200,1,100]
        self.assertEqual(build_orders({'5m':data},cfg,{'5m':calc})[2]['atrDistance'],12)

    def test_stop_and_ema_work_together_long_and_short(self):
        for direction in [1,-1]:
            for gap in [False,True]:
                data = frame(count=5)
                data.iloc[:] = [[100,101,99,100]]*5
                if gap:
                    price = 95 if direction==1 else 105
                    data.iloc[2] = [price,price+1,price-1,price]
                else:
                    data.iloc[2] = [100,105,95,100]
                cfg = settings(atr_active=True)
                order = dict(direction=direction,orderType='market',trigger=None,stop=90,
                             atr=1.,atrDistance=2.,sweepLevel=None,obstacle=None,blocked=False,swingHighs=[],swingLows=[])
                result = simulate(data,[],cfg,seconds(cfg.start_date),seconds(cfg.validation_date),'Test',300,{0:order})
                trade = result['trades'][0]
                self.assertEqual(trade['stop'],100-direction*2)
                self.assertIsNone(trade['target'])
                self.assertEqual(trade['exitReason'],'stop')
                self.assertEqual(trade['exit'],(95 if direction==1 else 105) if gap else 100-direction*2)
                # An EMA reversal still closes before the stop when price stays inside it.
                data.iloc[2] = [100,101,99,100]
                values=np.array([[100+direction,100,50],[100-direction,100,50]]+[[100-direction,100,50]]*3)
                result=simulate(data,[],cfg,seconds(cfg.start_date),seconds(cfg.validation_date),'Test',300,{0:order},values)
                self.assertEqual(result['trades'][0]['exitReason'],'ema_exit')

    def test_invalid_atr_settings(self):
        for change in [dict(atr_period=0),dict(atr_multiplier=0),dict(atr_multiplier=float('nan'))]:
            with self.assertRaises(ValidationError):
                settings(**change)

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import pandas as pd

from .paper_trading import PaperTrading
from .strategy import BacktestRequest


class PaperTradingTests(unittest.TestCase):
    def test_live_forming_price_does_not_submit_trades_or_close_execution_bars(self):
        with TemporaryDirectory() as folder:
            index=pd.date_range('2026-01-01',periods=1,freq='min',tz='UTC')
            frame=pd.DataFrame(dict(open=[100.],high=[101.],low=[99.],close=[100.]),index=index)
            clock=int(index[0].timestamp())+1
            service=PaperTrading(Path(folder)/'paper.json',loader=lambda tf:(frame,{}),now=lambda:clock)
            service.begin(self.request())
            service.live_fetch=lambda limit:[dict(time=int(index[0].timestamp()),open=100.,high=102.,low=99.,close=101.)]
            service.update_quote()
            session=service.status()['session']
            self.assertEqual(session['formingCandle']['close'],101.)
            self.assertEqual(session['displayPrice'],101.)
            self.assertEqual(session['trades'],[])
            self.assertIsNone(session['lastProcessed'])
            self.assertIsNone(session['openPosition'])
            self.assertNotIn('minuteCandles',session)

    def test_replay_speed_pause_restart_and_end_without_future_candles(self):
        from .app import PaperStartRequest
        with TemporaryDirectory() as folder:
            index=pd.date_range('2026-01-01',periods=3,freq='5min',tz='UTC')
            frame=pd.DataFrame(dict(open=[99.5,100.,100.],high=[100.5]*3,
                                   low=[98.9,99.8,99.8],close=[100.]*3),index=index)
            clock=[int(pd.Timestamp('2026-02-01',tz='UTC').timestamp())]
            path=Path(folder)/'paper.json'
            service=PaperTrading(path,loader=lambda tf:(frame,{}),now=lambda:clock[0])
            request=PaperStartRequest(strategy='bb_outer_reversal',paper_mode='replay',
                replay_start='2026-01-01',replay_end='2026-01-01',replay_speed=300,
                bb_reversal={'use_sma_trend_adjustment':False})
            service.begin(request)
            def calculate(bars,settings,**kwargs):
                return bars.assign(bb_lower=99.,bb_upper=101.,atr=1.,bb_width_pct=2.,adx=30.,
                    sma_ready=False,sma_uptrend=False,sma_downtrend=False)
            with patch('server.bb_outer_reversal.calculate',side_effect=calculate):
                service.advance()
                self.assertIsNone(service.state['lastProcessed'])
                clock[0]+=1
                service.advance()
                self.assertEqual(service.state['lastProcessed'],int(index[0].timestamp()))
                self.assertIsNotNone(service.state['openPosition'])
                visible=service.status()['session']
                self.assertEqual(len(visible['chartCandles']),1)
                self.assertLessEqual(visible['chartCandles'][-1]['time']+300,visible['virtualTime'])
                self.assertEqual(visible['chartIndicators'][-1]['time'],int(index[0].timestamp()))
                self.assertNotIn('replayCandles',visible)
                self.assertNotIn('candles',visible)
                service.set_running(False)
                clock[0]+=1000
                service.advance()
                self.assertEqual(service.state['lastProcessed'],int(index[0].timestamp()))
                restarted=PaperTrading(path,loader=lambda tf:(_ for _ in ()).throw(AssertionError('Replay must use snapshot')),now=lambda:clock[0])
                restarted.set_running(True)
                restarted.set_speed(600)
                clock[0]+=1
                restarted.advance()
                self.assertTrue(restarted.state['completed'])
                self.assertFalse(restarted.state['running'])
                self.assertIsNone(restarted.state['openPosition'])
                self.assertEqual(len(restarted.state['trades']),1)
                self.assertEqual(restarted.state['trades'][0]['exit_reason'],'period_end')
                self.assertEqual(restarted.state['lastProcessed'],int(index[-1].timestamp()))
                with self.assertRaises(ValueError):
                    restarted.set_running(True)

    def test_paper_request_ignores_historical_dates(self):
        from .app import PaperStartRequest
        cfg = PaperStartRequest(strategy='bb_outer_reversal',start_date='bad',
                                validation_date='bad',end_date='bad')
        self.assertEqual(cfg.strategy,'bb_outer_reversal')
        self.assertLess(cfg.start_date,cfg.validation_date)

    def request(self):
        return BacktestRequest(strategy='bb_outer_reversal',start_date='2026-01-01',
            validation_date='2026-01-02',end_date='2026-01-03',capital=1000,
            bb_reversal={'use_sma_trend_adjustment':False})

    def test_forward_only_no_duplicates_and_restart_preserves_position(self):
        with TemporaryDirectory() as folder:
            path=Path(folder)/'paper.json'
            index=pd.date_range('2026-01-01T00:00Z',periods=4,freq='5min')
            frame=pd.DataFrame(dict(open=[100.,99.5,100.,100.5],high=[100.5,100.5,100.5,101.2],
                low=[99.5,98.9,99.8,99.8],close=[100.]*4),index=index)
            clock=[int(index[0].timestamp())+1]
            def loader(tf):
                return frame.loc[frame.index+pd.Timedelta(minutes=5)<=pd.Timestamp(clock[0],unit='s',tz='UTC')],{}
            def calculate(bars,settings,**kwargs):
                return bars.assign(bb_lower=99.,bb_upper=101.,atr=1.,bb_width_pct=2.,adx=30.,
                    sma_ready=False,sma_uptrend=False,sma_downtrend=False)
            service=PaperTrading(path,loader=loader,now=lambda:clock[0])
            service.begin(self.request())
            self.assertEqual(service.state['tradingFrom'],int(index[1].timestamp()))
            self.assertEqual(service.state['trades'],[])
            with patch('server.bb_outer_reversal.calculate',side_effect=calculate):
                clock[0]=int(index[2].timestamp())
                service.advance()
                self.assertEqual(service.state['openPosition']['direction'],1)
                self.assertEqual(service.state['balance'],1000)
                service.advance()
                self.assertEqual(service.state['trades'],[])
                restarted=PaperTrading(path,loader=loader,now=lambda:clock[0])
                self.assertTrue(restarted.state['running'])
                self.assertEqual(restarted.state['openPosition'],service.state['openPosition'])
                restarted.set_running(False)
                clock[0]=int(index[3].timestamp())+300
                restarted.advance()
                self.assertEqual(restarted.state['lastProcessed'],int(index[1].timestamp()))
                restarted.set_running(True)
                restarted.advance()
                self.assertEqual(len(restarted.state['trades']),1)
                self.assertEqual(restarted.state['openPosition']['direction'],-1)
                restarted.advance()
                self.assertEqual(len(restarted.state['trades']),1)
                self.assertEqual(restarted.state['trades'][0]['exit_reason'],'reversal')

    def test_download_error_does_not_advance_bot(self):
        with TemporaryDirectory() as folder:
            service=PaperTrading(Path(folder)/'paper.json')
            service.state={'running':True}
            class Refresh:
                def refresh(self):
                    return {'running':False,'error':'Offline'}
            service.refresh=Refresh()
            with patch.object(service,'advance') as advance:
                service.cycle()
                advance.assert_not_called()
            self.assertEqual(service.error,'Offline')

    def test_halted_account_cannot_resume(self):
        with TemporaryDirectory() as folder:
            service=PaperTrading(Path(folder)/'paper.json')
            service.state={'running':False,'halted':True}
            with self.assertRaises(ValueError):
                service.set_running(True)

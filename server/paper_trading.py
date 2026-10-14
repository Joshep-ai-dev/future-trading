"""Persisted, causal candle-based paper trading. Never submits exchange orders."""
from dataclasses import replace
import json
from pathlib import Path
import threading
import time

import pandas as pd

from .bb_outer_reversal import Settings, run_backtest
from .data import TIMEFRAMES, load_bars
from .market_refresh import refresh_service

STATE = Path(__file__).resolve().parents[1] / 'data' / 'paper_trading.json'


class PaperTrading:
    def __init__(self, path=STATE, loader=load_bars, refresh=refresh_service, now=time.time):
        self.path, self.loader, self.refresh, self.now = Path(path), loader, refresh, now
        self.lock = threading.RLock()
        self.stop = threading.Event()
        self.thread = None
        self.error = None
        self.replay_tick = self.now()
        self.live_check = 0
        try:
            self.state = json.loads(self.path.read_text(encoding='utf-8')) if self.path.exists() else None
        except (OSError, ValueError) as error:
            self.state = None
            self.error = f'Could not restore saved paper session: {error}'

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix('.json.tmp')
        temporary.write_text(json.dumps(self.state, allow_nan=False), encoding='utf-8')
        temporary.replace(self.path)

    def status(self):
        with self.lock:
            if self.state is None:
                return dict(session=None, error=self.error)
            return dict(session={k:v for k,v in self.state.items() if k not in ('candles','replayCandles')}, error=self.error)

    def begin(self, request):
        if request.strategy != 'bb_outer_reversal':
            raise ValueError('Paper trading currently supports the BB reversal strategy')
        with self.lock:
            if self.state and self.state['running']:
                raise ValueError('Pause the current paper session before starting a new one')
            duration = TIMEFRAMES[request.entry_timeframe]
            now = int(self.now())
            first = ((now+duration-1)//duration)*duration
            config = replace(Settings(**request.bb_reversal), initial_capital=request.capital,
                leverage=request.max_leverage, trade_mode='Both', min_tick=request.tick_size, min_tick_unit='price')
            history, _ = self.loader(request.entry_timeframe)
            history = history.dropna(subset=['open','high','low','close'])
            history = history.loc[history.index + pd.Timedelta(seconds=duration) <= pd.Timestamp(now,unit='s',tz='UTC')]
            warmup = max(1000, config.bb_length*10, config.atr_length*10,
                         config.adx_length*20, config.sma_length*10+config.sma_slope_bars)
            candles = self.encode(history.tail(warmup))
            mode = getattr(request, 'paper_mode', 'live')
            replay_end, replay_candles = None, []
            if mode == 'replay':
                begin = pd.Timestamp(request.replay_start, tz='UTC')
                end = pd.Timestamp(request.replay_end, tz='UTC')+pd.Timedelta(days=1)
                first = ((int(begin.timestamp())+duration-1)//duration)*duration
                if end <= begin:
                    raise ValueError('Replay end date must be on or after the start date')
                available = history.loc[(history.index >= pd.Timestamp(first,unit='s',tz='UTC')) &
                                        (history.index+pd.Timedelta(seconds=duration) <= end)]
                if available.empty:
                    raise ValueError('No downloaded candles in the selected replay range')
                replay_end = min(int(end.timestamp()),int(available.index[-1].timestamp())+duration)
                replay_candles = self.encode(available)
                candles = self.encode(history.loc[history.index+pd.Timedelta(seconds=duration) <=
                                      pd.Timestamp(first,unit='s',tz='UTC')].tail(warmup))
            if self.state:
                archive = self.path.with_name(f'paper_trading_{self.state["startedAt"]}_{time.time_ns()}.json')
                archive.write_text(json.dumps(self.state,allow_nan=False),encoding='utf-8')
            elif self.path.exists():
                archive = self.path.with_name(f'paper_trading_unreadable_{time.time_ns()}.json')
                archive.write_bytes(self.path.read_bytes())
            self.state = dict(running=True, startedAt=now, tradingFrom=first,
                settings=request.model_dump(mode='json'), candles=candles,
                lastProcessed=None, lastCheck=None, balance=float(request.capital),
                equity=float(request.capital), openPosition=None, trades=[], equityHistory=[],
                halted=False, latestPrice=None, signals=0, mode=mode,
                speed=getattr(request,'replay_speed',300), virtualTime=float(first),
                replayEnd=replay_end, replayCandles=replay_candles, completed=False)
            self.replay_tick = self.now()
            self.error = None
            self.save()
            return self.status()

    @staticmethod
    def encode(frame):
        return [dict(time=int(t.timestamp()), **{k:float(r[k]) for k in ('open','high','low','close')})
                for t,r in frame.iterrows()]

    def set_running(self, running):
        with self.lock:
            if not self.state:
                raise ValueError('Start a paper session first')
            if running and self.state['halted']:
                raise ValueError('Balance is zero or negative; start a new virtual session')
            if running and self.state.get('completed'):
                raise ValueError('Replay has finished; start a new session')
            self.state['running'] = running
            self.replay_tick = self.now()
            self.save()
            return self.status()

    def set_speed(self, speed):
        if not isinstance(speed,(int,float)) or not 1 <= speed <= 10000:
            raise ValueError('Replay speed must be between 1 and 10000')
        with self.lock:
            if not self.state or self.state.get('mode','live') != 'replay':
                raise ValueError('Speed changes are available in backtest replay only')
            self.state['speed'] = speed
            self.replay_tick = self.now()
            self.save()
            return self.status()

    def advance(self):
        """Append immutable candles then deterministically replay this session.

        Replay reconstructs trailing/rebound state without duplicating trades.
        Earlier committed candles are never replaced by later provider revisions.
        An open trade is retained; there is no period-end exit or daily reset.
        """
        with self.lock:
            if not self.state or not self.state['running']:
                return
            state = self.state
            cfg = state['settings']
            duration = TIMEFRAMES[cfg['entry_timeframe']]
            now = int(self.now())
            finished = False
            if state.get('mode','live') == 'replay':
                elapsed = max(0,self.now()-self.replay_tick)
                self.replay_tick = self.now()
                state['virtualTime'] = min(state['replayEnd'],state['virtualTime']+elapsed*state['speed'])
                finished = state['virtualTime'] >= state['replayEnd']
                history = pd.DataFrame(state['replayCandles'])
                history.index = pd.to_datetime(history.pop('time'),unit='s',utc=True)
                cutoff = state['virtualTime']
            else:
                history, _ = self.loader(cfg['entry_timeframe'])
                history = history.dropna(subset=['open','high','low','close'])
                cutoff = now
                state['virtualTime'] = now
            history = history.loc[history.index + pd.Timedelta(seconds=duration) <= pd.Timestamp(cutoff,unit='s',tz='UTC')]
            boundary = state['candles'][-1]['time'] if state['candles'] else state['tradingFrom']-1
            history = history.loc[history.index > pd.Timestamp(boundary,unit='s',tz='UTC')]
            state['lastCheck'] = now
            if not len(history) and not finished:
                self.save()
                return
            combined = state['candles']+self.encode(history)
            frame = pd.DataFrame(combined)
            frame.index = pd.to_datetime(frame.pop('time'),unit='s',utc=True)
            config = replace(Settings(**cfg['bb_reversal']), initial_capital=cfg['capital'],
                leverage=cfg['max_leverage'], trade_mode='Both', min_tick=cfg['tick_size'], min_tick_unit='price')
            result = run_backtest(frame, config, start=pd.Timestamp(state['tradingFrom'],unit='s',tz='UTC'),
                                  bar_seconds=duration, close_at_end=finished)
            if result['bars'].empty:
                state['candles'] = combined
                self.save()
                return
            trades = result['trades'].to_dict('records')
            for i,trade in enumerate(trades):
                trade.update(id=i+1, entry_time=int(trade['entry_time'].timestamp()),
                             exit_time=int(trade['exit_time'].timestamp()))
            position = result['open_position']
            if position:
                position['entry_time'] = int(position['entry_time'].timestamp())
            bars = result['bars']
            state.update(candles=combined, lastProcessed=int(bars.index[-1].timestamp()),
                balance=result['cash'], equity=float(bars.equity.iloc[-1]), openPosition=position,
                trades=trades, latestPrice=float(bars.close.iloc[-1]),
                equityHistory=[dict(time=int(t.timestamp()),value=float(v)) for t,v in bars.equity.items()],
                signals=int(bars[['long_signal','short_signal']].to_numpy().sum()),
                halted=result['cash'] <= 0, completed=finished)
            if state['halted'] or finished:
                state['running'] = False
            self.error = None
            self.save()

    def cycle(self):
        try:
            with self.lock:
                active = self.state is not None and self.state['running']
                mode = self.state.get('mode','live') if self.state else 'live'
            if not active:
                return
            if mode == 'replay':
                self.advance()
                return
            if self.now()-self.live_check < 30:
                return
            self.live_check = self.now()
            status = self.refresh.refresh()
            if status['running']:
                return  # Another download owns the cache; retry on the next cycle.
            if status['error']:
                self.error = status['error']
                return
            if self.stop.is_set():
                return
            self.advance()
        except Exception as error:
            self.error = str(error)

    def start(self):
        def loop():
            while not self.stop.is_set():
                self.cycle()
                self.stop.wait(1)
        self.thread = threading.Thread(target=loop,name='paper-trading',daemon=True)
        self.thread.start()

    def shutdown(self):
        self.stop.set()
        if self.thread:
            self.thread.join(timeout=1)


paper_service = PaperTrading()

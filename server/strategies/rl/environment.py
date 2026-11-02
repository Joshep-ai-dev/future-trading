"""Shared PPO training and replay simulator: closed observations, next-open fills."""
from __future__ import annotations

import gymnasium as gym
import numpy as np
import pandas as pd
from gymnasium import spaces

from server.strategies.rl.settings import RLSettings


class TradingEnv(gym.Env):
    metadata = {'render_modes': []}

    def __init__(self, bars: pd.DataFrame, features: np.ndarray, atr: np.ndarray, settings: RLSettings,
                 *, capital: float = 2000., leverage: float = 1., fee_bps: float = 0., slippage: float = 0.,
                 spread: float = 0., funding_bps: float = 0., min_tick: float = .01, bar_seconds: int = 300,
                 first_observation: int | None = None, random_start: bool = False, episode_bars: int = 512,
                 liquidate_at_end: bool = True):
        super().__init__()
        self.bars, self.features, self.atr, self.cfg = bars, np.asarray(features, np.float32), np.asarray(atr, float), settings
        self.capital, self.leverage = float(capital), float(leverage)
        self.fee, self.adverse, self.funding_bps = fee_bps/10000, slippage+spread/2, funding_bps
        self.min_tick, self.bar_seconds = min_tick, bar_seconds
        self.first = settings.lookback-1 if first_observation is None else first_observation
        if not settings.lookback-1 <= self.first < len(bars)-1 or len(features) != len(bars) or len(atr) != len(bars):
            raise ValueError('RL needs complete lookback candles and at least one following candle')
        self.random_start, self.episode_bars, self.liquidate_at_end = random_start, episode_bars, liquidate_at_end
        self.action_space = spaces.Discrete(3)  # target: flat, long, short
        size = settings.lookback*self.features.shape[1]+6
        self.observation_space = spaces.Box(-np.inf, np.inf, shape=(size,), dtype=np.float32)
        self.reset()

    def reset(self, *, seed: int | None = None, options: dict | None = None) -> tuple[np.ndarray, dict]:
        super().reset(seed=seed)
        self.t = self.first
        if self.random_start:
            latest = max(self.first, len(self.bars)-1-self.episode_bars)
            self.t = int(self.np_random.integers(self.first, latest+1))
        self.end = min(len(self.bars)-1, self.t+self.episode_bars) if self.random_start else len(self.bars)-1
        self.cash = self.equity = self.peak = self.capital
        self.drawdown = 0.
        self.turnover_notional = 0.
        self.position_changes = 0
        self.position = None
        self.trades: list[dict] = []
        self.records: list[dict] = []
        self.halted = self.done = False
        return self.observation(), {}

    def observation(self) -> np.ndarray:
        p = self.position
        unrealized = 0. if p is None else (float(self.bars.close.iloc[self.t])-p['entry_price'])*p['direction']*p['quantity']/self.capital
        state = [0. if p is None else p['direction'], unrealized,
                 0. if p is None else min(10., (self.t-p['entry_index'])/100), self.drawdown,
                 float(np.isfinite(self.atr[self.t]) and self.atr[self.t] > self.cfg.min_atr),
                 2*self.fee+2*self.adverse/float(self.bars.close.iloc[self.t])]
        return np.concatenate([self.features[self.t-self.cfg.lookback+1:self.t+1].reshape(-1), state]).astype(np.float32)

    def accrue(self, time: pd.Timestamp) -> None:
        if self.position is None:
            return
        p = self.position
        stamp = time.timestamp()
        cost = p['entry_price']*p['quantity']*self.funding_bps/10000*p['direction']*max(0., stamp-p['funding_time'])/(8*3600)
        self.cash -= cost
        p['funding'] += cost
        p['funding_time'] = stamp

    def close(self, time: pd.Timestamp, price: float, reason: str) -> None:
        if self.position is None:
            return
        self.accrue(time)
        p = self.position
        fill = float(price-p['direction']*self.adverse)
        fee = abs(fill*p['quantity'])*self.fee
        gross_fill = (fill-p['entry_price'])*p['direction']*p['quantity']
        gross_reference = (price-p['reference_entry'])*p['direction']*p['quantity']
        self.cash += gross_fill-fee
        self.turnover_notional += abs(fill*p['quantity'])
        self.position_changes += 1
        record = {key: value for key, value in p.items() if key != 'entry_index'}
        self.trades.append(dict(**record, exit_time=time, exit_price=fill, exit_reason=reason,
                                pnl=gross_fill-p['entry_fee']-fee-p['funding'], gross_pnl=gross_reference,
                                fees=p['entry_fee']+fee, execution_cost=gross_reference-gross_fill))
        self.position = None

    def active_stop(self) -> tuple[float, str]:
        """Tighter of the trade stop and portfolio drawdown liquidation level.

        Solve using entry fill, current cash, exit slippage/spread and exit fees.
        A market gap can still fill beyond this level; never invent a better fill.
        """
        p = self.position
        side, quantity = p['direction'], p['quantity']
        floor = self.peak*(1-self.cfg.max_drawdown_pct/100)
        fill = (floor-self.cash+side*quantity*p['entry_price'])/(quantity*(side-self.fee))
        risk_stop = float(fill+side*self.adverse)
        return (risk_stop, 'risk_limit') if side*(risk_stop-p['stop']) > 0 else (p['stop'], 'stop')

    def open(self, time: pd.Timestamp, price: float, side: int, atr: float) -> None:
        amount = self.cash*self.cfg.amount_per_trade/100 if self.cfg.amount_unit == 'percent' else min(self.cash, self.cfg.amount_per_trade)
        if amount <= 0:
            return
        fill = float(price+side*self.adverse)
        if fill <= 0:
            return
        quantity = amount*self.leverage/price
        fee = abs(fill*quantity)*self.fee
        stop = fill-side*max(self.min_tick, atr*self.cfg.stop_atr)
        self.cash -= fee
        self.turnover_notional += abs(fill*quantity)
        self.position_changes += 1
        self.position = dict(direction=side, entry_time=time, entry_price=fill, reference_entry=float(price),
                             entry_fee=fee, quantity=float(quantity), stop=float(stop), initial_stop=float(stop), target=None,
                             funding=0., funding_time=time.timestamp(), entry_index=self.t,
                             trail_trigger=0., trail_distance=None, trailing_active=False,
                             stop_history=[dict(time=int(time.timestamp()), price=float(stop), reason='protective')])

    def step(self, action: int) -> tuple[np.ndarray, float, bool, bool, dict]:
        if self.done:
            raise RuntimeError('Reset the RL environment after an episode ends')
        if not self.action_space.contains(action):
            raise ValueError('Invalid RL target position')
        previous_equity, previous_drawdown = self.equity, self.drawdown
        previous_turnover = self.turnover_notional
        observed_atr = self.atr[self.t]
        previous_time, previous_close = self.bars.index[self.t], float(self.bars.close.iloc[self.t])
        self.t += 1
        time, bar = self.bars.index[self.t], self.bars.iloc[self.t]
        desired = (0, 1, -1)[int(action)]
        gap = (time-previous_time).total_seconds() > self.bar_seconds
        blocked = False
        risk_triggered = False
        entered = 0
        if gap:
            self.close(previous_time+pd.Timedelta(seconds=self.bar_seconds), previous_close, 'data_gap')
            desired = 0
        self.accrue(time)
        if self.position is not None:
            p = self.position
            stop, reason = self.active_stop()
            if p['direction']*(bar.open-stop) <= 0:
                self.close(time, float(bar.open), reason)
                blocked = True
                risk_triggered = reason == 'risk_limit'
        if self.position is not None and self.position['direction'] != desired:
            self.close(time, float(bar.open), 'policy_exit' if desired == 0 else 'policy_reversal')
        if desired and self.position is None and not blocked and not gap:
            if np.isfinite(observed_atr) and observed_atr > self.cfg.min_atr:
                self.open(time, float(bar.open), desired, float(observed_atr))
                entered = desired if self.position is not None else 0
        if self.position is not None:
            p = self.position
            stop, reason = self.active_stop()
            if (p['direction'] == 1 and bar.low <= stop) or (p['direction'] == -1 and bar.high >= stop):
                fill = min(float(bar.open), stop) if p['direction'] == 1 else max(float(bar.open), stop)
                self.close(time, fill, reason)
                risk_triggered = reason == 'risk_limit'
        end_time = time+pd.Timedelta(seconds=self.bar_seconds)
        self.accrue(end_time)
        p = self.position
        unrealized = 0. if p is None else (bar.close-p['entry_price'])*p['direction']*p['quantity']
        self.equity = float(self.cash+unrealized)
        self.peak = max(self.peak, self.equity)
        self.drawdown = max(0., 1-self.equity/self.peak)
        terminated = risk_triggered or self.equity <= 0 or self.drawdown*100 >= self.cfg.max_drawdown_pct
        truncated = self.t >= self.end and not terminated
        self.done, self.halted = terminated or truncated, terminated
        if terminated or (truncated and self.liquidate_at_end):
            self.close(end_time, float(bar.close), 'risk_limit' if terminated else 'period_end')
            self.equity = float(self.cash)
            self.drawdown = max(0., 1-self.equity/self.peak)
        # This preference penalty shapes learning only; account P&L already
        # includes actual costs and must never be charged a second time.
        turnover_penalty = self.cfg.turnover_penalty*(self.turnover_notional-previous_turnover)/self.capital
        reward = ((self.equity-previous_equity)/self.capital
                  - self.cfg.drawdown_penalty*max(0., self.drawdown-previous_drawdown)-turnover_penalty)
        self.records.append(dict(time=time, long_signal=entered == 1, short_signal=entered == -1,
                                 position=0 if self.position is None else self.position['direction'],
                                 stop=np.nan if self.position is None else self.position['stop'], target=np.nan,
                                 trailing_active=False, equity=self.equity, atr=float(self.atr[self.t]), rl_action=int(action),
                                 turnover_notional=float(self.turnover_notional), position_changes=self.position_changes))
        return self.observation(), float(reward), bool(terminated), bool(truncated), dict(equity=self.equity, halted=self.halted)

    def result(self) -> dict:
        diagnostics = pd.DataFrame(self.records).set_index('time') if self.records else pd.DataFrame(index=self.bars.index[:0])
        bars = self.bars.reindex(diagnostics.index).join(diagnostics)
        position = None if self.position is None else {key: value for key, value in self.position.items() if key != 'entry_index'}
        return dict(bars=bars, trades=pd.DataFrame(self.trades), open_position=position, cash=float(self.cash), halted=self.halted)

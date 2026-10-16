"""Strategy registry: one adapter per strategy behind a common interface.

Backtests, paper trading and the API look strategies up here instead of
importing a specific engine. To add a strategy, implement ``StrategyRunner``
and register it in ``STRATEGIES``. ``run`` must return the engine contract
``dict(bars, trades, open_position, cash)``; bars carry ``equity``, ``stop``,
``long_signal`` and ``short_signal``.
"""
from __future__ import annotations

from dataclasses import asdict, replace

import numpy as np
import pandas as pd

from server.strategies.bb_outer_reversal import Settings, calculate, run_backtest
from server.strategies.readiness import strategy_readiness


class StrategyRunner:
    key: str
    label: str
    signal_label: str
    live_supported: bool = False

    def run(self, frame: pd.DataFrame, request, *, start=None, close_at_end=False, bar_seconds=None) -> dict:
        raise NotImplementedError

    def warmup_bars(self, request) -> int:
        raise NotImplementedError

    def chart_columns(self, frame: pd.DataFrame, request, bar_seconds: int) -> pd.DataFrame:
        """Columns bb_basis, bb_upper, bb_lower, trend_sma, adx, atr, bb_width_pct for the chart."""
        raise NotImplementedError

    def readiness(self, bar, request, frame: pd.DataFrame | None = None) -> dict:
        raise NotImplementedError

    def report(self, result: dict) -> dict | None:
        return None

    @staticmethod
    def costs(request) -> dict:
        return dict(fee_bps=getattr(request, 'fee_bps', 0), slippage=getattr(request, 'slippage', 0),
                    spread=getattr(request, 'spread', 0), funding_bps=getattr(request, 'funding_bps', 0))


class BBOuterReversal(StrategyRunner):
    key, label, signal_label, live_supported = 'bb_outer_reversal', 'BB Outer Band Reversal', 'BB outer-band rebound', True

    @staticmethod
    def settings(request) -> Settings:
        config = {k: v for k, v in request.bb_reversal.items() if k not in ('reward_risk', 'risk_per_trade_pct', 'hedge_mode')}
        return replace(Settings(**config), initial_capital=request.capital, leverage=request.max_leverage,
                       trade_mode='Both', min_tick=request.tick_size, min_tick_unit='price')

    def run(self, frame, request, *, start=None, close_at_end=False, bar_seconds=None):
        return run_backtest(frame, self.settings(request), start=start, close_at_end=close_at_end,
                            bar_seconds=bar_seconds, **self.costs(request))

    def warmup_bars(self, request):
        config = self.settings(request)
        return max(1000, config.bb_length*10, config.atr_length*10, config.adx_length*20,
                   config.sma_length*10+config.sma_slope_bars)

    def chart_columns(self, frame, request, bar_seconds):
        return calculate(frame, self.settings(request), bar_seconds=bar_seconds)

    def readiness(self, bar, request, frame=None):
        from server.strategies.indicators import rsi
        rsi_value = rsi(frame.tail(500), 14)[-1] if frame is not None and len(frame) else None
        return strategy_readiness(bar, asdict(self.settings(request)), rsi_value)


class MLEnsemble(StrategyRunner):
    key, label, signal_label = 'ml_ensemble', 'ML Ensemble', 'ML ensemble signal'

    @staticmethod
    def settings(request):
        from server.strategies.ml.strategy import MLSettings
        return MLSettings(**request.ml)

    def run(self, frame, request, *, start=None, close_at_end=False, bar_seconds=None):
        from server.strategies.ml.strategy import run_ml_backtest
        return run_ml_backtest(frame, self.settings(request), initial_capital=request.capital, leverage=request.max_leverage,
                               start=start, close_at_end=close_at_end, bar_seconds=bar_seconds,
                               min_tick=request.tick_size, **self.costs(request))

    def warmup_bars(self, request):
        return self.settings(request).warmup_bars

    def chart_columns(self, frame, request, bar_seconds):
        close = frame.close
        basis, std = close.rolling(20).mean(), close.rolling(20).std()
        previous = close.shift()
        tr = pd.concat([frame.high-frame.low, (frame.high-previous).abs(), (frame.low-previous).abs()], axis=1).max(axis=1)
        return frame.assign(bb_basis=basis, bb_upper=basis+2*std, bb_lower=basis-2*std,
                            trend_sma=close.ewm(span=50, adjust=False, min_periods=50).mean(),
                            atr=tr.ewm(alpha=1/14, adjust=False, min_periods=14).mean(), adx=np.nan,
                            bb_width_pct=400*std/basis)

    def readiness(self, bar, request, frame=None):
        from server.strategies.ml.strategy import ml_readiness
        return ml_readiness(bar, self.settings(request))

    def report(self, result):
        return result.get('report')


STRATEGIES: dict[str, StrategyRunner] = {runner.key: runner for runner in (BBOuterReversal(), MLEnsemble())}


def get_strategy(key: str) -> StrategyRunner:
    try:
        return STRATEGIES[key]
    except KeyError as error:
        raise ValueError(f'Unknown strategy: {key}') from error

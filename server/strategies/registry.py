"""Strategy registry: one adapter per strategy behind a common interface.

Backtests, paper trading and the API look strategies up here instead of
importing a specific engine. To add a strategy, implement ``StrategyRunner``
and register it in ``STRATEGIES``. ``run`` must return the engine contract
``dict(bars, trades, open_position, cash)``; bars carry ``equity``, ``stop``,
``long_signal`` and ``short_signal``.
"""
from __future__ import annotations


import numpy as np
import pandas as pd



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



class AdxSupertrend(StrategyRunner):
    key, label, signal_label, live_supported = 'adx_supertrend', 'ADX + Supertrend', 'ADX-confirmed Supertrend trend', False

    @staticmethod
    def settings(request):
        from server.strategies.adx_supertrend import Settings
        return Settings.from_dict(dict(getattr(request, 'adx_supertrend', None) or {}),
                                  initial_capital=float(request.capital), leverage=float(request.max_leverage),
                                  min_tick=float(request.tick_size))

    def run(self, frame, request, *, start=None, close_at_end=False, bar_seconds=None):
        from server.strategies.adx_supertrend import run_backtest
        return run_backtest(frame, self.settings(request), start=start, close_at_end=close_at_end,
                            bar_seconds=bar_seconds, **self.costs(request))

    def warmup_bars(self, request):
        from server.market.data import TIMEFRAMES
        from server.strategies.adx_supertrend import HTF_SECONDS
        s = self.settings(request)
        ratio = max(1, HTF_SECONDS[s.htf_timeframe]//TIMEFRAMES[request.entry_timeframe]) if s.htf_filter else 1
        base = max(s.adx_length, s.di_length, s.st_length, s.atr_length, s.rsi_length)*20
        forecast = 3000 if s.forecast_filter else 0  # forecast features use long windows
        return int(max(1500, base, ratio*s.st_length*12, s.atr_length*20, forecast))

    def chart_columns(self, frame, request, bar_seconds):
        from server.strategies.adx_supertrend import calculate
        bars = calculate(frame, replace_forecast(self.settings(request)), bar_seconds=bar_seconds)
        return bars.assign(bb_basis=np.nan, bb_upper=np.nan, bb_lower=np.nan, trend_sma=np.nan, bb_width_pct=np.nan)

    def readiness(self, bar, request, frame=None):
        from server.strategies.adx_supertrend import readiness
        return readiness(bar, self.settings(request))


class StScalper(StrategyRunner):
    """SuperTrend Scalper: next-open entries, ATR exits, regime / session / news filters (backtest and paper)."""
    key, label, signal_label, live_supported = 'st_scalper', 'SuperTrend Scalper', 'Filtered SuperTrend flip', False

    @staticmethod
    def settings(request):
        from server.strategies.st_scalper import Settings
        return Settings.from_dict(dict(getattr(request, 'st_scalper', None) or {}),
                                  initial_capital=float(request.capital), leverage=float(request.max_leverage),
                                  min_tick=float(request.tick_size))

    def run(self, frame, request, *, start=None, close_at_end=False, bar_seconds=None):
        from server.strategies.st_scalper import run_backtest
        return run_backtest(frame, self.settings(request), start=start, close_at_end=close_at_end,
                            bar_seconds=bar_seconds, **self.costs(request))

    def warmup_bars(self, request):
        from server.market.data import TIMEFRAMES
        from server.strategies.st_scalper import HTF_SECONDS
        s = self.settings(request)
        ratio = max(1, HTF_SECONDS[s.htf_timeframe]//TIMEFRAMES[request.entry_timeframe])
        return int(max(1500, s.htf_ema_length*ratio*3, s.atr_window+200, s.ema_fast_length*5))

    def chart_columns(self, frame, request, bar_seconds):
        from server.strategies.st_scalper import indicators
        s = self.settings(request)
        bars = indicators(frame, s, bar_seconds)
        return bars.assign(bb_basis=np.nan, bb_upper=np.nan, bb_lower=np.nan, bb_width_pct=np.nan,
                           trend_sma=bars.ema_fast if s.use_trend_filter else np.nan,
                           adx=bars.adx if s.use_adx_filter else np.nan)

    def readiness(self, bar, request, frame=None):
        from server.strategies.st_scalper import readiness
        return readiness(bar, bar, self.settings(request))


def replace_forecast(settings):
    """Chart overlays never need the (slow) forecast filter."""
    from dataclasses import replace
    return replace(settings, forecast_filter=False, forecast_model_id='') if settings.forecast_filter else settings


STRATEGIES: dict[str, StrategyRunner] = {runner.key: runner for runner in (AdxSupertrend(), StScalper())}


def get_strategy(key: str) -> StrategyRunner:
    try:
        return STRATEGIES[key]
    except KeyError as error:
        raise ValueError(f'No trading strategies are configured. Unavailable strategy: {key}') from error

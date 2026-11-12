"""Strategy registry: one adapter per strategy behind a common interface.

Backtests, paper trading and the API look strategies up here instead of
importing a specific engine. To add a strategy, implement ``StrategyRunner``
and register it in ``STRATEGIES``. ``run`` must return the engine contract
``dict(bars, trades, open_position, cash)``; bars carry ``equity``, ``stop``,
``long_signal`` and ``short_signal``.
"""
from __future__ import annotations


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



STRATEGIES: dict[str, StrategyRunner] = {}


def get_strategy(key: str) -> StrategyRunner:
    try:
        return STRATEGIES[key]
    except KeyError as error:
        raise ValueError(f'No trading strategies are configured. Unavailable strategy: {key}') from error

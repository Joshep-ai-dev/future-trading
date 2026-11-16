"""Strategy lab API for the SuperTrend Scalper: comparison report, parameter search, walk-forward.

Searches run as background jobs owned by the signed-in user (poll ``/jobs/{id}``).
"""
from __future__ import annotations

import math
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from server.strategies.st_scalper import SESSION_LABELS, VARIANTS, Settings
from server.strategies.st_scalper_lab import SEARCH_SPACE, Lab, compare, job, optimize, start_job, walk_forward

router = APIRouter(prefix='/api/lab/scalper')


class LabRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    timeframe: Literal['5m', '15m', '30m', '1h'] = '5m'
    settings: dict = Field(default_factory=dict)
    capital: float = Field(default=2000, gt=0, le=1e9)
    leverage: float = Field(default=1, ge=1, le=100)
    fee_bps: float = Field(default=6, ge=0, le=100)
    spread: float = Field(default=.02, ge=0, le=10)
    slippage: float = Field(default=.01, ge=0, le=10)
    funding_bps: float = Field(default=1, ge=-100, le=100)


class SearchRequest(LabRequest):
    ranges: dict[str, list[float]] = Field(default_factory=dict)
    trials: int = Field(default=100, ge=5, le=600)
    min_trades: int = Field(default=30, ge=1, le=10000)
    max_drawdown_pct: float = Field(default=30, gt=0, le=100)
    seed: int = Field(default=7, ge=0, le=10**6)


class WalkForwardRequest(SearchRequest):
    train_days: int = Field(default=60, ge=10, le=365)
    test_days: int = Field(default=30, ge=5, le=180)
    trials: int = Field(default=30, ge=5, le=200)
    min_trades: int = Field(default=20, ge=1, le=10000)


def _clean(value):
    """JSON-safe: inf / NaN become None (scores of rejected sets are -inf)."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {k: _clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean(v) for v in value]
    return value


def _lab(parameters: LabRequest) -> tuple[Lab, Settings]:
    from server.market.data import TIMEFRAMES, load_bars
    try:
        base = Settings.from_dict(parameters.settings, initial_capital=parameters.capital, leverage=parameters.leverage)
        frame, _ = load_bars(parameters.timeframe)
    except (ValueError, OSError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    costs = dict(fee_bps=parameters.fee_bps, slippage=parameters.slippage, spread=parameters.spread, funding_bps=parameters.funding_bps)
    return Lab(frame, costs, bar_seconds=TIMEFRAMES[parameters.timeframe]), base


def _ranges(parameters: SearchRequest) -> dict:
    ranges = {name: list(bounds) for name, bounds in parameters.ranges.items()} or {
        name: [low, high] for name, (_, low, high, _) in SEARCH_SPACE.items()}
    for name, bounds in ranges.items():
        if name not in SEARCH_SPACE or len(bounds) != 2:
            raise HTTPException(status_code=400, detail=f'Bad range for {name}')
    return ranges


@router.get('/space')
def search_space():
    return dict(space={name: dict(kind=kind, low=low, high=high, step=step) for name, (kind, low, high, step) in SEARCH_SPACE.items()},
                variants=[dict(key=key, label=label) for key, label, _ in VARIANTS], sessions=SESSION_LABELS)


@router.post('/compare')
def compare_variants(parameters: LabRequest):
    lab, base = _lab(parameters)
    try:
        return _clean(compare(lab, base))
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.post('/optimize')
def start_optimize(parameters: SearchRequest, request: Request):
    lab, base = _lab(parameters)
    ranges = _ranges(parameters)
    job_id = start_job(int(request.state.user['id']), 'optimize', lambda progress: _clean(optimize(
        lab, base, ranges, trials=parameters.trials, min_trades=parameters.min_trades,
        max_drawdown_pct=parameters.max_drawdown_pct, seed=parameters.seed, progress=progress)))
    return dict(job=job_id)


@router.post('/walk-forward')
def start_walk_forward(parameters: WalkForwardRequest, request: Request):
    lab, base = _lab(parameters)
    ranges = _ranges(parameters)
    job_id = start_job(int(request.state.user['id']), 'walk_forward', lambda progress: _clean(walk_forward(
        lab, base, ranges, train_days=parameters.train_days, test_days=parameters.test_days, trials=parameters.trials,
        min_trades=parameters.min_trades, max_drawdown_pct=parameters.max_drawdown_pct, seed=parameters.seed, progress=progress)))
    return dict(job=job_id)


@router.get('/jobs/{job_id}')
def job_status(job_id: str, request: Request):
    item = job(int(request.state.user['id']), job_id)
    if item is None:
        raise HTTPException(status_code=404, detail='Unknown job')
    return item

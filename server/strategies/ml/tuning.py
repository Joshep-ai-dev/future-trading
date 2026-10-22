"""Hyperparameter search for the ML Ensemble strategy.

Two nested stages keep the search affordable:

1. Model stage (expensive): every combination of horizon, take-profit and stop
   (plus model capacity) retrains the walk-forward ensemble once over the whole
   range. ``search_method='grid'`` tries a fixed grid; ``'ml'`` samples a wider
   random space.
2. Entry stage (cheap): for each trained combination, every entry probability,
   edge and reversal rule is executed on the already predicted probabilities.

The evaluated range is split 60/20/20 into train, validation and forward test.
All predictions are out-of-sample walk-forward predictions; candidates are
ranked on validation only and the forward test is reported, never used to pick.
The result has the same shape as the BB ``fine_tune`` so the UI can show either.
"""
from __future__ import annotations

import itertools
import random
from dataclasses import asdict, replace

import pandas as pd

from server.market.data import TIMEFRAMES
from server.strategies.fine_tuning import _score
from server.strategies.ml.strategy import MLSettings, execute, prepare, with_label_costs
from server.strategies.strategy import seconds, split_points

MODEL_GRID = dict(horizon=(8, 12, 24), take_profit_atr=(1., 1.5, 2.), stop_atr=(.75, 1.))
CAPACITIES = ('light', 'standard', 'rich')
ENTRY_GRID = dict(entry_threshold=(.45, .5, .55, .6, .65), min_edge=(.05, .1, .2, .3), reverse_on_signal=(True, False))
# Learned exits: the models set targets and stops; the search tunes how cautious they are.
LEARNED_MODEL_GRID = dict(horizon=(8, 12, 24), tp_quantile=(.3, .4, .5), sl_quantile=(.6, .75))
LEARNED_ENTRY_GRID = dict(entry_threshold=(.45, .5, .55, .6), min_edge=(.05, .1, .2), min_reward_risk=(1., 1.3),
                          trail_start=(.5, .8), quality_threshold=(.5, .55, .6))
RANDOM_MODELS = 24
FINALISTS = 5
# A few lucky validation trades must not win the search: require a real sample in both periods.
MIN_VALIDATION_TRADES = 10
MIN_TRAIN_TRADES = 20


def _ml_ranking_key(train: dict, validation: dict, objective: str) -> tuple:
    """Rank on train + validation together (both are out-of-sample walk-forward predictions).

    Order: enough trades in both periods, profitable in both, then combined profit (or score),
    then the shallower of the two drawdowns. The forward test is never used.
    """
    enough = validation['trades'] >= MIN_VALIDATION_TRADES and train['trades'] >= MIN_TRAIN_TRADES
    consistent = train['netPnl'] > 0 and validation['netPnl'] > 0
    combined = train['netPnl']+validation['netPnl']
    drawdown = -max(abs(train['maxDrawdownPct']), abs(validation['maxDrawdownPct']))  # higher = shallower
    if objective == 'profit':
        return (enough, consistent, combined, drawdown)
    return (enough, consistent, train['score']+validation['score'], combined)


def _combinations(axes: dict) -> list[dict]:
    keys = list(axes)
    return [dict(zip(keys, values)) for values in itertools.product(*(axes[key] for key in keys))]


def _random_models(base: MLSettings, count: int, seed: int = 1729) -> list[dict]:
    rng = random.Random(seed)
    seen, output = set(), []
    while len(output) < count:
        candidate = dict(horizon=rng.choice((6, 8, 12, 16, 24, 36, 48)), capacity=rng.choice(CAPACITIES))
        if base.exit_mode == 'learned':
            candidate.update(tp_quantile=rng.choice((.25, .3, .35, .4, .45, .5, .6)),
                             sl_quantile=rng.choice((.55, .6, .65, .7, .75, .8, .9)))
        else:
            candidate.update(take_profit_atr=rng.choice((.75, 1., 1.25, 1.5, 2., 2.5, 3.)),
                             stop_atr=rng.choice((.5, .75, 1., 1.25, 1.5, 2.)))
        key = tuple(candidate.values())
        if key not in seen:
            seen.add(key)
            output.append(candidate)
    return output


def ml_fine_tune(frame: pd.DataFrame, request, progress=None, search_method='grid', objective='profit',
                 validation_start=None, forward_start=None):
    if objective not in ('profit', 'balanced'):
        raise ValueError('Objective must be profit or balanced')
    if search_method not in ('grid', 'ml'):
        raise ValueError('Search method must be grid or ml')
    report = progress or (lambda percent, message: None)
    base = with_label_costs(MLSettings(**request.ml), request)
    duration = TIMEFRAMES[request.entry_timeframe]
    start = pd.Timestamp(seconds(request.start_date), unit='s', tz='UTC')
    end = pd.Timestamp(seconds(request.end_date)+86400, unit='s', tz='UTC')
    clean = frame.dropna(subset=['open', 'high', 'low', 'close'])
    clean = clean.loc[clean.index+pd.Timedelta(seconds=duration) <= end]
    evaluated_index = clean.index[clean.index >= start]
    if len(evaluated_index) < 600:
        raise ValueError('ML tuning needs at least 600 complete candles in the selected date range.')
    if (clean.index < start).sum() < base.train_bars // 2:
        report(1, 'Little history before the start date: the first blocks train on less data')
    validation_at, forward_at = split_points(evaluated_index, validation_start, forward_start)
    cuts = (evaluated_index[0], evaluated_index[validation_at], evaluated_index[forward_at], evaluated_index[-1])
    segments = dict(train=(cuts[0], cuts[1]), validation=(cuts[1], cuts[2]), forwardTest=(cuts[2], cuts[3]))
    costs = dict(fee_bps=request.fee_bps, slippage=request.slippage, spread=request.spread, funding_bps=request.funding_bps)

    learned = base.exit_mode == 'learned'
    model_grid = LEARNED_MODEL_GRID if learned else MODEL_GRID
    entry_grid = LEARNED_ENTRY_GRID if learned else ENTRY_GRID
    if search_method == 'grid':
        model_candidates = [{**combo, 'capacity': base.capacity} for combo in _combinations(model_grid)]
        grid_axes = {**{key: list(values) for key, values in model_grid.items()}, 'capacity': list(CAPACITIES),
                     **{key: [float(v) if not isinstance(v, bool) else v for v in values] for key, values in entry_grid.items()}}
    else:
        model_candidates = _random_models(base, RANDOM_MODELS)
        grid_axes = None
    entry_candidates = _combinations(entry_grid)

    def run_segment(prepared, settings, name):
        left, right = segments[name]
        result = execute(prepared, settings, initial_capital=request.capital, leverage=request.max_leverage,
                         start=left, end=right, close_at_end=True, bar_seconds=duration, min_tick=request.tick_size, **costs)
        return _score(result, request.capital)

    prepared_cache, scored = {}, []

    def evaluate_model(params, label, percent_from, percent_span, number, total):
        settings = replace(base, **params)
        key = settings.model_key()
        if key not in prepared_cache:
            def fold_progress(block, blocks):
                report(min(94, percent_from+int(percent_span*(number+block/max(1, blocks))/total)),
                       f'{label} {number+1} of {total}: training block {block+1} of {blocks}')
            prepared_cache[key] = prepare(clean, settings, start, progress=fold_progress)
        prepared = prepared_cache[key]
        for entry in entry_candidates:
            candidate = replace(settings, **entry)
            scored.append((run_segment(prepared, candidate, 'validation'), {**params, **entry}, key,
                           run_segment(prepared, candidate, 'train')))

    report(2, f'Training {len(model_candidates)} model settings × {len(entry_candidates)} entry rules')
    for number, params in enumerate(model_candidates):
        evaluate_model(params, 'Model setting', 2, 70, number, len(model_candidates))

    capacity_trials = 0
    if search_method == 'grid':
        best_models = []
        for metrics, params, _, _ in sorted(scored, key=lambda item: _ml_ranking_key(item[3], item[0], objective), reverse=True):
            model_part = {k: params[k] for k in model_grid}
            if model_part not in best_models:
                best_models.append(model_part)
            if len(best_models) == 2:
                break
        extra = [{**model, 'capacity': capacity} for model in best_models for capacity in CAPACITIES if capacity != base.capacity]
        for number, params in enumerate(extra):
            evaluate_model(params, 'Capacity check', 72, 14, number, len(extra))
        capacity_trials = len(extra)

    scored.sort(key=lambda item: _ml_ranking_key(item[3], item[0], objective), reverse=True)
    finalists, seen = [], set()
    for metrics, params, key, train_metrics in scored:
        identity = tuple(sorted(params.items()))
        if identity not in seen:
            seen.add(identity)
            finalists.append((metrics, params, key, train_metrics))
        if len(finalists) == FINALISTS:
            break

    candidates = []
    for rank, (validation_metrics, params, key, train_metrics) in enumerate(finalists, start=1):
        settings = replace(base, **params)
        prepared = prepared_cache[key]
        report(88+rank*2, f'Reporting finalist {rank} of {len(finalists)} on train and forward periods')
        candidates.append(dict(
            id=f'case-{rank}', rank=rank, bestParameters=params,
            bestSettings=request.model_copy(update={'ml': asdict(settings)}).model_dump(mode='json'),
            reliable=_ml_ranking_key(train_metrics, validation_metrics, objective)[:2] == (True, True),
            periods=dict(train=dict(metrics=train_metrics),
                         validation=dict(metrics=validation_metrics),
                         forwardTest=dict(metrics=run_segment(prepared, settings, 'forwardTest')))))
    best = candidates[0]
    stamps = [int(value.timestamp()) for value in cuts]
    report(100, 'ML tuning complete')
    return dict(
        bestSettings=best['bestSettings'], bestParameters=best['bestParameters'],
        searchMethod=search_method, gridAxes=grid_axes,
        model='Walk-forward grid search' if search_method == 'grid' else 'Walk-forward random search',
        objective=(f'Maximize train + validation net profit after costs; requires at least {MIN_TRAIN_TRADES} training and '
                   f'{MIN_VALIDATION_TRADES} validation trades and a profit in both; drawdown breaks ties. '
                   'All periods use out-of-sample model predictions; the forward test is not used for selection.'
                   if objective == 'profit' else
                   f'35% win rate, 35% profit, 20% drawdown control, 10% average loss control, on train + validation; '
                   f'requires {MIN_TRAIN_TRADES}/{MIN_VALIDATION_TRADES} trades and a profit in both periods.'),
        rankingObjective=objective, candidates=candidates, modelHyperparameters=None, modelCrossValidationRmse=None,
        candidatesEvaluated=len(scored), seedCandidates=len(model_candidates), adaptiveCandidatesEvaluated=capacity_trials,
        shortlisted=len(finalists),
        periods=dict(train=dict(start=stamps[0], end=stamps[1], metrics=best['periods']['train']['metrics']),
                     validation=dict(start=stamps[1], end=stamps[2], metrics=best['periods']['validation']['metrics']),
                     forwardTest=dict(start=stamps[2], end=stamps[3], metrics=best['periods']['forwardTest']['metrics'])),
    )

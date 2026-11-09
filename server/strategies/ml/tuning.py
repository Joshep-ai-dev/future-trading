"""Select a training configuration first, then tune entries and exits.

Model selection uses earlier walk-forward trades only. Fine tuning uses earlier
and validation trades, ranked by win rate then net profit after costs. The
forward period is reporting-only. Entry trials reuse each prepared prediction.
"""
from __future__ import annotations

import itertools
import random
from dataclasses import asdict, replace

import pandas as pd

from server.market.data import TIMEFRAMES
from server.strategies.fine_tuning import _score
from server.strategies.ml.strategy import MLSettings, execute, prepare
from server.strategies.strategy import seconds, split_points

MODEL_GRID = dict(take_profit_atr=(1.25, 1.5, 2.), stop_atr=(1.,))
PERCENT_STOP_GRID = (.6, .65, .7)
ENTRY_GRID = dict(entry_threshold=(.4, .5, .6, .7), min_edge=(.05, .1, .2), reverse_on_signal=(False,))
# Learned exits: the models set targets and stops; the search tunes how cautious they are.
LEARNED_MODEL_GRID = dict(tp_quantile=(.3, .4, .5), sl_quantile=(.6, .75))
LEARNED_ENTRY_GRID = dict(entry_threshold=(.45, .5, .55, .6), min_edge=(.05, .1, .2), min_reward_risk=(1., 1.3),
                          trail_start=(.5, .8), quality_threshold=(.5, .55, .6))
RANDOM_MODELS = 6
FINALISTS = 5
# A few lucky validation trades must not win the search: require a real sample in both periods.
MIN_VALIDATION_TRADES = 30
MIN_TRAIN_TRADES = 50


def _ml_ranking_key(train: dict, validation: dict) -> tuple:
    """Sample size and profitability gates, then win rate, profit and drawdown."""
    enough = validation['trades'] >= MIN_VALIDATION_TRADES and train['trades'] >= MIN_TRAIN_TRADES
    consistent = train['netPnl'] > 0 and validation['netPnl'] > 0 and not train.get('halted', False) and not validation.get('halted', False)
    return (enough, consistent, min(train['winRate'], validation['winRate']),
            train['netPnl']+validation['netPnl'],
            -max(abs(train['maxDrawdownPct']), abs(validation['maxDrawdownPct'])))


def _model_candidates(base: MLSettings) -> list[dict]:
    windows = dict.fromkeys((base.train_bars, max(500, base.train_bars//2), min(200_000, base.train_bars*3//2)))
    horizons = sorted({base.horizon, min(500, base.horizon*2)}) if base.exit_mode == 'forecast' else [base.horizon]
    return [dict(train_bars=window, horizon=horizon) for window in windows for horizon in horizons]


def _combinations(axes: dict) -> list[dict]:
    keys = list(axes)
    return [dict(zip(keys, values)) for values in itertools.product(*(axes[key] for key in keys))]


def _random_models(base: MLSettings, count: int, seed: int = 1729) -> list[dict]:
    if base.exit_mode == 'forecast':
        candidates = _combinations(dict(forecast_target_fraction=(.5, .65, .8, 1.), forecast_stop_buffer=(.8, 1., 1.2, 1.5)))
        return random.Random(seed).sample(candidates, min(count, len(candidates)))
    if base.exit_mode == 'percent':
        rng = random.Random(seed)
        # Search only the user-requested stop range; keep the target configured.
        stops = rng.sample(list(range(600, 701)), min(count, 101))
        return [dict(take_profit_pct=base.take_profit_pct, stop_loss_pct=value/1000) for value in stops]
    axes = (dict(tp_quantile=(.25, .35, .45, .5, .6), sl_quantile=(.55, .65, .75, .85))
            if base.exit_mode == 'learned' else
            dict(take_profit_atr=(1.25, 1.5, 1.75, 2., 2.5, 3.), stop_atr=(.75, 1., 1.25)))
    candidates = _combinations(axes)
    return random.Random(seed).sample(candidates, min(count, len(candidates)))


def ml_fine_tune(frame: pd.DataFrame, request, progress=None, search_method='grid',
                 validation_start=None, forward_start=None):
    if search_method not in ('grid', 'random'):
        raise ValueError('Search method must be grid or random')
    report = progress or (lambda percent, message: None)
    base = MLSettings(**request.ml)
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
    # Do not let adjacent evaluation segments share their boundary candle.
    tick = pd.Timedelta(nanoseconds=1)
    segments = dict(train=(cuts[0], cuts[1]-tick), validation=(cuts[1], cuts[2]-tick), forwardTest=(cuts[2], cuts[3]))
    costs = dict(fee_bps=request.fee_bps, slippage=request.slippage, spread=request.spread, funding_bps=request.funding_bps)

    def run_segment(prepared, settings, name):
        left, right = segments[name]
        result = execute(prepared, settings, initial_capital=request.capital, leverage=request.max_leverage,
                         start=left, end=right, close_at_end=True, bar_seconds=duration, min_tick=request.tick_size, **costs)
        return _score(result, request.capital)

    report(2, 'Stage 1: selecting the training configuration')
    selection = []
    profiles = _model_candidates(base)
    # Avoid training forward-period models during model selection.
    selection_frame = clean.loc[clean.index < cuts[1]]
    for index, params in enumerate(profiles):
        candidate = replace(base, **params)
        def selection_progress(block, blocks):
            report(2+int(23*(index+block/max(1, blocks))/len(profiles)),
                   f'Stage 1: model configuration {index+1} of {len(profiles)}, block {block} of {blocks}')
        prepared = prepare(selection_frame, candidate, start, progress=selection_progress)
        metrics = run_segment(prepared, candidate, 'train')
        selection.append(dict(parameters=params, metrics=metrics))
    def selection_rank(item: dict) -> tuple:
        metrics = item['metrics']
        return (metrics['trades'] >= MIN_TRAIN_TRADES, metrics['netPnl'] > 0,
                metrics['winRate'], metrics['netPnl'], -abs(metrics['maxDrawdownPct']))
    selection.sort(key=selection_rank, reverse=True)
    selected_model = selection[0]
    base = replace(base, **selected_model['parameters'])
    report(26, f"Stage 1 complete: selected training window {base.train_bars} candles")

    learned = base.exit_mode == 'learned'
    model_grid = (dict(forecast_target_fraction=(.6, .8, 1.), forecast_stop_buffer=(1., 1.2))
                  if base.exit_mode == 'forecast' else dict(take_profit_pct=(base.take_profit_pct,), stop_loss_pct=PERCENT_STOP_GRID)
                  if base.exit_mode == 'percent' else LEARNED_MODEL_GRID if learned else MODEL_GRID)
    entry_grid = LEARNED_ENTRY_GRID if learned else ENTRY_GRID
    if search_method == 'grid':
        model_candidates = _combinations(model_grid)
        grid_axes = {**{key: list(values) for key, values in model_grid.items()}, 'train_bars': [base.train_bars],
                     **{key: [float(v) if not isinstance(v, bool) else v for v in values] for key, values in entry_grid.items()}}
    else:
        model_candidates = _random_models(base, RANDOM_MODELS)
        grid_axes = None
    entry_candidates = _combinations(entry_grid)

    prepared_cache, scored = {}, []

    def evaluate_model(params, label, percent_from, percent_span, number, total):
        settings = replace(base, **params)
        key = settings.model_key()
        if key not in prepared_cache:
            def fold_progress(block, blocks):
                report(min(85, percent_from+int(percent_span*(number+block/max(1, blocks))/total)),
                       f'{label} {number+1} of {total}: training block {block+1} of {blocks}')
            prepared_cache[key] = prepare(clean, settings, start, progress=fold_progress)
        prepared = prepared_cache[key]
        for entry in entry_candidates:
            candidate = replace(settings, **entry)
            scored.append((run_segment(prepared, candidate, 'validation'), {**selected_model['parameters'], **params, **entry}, key,
                           run_segment(prepared, candidate, 'train')))

    report(27, f'Stage 2: {len(model_candidates)} exit settings x {len(entry_candidates)} entry rules')
    for number, params in enumerate(model_candidates):
        evaluate_model(params, 'Stage 2 exit setting', 27, 58, number, len(model_candidates))

    scored.sort(key=lambda item: _ml_ranking_key(item[3], item[0]), reverse=True)
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
            reliable=_ml_ranking_key(train_metrics, validation_metrics)[:2] == (True, True),
            skippedTrainingBlocks=sum(f.get('status') == 'skipped'
                                      for f in getattr(getattr(prepared, 'walk', None), 'folds', [])),
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
        objective=(f'Win rate first (the lower of earlier and validation win rates), then combined net profit after costs; '
                   f'requires {MIN_TRAIN_TRADES}/{MIN_VALIDATION_TRADES} trades and profit in both periods. '
                   'The forward test is never used for selection.'),
        rankingObjective='win_rate', candidates=candidates, modelHyperparameters=None, modelCrossValidationRmse=None,
        modelSelection=dict(selected=selected_model, candidates=selection),
        candidatesEvaluated=len(scored), seedCandidates=len(model_candidates), adaptiveCandidatesEvaluated=0,
        shortlisted=len(finalists),
        periods=dict(train=dict(start=stamps[0], end=stamps[1], metrics=best['periods']['train']['metrics']),
                     validation=dict(start=stamps[1], end=stamps[2], metrics=best['periods']['validation']['metrics']),
                     forwardTest=dict(start=stamps[2], end=stamps[3], metrics=best['periods']['forwardTest']['metrics'])),
    )

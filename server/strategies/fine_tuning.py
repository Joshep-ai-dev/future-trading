"""Grid or random search across BB reversal settings with fixed win-rate-first ranking."""
from dataclasses import replace
from itertools import product

import numpy as np
import pandas as pd
from scipy.stats import randint
from sklearn.model_selection import ParameterSampler

from server.strategies.bb_outer_reversal import Settings, calculate, run_backtest
from server.market.data import TIMEFRAMES
from server.strategies.strategy import split_points, seconds


TRIALS = 64
SHORTLIST = 4
PARAMETERS = (
    'bb_length', 'bb_mult', 'min_bb_width_pct',
    'atr_length', 'min_atr', 'adx_length',
    'adx_threshold', 'pullback_bars', 'initial_sl', 'trail_trigger',
    'trail_distance', 'trail_multiplier', 'sma_length',
    'use_sma_trend_adjustment', 'sma_slope_bars', 'counter_profit_pct',
    'counter_sl_pct', 'rsi_exit_enabled', 'rsi_exit_length',
    'rsi_exit_move', 'rsi_exit_short', 'rsi_exit_long',
    'amount_per_trade', 'amount_unit', 'leverage',
)
INTEGER_PARAMETERS = {'bb_length': 1000, 'atr_length': 500, 'adx_length': 500,
                      'pullback_bars': 100, 'sma_length': 1000,
                      'sma_slope_bars': 500, 'rsi_exit_length': 500}
PERCENT_PARAMETERS = {'counter_profit_pct', 'counter_sl_pct'}
CATEGORIES = {'amount_unit': ('price', 'percent')}


def _candidate_space(base):
    space = {}
    for name in PARAMETERS:
        value = getattr(base, name)
        if name in ('amount_per_trade', 'amount_unit', 'leverage'):
            space[name] = [value]
        elif name in CATEGORIES:
            space[name] = list(CATEGORIES[name])
        elif isinstance(value, bool):
            space[name] = [False, True]
        elif name in INTEGER_PARAMETERS:
            maximum = INTEGER_PARAMETERS[name]
            space[name] = sorted({
                min(maximum, max(1, round(value * factor)))
                for factor in (.65, .8, 1., 1.2, 1.4)
            })
        elif name in PERCENT_PARAMETERS:
            space[name] = sorted({
                round(min(100., max(1., value * factor)), 4)
                for factor in (.65, .8, 1., 1.2, 1.4)
            })
        elif name in ('adx_threshold', 'rsi_exit_short', 'rsi_exit_long'):
            step = max(2., value * .15)
            space[name] = sorted({round(min(100., max(0., value + offset)), 4)
                                  for offset in (-2 * step, -step, 0., step, 2 * step)})
        elif name == 'min_bb_width_pct':
            step = max(.1, value * .2)
            space[name] = sorted({round(min(100., max(0., value + offset)), 4)
                                  for offset in (-2 * step, -step, 0., step, 2 * step)})
        else:
            minimum = 1. if name in ('leverage', 'trail_multiplier') else (
                .1 if name == 'bb_mult' else .01)
            maximums = {'leverage': 100., 'bb_mult': 100., 'min_bb_width_pct': 100.,
                        'min_atr': 100., 'initial_sl': 100., 'trail_trigger': 100.,
                        'trail_distance': 100., 'trail_multiplier': 100.,
                        'rsi_exit_move': 100., 'amount_per_trade': base.initial_capital}
            maximum = maximums.get(name, float('inf'))
            space[name] = sorted({round(min(maximum, max(minimum, value * factor)), 4)
                                  for factor in (.65, .8, 1., 1.2, 1.4)})
    return space


def _parameter_key(params):
    encoded = []
    for name in PARAMETERS:
        value = params[name]
        if name in CATEGORIES:
            value = CATEGORIES[name].index(value)
        elif isinstance(value, bool):
            value = int(value)
        encoded.append(round(float(value), 6))
    return tuple(encoded)


def _candidate_set(base, count, seed, excluded=()):
    space = _candidate_space(base)
    original = {name: getattr(base, name) for name in PARAMETERS}
    seen = set(excluded)
    candidates = []
    target = count
    if not excluded:
        candidates.append(original)
        seen.add(_parameter_key(original))
        target = max(0, count - 1)
    sampler_space = {name: randint(0, len(values)) for name, values in space.items()}
    for indices in ParameterSampler(sampler_space, n_iter=max(target * 8, target),
                                    random_state=seed):
        params = {name: space[name][index] for name, index in indices.items()}
        # Percent allocation has a hard 100% limit; keep sampled value valid when
        # the model switches amount units from a price value to a percentage.
        params['amount_per_trade'] = min(
            100. if params['amount_unit'] == 'percent' else base.initial_capital,
            params['amount_per_trade'])
        key = _parameter_key(params)
        if key in seen:
            continue
        seen.add(key)
        candidates.append(params)
        if len(candidates) == target + (1 if not excluded else 0):
            break
    return candidates


def _grid_candidates(base):
    """Exhaustive Cartesian product; fixed settings retain user values."""
    axes = {
        'bb_length': sorted({max(1, round(base.bb_length*f)) for f in (.8, 1., 1.2)}),
        'bb_mult': sorted({round(max(.1, base.bb_mult*f), 4) for f in (.8, 1., 1.2)}),
        'initial_sl': sorted({round(max(.01, base.initial_sl*f), 4) for f in (.75, 1., 1.25)}),
    }
    axes.update(
        trail_trigger=sorted({round(max(.01, base.trail_trigger*f), 4) for f in (.75, 1., 1.5)}),
        trail_distance=sorted({round(max(.01, base.trail_distance*f), 4) for f in (.75, 1., 1.25)}))
    original = {name: getattr(base, name) for name in PARAMETERS}
    names = list(axes)
    candidates = [{**original, **dict(zip(names, values))}
                  for values in product(*(axes[name] for name in names))]
    return axes, candidates


def _score(result, capital):
    trades = result['trades']
    count = len(trades)
    pnl = trades.pnl.to_numpy(dtype=float) if count else np.array([], dtype=float)
    wins = int((pnl > 0).sum())
    losses = pnl[pnl < 0]
    win_rate = wins / count * 100 if count else 0.
    net_pnl = float(pnl.sum())
    return_pct = net_pnl / capital * 100
    values = result['bars'].equity.to_numpy(dtype=float)
    peak, drawdown = capital, 0.
    for value in values:
        peak = max(peak, value)
        if peak > 0:
            drawdown = min(drawdown, (value / peak - 1) * 100)
    winners = pnl[pnl > 0]
    average_win = float(winners.mean()) if len(winners) else 0.
    average_loss = float(abs(losses.mean())) if len(losses) else 0.
    average_loss_pct = float(abs(losses.mean()) / capital * 100) if len(losses) else 0.
    profit_component = min(100., max(0., 50. + return_pct / 2))
    drawdown_component = max(0., 100. - abs(drawdown))
    loss_component = max(0., 100. - average_loss_pct)
    score = (0.35 * win_rate + 0.35 * profit_component +
             0.20 * drawdown_component + 0.10 * loss_component)
    score *= min(1., count / 20)
    return dict(averageWin=round(average_win,4), averageLoss=round(average_loss,4),
                payoffRatio=round(average_win/average_loss,3) if average_loss else None,
                score=round(score, 3), trades=count, wins=wins,
                losses=int((pnl < 0).sum()), winRate=round(win_rate, 2),
                netPnl=round(net_pnl, 4), returnPct=round(return_pct, 3),
                maxDrawdownPct=round(drawdown, 3), averageLossPct=round(average_loss_pct, 3))


def _ranking_key(metrics: dict) -> tuple:
    return (metrics['trades'] >= 20, metrics['netPnl'] > 0,
            metrics['winRate'], metrics['netPnl'], metrics['maxDrawdownPct'])


def fine_tune(frame, request, progress=None, search_method='grid', validation_start=None, forward_start=None):
    """Search strategy and allocation settings; validate before reporting holdout."""
    report = progress or (lambda percent, message: None)
    report(1, 'Preparing candles and indicator periods')
    duration = TIMEFRAMES[request.entry_timeframe]
    start = pd.Timestamp(seconds(request.start_date), unit='s', tz='UTC')
    end = pd.Timestamp(seconds(request.end_date) + 86400, unit='s', tz='UTC')
    clean = frame.dropna(subset=['open', 'high', 'low', 'close'])
    clean = clean.loc[clean.index + pd.Timedelta(seconds=duration) <= end]
    if len(clean.loc[clean.index >= start]) < 300:
        raise ValueError('Fine tuning needs at least 300 complete candles in the selected date range.')

    base = replace(Settings(**request.bb_reversal), initial_capital=request.capital,
                   min_tick=request.tick_size, min_tick_unit='price',
                   leverage=request.max_leverage)
    reference = calculate(clean, base, bar_seconds=duration)
    reference = reference.loc[reference.index >= start]
    train_end, validation_end = split_points(reference.index, validation_start, forward_start)
    boundaries = (reference.index[0], reference.index[train_end],
                  reference.index[validation_end], reference.index[-1])

    def candidate_segments(config, training_only=False):
        source = clean.loc[clean.index < boundaries[1]] if training_only else clean
        calculated = calculate(source, config, bar_seconds=duration)
        calculated = calculated.loc[calculated.index >= start]
        return (calculated.loc[(calculated.index >= boundaries[0]) & (calculated.index < boundaries[1])],
                calculated.loc[(calculated.index >= boundaries[1]) & (calculated.index < boundaries[2])],
                calculated.loc[(calculated.index >= boundaries[2]) & (calculated.index <= boundaries[3])])

    costs = dict(fee_bps=request.fee_bps, slippage=request.slippage, spread=request.spread, funding_bps=request.funding_bps)
    evaluated = {}
    phase_counts = {}
    def evaluate(params, phase, start_pct, span_pct, total):
        config = replace(base, **params)
        next_count = phase_counts.get(phase, 0) + 1
        report(min(94, start_pct + int(span_pct * (next_count - .5) / max(1, total))),
               f'{phase}: preparing setting {next_count} of {total}')
        train, _, _ = candidate_segments(config, training_only=True)
        result = run_backtest(train, config, close_at_end=True, prepared_bars=train, **costs)
        metrics = _score(result, request.capital)
        evaluated[_parameter_key(params)] = (params, metrics)
        phase_counts[phase] = phase_counts.get(phase, 0) + 1
        report(min(94, start_pct + int(span_pct * phase_counts[phase] / max(1, total))),
               f'{phase}: evaluated {phase_counts[phase]} settings')

    if search_method not in ('grid', 'random'):
        raise ValueError('Search method must be grid or random')
    grid_axes = None
    if search_method == 'grid':
        grid_axes, initial_candidates = _grid_candidates(base)
    else:
        initial_candidates = _candidate_set(base, TRIALS, seed=1729)
    report(3, f'Testing every one of {len(initial_candidates)} grid combinations' if search_method == 'grid' else f'Testing {len(initial_candidates)} starting settings')
    for params in initial_candidates:
        evaluate(params, 'Grid search' if search_method == 'grid' else 'Initial search', 3, 44, len(initial_candidates))

    # Both search methods validate every sampled candidate. No surrogate models
    # or blended score can override the win-rate-first order.
    shortlist = [params for params, _ in evaluated.values()]
    validated = []
    for index, params in enumerate(shortlist):
        config = replace(base, **params)
        _, validation, _ = candidate_segments(config)
        result = run_backtest(validation, config, close_at_end=True, prepared_bars=validation, **costs)
        validated.append((_score(result, request.capital),
                          evaluated[_parameter_key(params)][1], params))
        report(85 + int(8 * (index + 1) / len(shortlist)),
               f'Validation: checked {index + 1} of {len(shortlist)} finalists')
    validated.sort(key=lambda item: _ranking_key(item[0]), reverse=True)
    validated = validated[:SHORTLIST]
    candidate_results = []
    for index, (validation_metrics, train_metrics, params) in enumerate(validated, start=1):
        config = replace(base, **params)
        _, _, forward = candidate_segments(config)
        forward_result = run_backtest(forward, config, close_at_end=True, prepared_bars=forward, **costs)
        candidate_results.append(dict(
            id=f'case-{index}', rank=index,
            reliable=(_ranking_key(validation_metrics)[:2] == (True, True)
                      and train_metrics['trades'] >= 20 and train_metrics['netPnl'] > 0),
            bestParameters=params,
            bestSettings=request.model_copy(update={
                'bb_reversal': {**request.bb_reversal, **{key: value for key, value in params.items()
                                                          if key != 'leverage'}},
                'max_leverage': params['leverage'],
            }).model_dump(mode='json'),
            periods=dict(train=dict(metrics=train_metrics),
                         validation=dict(metrics=validation_metrics),
                         forwardTest=dict(metrics=_score(forward_result, request.capital))),
        ))
        report(95 + index, f'Forward-tested selected candidate {index} of {len(validated)}')
    validation_metrics, train_metrics, best_params = validated[0]
    forward_metrics = candidate_results[0]['periods']['forwardTest']['metrics']
    timestamps = [int(reference.index[0].timestamp()), int(reference.index[train_end].timestamp()),
                  int(reference.index[validation_end].timestamp()),
                  int(reference.index[-1].timestamp())]
    best_settings = candidate_results[0]['bestSettings']
    report(100, 'Fine tuning complete')
    return dict(
        bestSettings=best_settings, bestParameters=best_params,
        searchMethod=search_method, gridAxes=grid_axes,
        model='Exhaustive grid search' if search_method == 'grid' else 'Random search',
        objective='Win rate first, then net profit after costs; require at least 20 validation trades and positive profit. Forward data is reporting-only.',
        rankingObjective='win_rate',
        candidates=candidate_results, modelHyperparameters=None, modelCrossValidationRmse=None,
        candidatesEvaluated=len(evaluated), seedCandidates=len(initial_candidates),
        adaptiveCandidatesEvaluated=0, shortlisted=len(validated),
        periods=dict(train=dict(start=timestamps[0], end=timestamps[1], metrics=train_metrics),
                     validation=dict(start=timestamps[1], end=timestamps[2], metrics=validation_metrics),
                     forwardTest=dict(start=timestamps[2], end=timestamps[3],
                                      metrics=forward_metrics)),
    )

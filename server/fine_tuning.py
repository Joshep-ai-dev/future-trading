"""ML-assisted search across BB reversal settings with walk-forward scoring."""
from dataclasses import replace

import numpy as np
import pandas as pd
from scipy.stats import randint
from sklearn.ensemble import (ExtraTreesRegressor, HistGradientBoostingRegressor,
                              RandomForestRegressor, VotingRegressor)
from sklearn.model_selection import KFold, ParameterSampler, cross_val_score

from .bb_outer_reversal import Settings, calculate, run_backtest
from .data import TIMEFRAMES
from .strategy import seconds


TRIALS = 64
ADAPTIVE_TRIALS = 16
SHORTLIST = 5
ML_HYPERPARAMETER_TRIALS = 6
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
        if name in CATEGORIES:
            space[name] = list(CATEGORIES[name])
        elif isinstance(value, bool):
            space[name] = [False, True]
        elif isinstance(value, int):
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


def _ensemble(config):
    return VotingRegressor(estimators=[
        ('random_forest', RandomForestRegressor(
            n_estimators=config['rf_trees'], min_samples_leaf=config['rf_leaf'],
            max_features=config['rf_max_features'], random_state=1729, n_jobs=1)),
        ('extra_trees', ExtraTreesRegressor(
            n_estimators=config['extra_trees'], min_samples_leaf=config['extra_leaf'],
            max_features=config['extra_max_features'], random_state=1733, n_jobs=1)),
        ('hist_gradient_boosting', HistGradientBoostingRegressor(
            max_iter=config['hist_iterations'], max_leaf_nodes=config['hist_leaf_nodes'],
            l2_regularization=config['hist_l2'], random_state=1741)),
    ], weights=config['weights'])


def _fit_ensemble(rows, config):
    features = np.asarray([_parameter_key(params) for params, _ in rows], dtype=float)
    scores = np.asarray([metrics['score'] for _, metrics in rows], dtype=float)
    model = _ensemble(config)
    model.fit(features, scores)
    return model


def _tune_model_hyperparameters(rows, progress):
    features = np.asarray([_parameter_key(params) for params, _ in rows], dtype=float)
    scores = np.asarray([metrics['score'] for _, metrics in rows], dtype=float)
    choices = {
        'rf_trees': [80, 140, 220], 'rf_leaf': [1, 2, 4],
        'rf_max_features': [0.7, 1.0], 'extra_trees': [80, 140, 220],
        'extra_leaf': [1, 2, 4], 'extra_max_features': [0.7, 1.0],
        'hist_iterations': [80, 140], 'hist_leaf_nodes': [7, 15],
        'hist_l2': [0.1, 1., 5.], 'weights': [(1, 1, 1), (2, 1, 1), (1, 2, 1)],
    }
    sampler_space = {name: randint(0, len(values)) for name, values in choices.items()}
    configs = [{name: choices[name][index] for name, index in sample.items()}
               for sample in ParameterSampler(sampler_space, n_iter=ML_HYPERPARAMETER_TRIALS,
                                              random_state=4817)]
    folds = KFold(n_splits=3, shuffle=True, random_state=4819)
    scored = []
    for index, config in enumerate(configs, start=1):
        errors = -cross_val_score(_ensemble(config), features, scores, cv=folds,
                                  scoring='neg_root_mean_squared_error', n_jobs=1)
        rmse = float(errors.mean())
        scored.append((rmse, config))
        progress(48 + int(8 * index / len(configs)),
                 f'Tuning model hyperparameters: configuration {index} of {len(configs)}')
    rmse, best_config = min(scored, key=lambda item: item[0])
    return best_config, round(rmse, 4)


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
    average_loss_pct = float(abs(losses.mean()) / capital * 100) if len(losses) else 0.
    profit_component = min(100., max(0., 50. + return_pct / 2))
    drawdown_component = max(0., 100. - abs(drawdown))
    loss_component = max(0., 100. - average_loss_pct)
    score = (0.35 * win_rate + 0.35 * profit_component +
             0.20 * drawdown_component + 0.10 * loss_component)
    score *= min(1., count / 20)
    return dict(score=round(score, 3), trades=count, wins=wins,
                losses=int((pnl < 0).sum()), winRate=round(win_rate, 2),
                netPnl=round(net_pnl, 4), returnPct=round(return_pct, 3),
                maxDrawdownPct=round(drawdown, 3), averageLossPct=round(average_loss_pct, 3))


MODES = (
    ('lower_loss', 'Smaller losses', 'Prioritizes average losing trade size and drawdown; may reduce profit.'),
    ('higher_profit', 'Higher profit', 'Prioritizes net profit; may accept larger losses and drawdown.'),
    ('higher_win_rate', 'Higher win rate', 'Prioritizes winning trade percentage; losses can still outweigh wins.'),
    ('more_trades', 'More trades', 'Prioritizes trading frequency; execution costs can reduce returns.'),
)


def _mode_key(metrics, mode):
    """Prefer meaningful samples, then the requested historical objective."""
    enough = metrics['trades'] >= 20
    if mode == 'lower_loss':
        objective = (-metrics['averageLossPct'], metrics['maxDrawdownPct'], metrics['netPnl'])
    elif mode == 'higher_profit':
        objective = (metrics['netPnl'], metrics['maxDrawdownPct'])
    elif mode == 'higher_win_rate':
        objective = (metrics['winRate'], metrics['netPnl'])
    else:
        objective = (metrics['trades'], metrics['netPnl'])
    return (metrics['trades'] > 0, enough, *objective)


def fine_tune(frame, request, progress=None):
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
    train_end = int(len(reference) * .6)
    validation_end = int(len(reference) * .8)
    boundaries = (reference.index[0], reference.index[train_end],
                  reference.index[validation_end], reference.index[-1])
    if train_end == 0 or validation_end <= train_end or validation_end >= len(reference):
        raise ValueError('Selected range is too short to make train, validation and forward-test periods.')

    def candidate_segments(config):
        calculated = calculate(clean, config, bar_seconds=duration)
        calculated = calculated.loc[calculated.index >= start]
        return (calculated.loc[(calculated.index >= boundaries[0]) & (calculated.index < boundaries[1])],
                calculated.loc[(calculated.index >= boundaries[1]) & (calculated.index < boundaries[2])],
                calculated.loc[(calculated.index >= boundaries[2]) & (calculated.index <= boundaries[3])])

    evaluated = {}
    phase_counts = {}
    def evaluate(params, phase, start_pct, span_pct, total):
        config = replace(base, **params)
        next_count = phase_counts.get(phase, 0) + 1
        report(min(94, start_pct + int(span_pct * (next_count - .5) / max(1, total))),
               f'{phase}: preparing setting {next_count} of {total}')
        train, _, _ = candidate_segments(config)
        result = run_backtest(train, config, close_at_end=True, prepared_bars=train)
        metrics = _score(result, request.capital)
        evaluated[_parameter_key(params)] = (params, metrics)
        phase_counts[phase] = phase_counts.get(phase, 0) + 1
        report(min(94, start_pct + int(span_pct * phase_counts[phase] / max(1, total))),
               f'{phase}: evaluated {phase_counts[phase]} settings')

    initial_candidates = _candidate_set(base, TRIALS, seed=1729)
    # Search substantially smaller allocations as well as nearby settings.
    # Stops alone cannot control dollar losses when position exposure is large.
    original = {name: getattr(base, name) for name in PARAMETERS}
    for allocation in (5., 10., 25.):
        defensive = {**original, 'amount_unit': 'percent',
                     'amount_per_trade': allocation, 'leverage': 1.}
        if _parameter_key(defensive) not in {_parameter_key(p) for p in initial_candidates}:
            initial_candidates.append(defensive)
    report(3, f'Testing {len(initial_candidates)} starting settings')
    for params in initial_candidates:
        evaluate(params, 'Initial search', 3, 44, len(initial_candidates))

    report(48, 'Tuning the scikit-learn model hyperparameters')
    model_hyperparameters, model_cv_rmse = _tune_model_hyperparameters(
        list(evaluated.values()), report)
    first_model = _fit_ensemble(list(evaluated.values()), model_hyperparameters)
    first_pool = _candidate_set(base, 1024, seed=2731, excluded=evaluated)
    adaptive_evaluated = 0
    if first_pool:
        features = np.asarray([_parameter_key(params) for params in first_pool], dtype=float)
        predictions = first_model.predict(features)
        proposals = sorted(zip(predictions, first_pool), key=lambda item: item[0], reverse=True)
        for _, params in proposals[:ADAPTIVE_TRIALS]:
            evaluate(params, 'ML guided search', 57, 15, min(ADAPTIVE_TRIALS, len(proposals)))
            adaptive_evaluated += 1

    report(74, 'Fitting the tuned ensemble to the expanded search')
    model = _fit_ensemble(list(evaluated.values()), model_hyperparameters)
    final_pool = _candidate_set(base, 2048, seed=3739, excluded=evaluated)
    ranked = list(evaluated.values())
    if final_pool:
        features = np.asarray([_parameter_key(params) for params in final_pool], dtype=float)
        predictions = model.predict(features)
        ranked.extend((params, {'score': float(score), 'netPnl': 0., 'maxDrawdownPct': 0.})
                      for score, params in zip(predictions, final_pool))
    ranked.sort(key=lambda item: (item[1]['score'], item[1]['netPnl'],
                                  item[1]['maxDrawdownPct']), reverse=True)
    shortlist = []
    seen_shortlist = set()
    for params, _ in ranked:
        key = _parameter_key(params)
        if key not in seen_shortlist:
            seen_shortlist.add(key)
            shortlist.append(params)
        if len(shortlist) == SHORTLIST:
            break

    # Include training finalists for every objective, not just the blended score.
    for mode, _, _ in MODES:
        leaders = sorted(evaluated.values(), key=lambda row: _mode_key(row[1], mode), reverse=True)
        for params, _ in leaders[:SHORTLIST]:
            key = _parameter_key(params)
            if key not in seen_shortlist:
                seen_shortlist.add(key)
                shortlist.append(params)

    report(75, 'Rechecking finalists and validating their settings')
    for index, params in enumerate(shortlist):
        if _parameter_key(params) not in evaluated:
            evaluate(params, 'Finalist check', 75, 9, len(shortlist))

    validated = []
    for index, params in enumerate(shortlist):
        config = replace(base, **params)
        _, validation, _ = candidate_segments(config)
        result = run_backtest(validation, config, close_at_end=True, prepared_bars=validation)
        validated.append((_score(result, request.capital),
                          evaluated[_parameter_key(params)][1], params))
        report(85 + int(8 * (index + 1) / len(shortlist)),
               f'Validation: checked {index + 1} of {len(shortlist)} finalists')
    recommendations = []
    for mode, label, description in MODES:
        winner = max(validated, key=lambda item: _mode_key(item[0], mode))
        recommendations.append((*winner, mode, label, description))
    candidate_results = []
    for index, (validation_metrics, train_metrics, params, mode, label, description) in enumerate(recommendations, start=1):
        config = replace(base, **params)
        _, _, forward = candidate_segments(config)
        forward_result = run_backtest(forward, config, close_at_end=True, prepared_bars=forward)
        candidate_results.append(dict(
            id=mode, rank=index, mode=mode, label=label, description=description,
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
        report(95 + index, f'Forward-tested recommendation {index} of {len(recommendations)}')
    validation_metrics, train_metrics, best_params = recommendations[0][:3]
    forward_metrics = candidate_results[0]['periods']['forwardTest']['metrics']
    timestamps = [int(reference.index[0].timestamp()), int(reference.index[train_end].timestamp()),
                  int(reference.index[validation_end].timestamp()),
                  int(reference.index[-1].timestamp())]
    best_settings = candidate_results[0]['bestSettings']
    report(100, 'Fine tuning complete')
    return dict(
        bestSettings=best_settings, bestParameters=best_params,
        model='scikit-learn VotingRegressor: RandomForestRegressor + ExtraTreesRegressor + HistGradientBoostingRegressor',
        objective='Four modes selected on validation data: smaller average losses, higher net profit, higher win rate, and more trades. Prefer at least 20 trades. Forward data is used only for reporting. Modes may select the same settings. Default: smaller losses.',
        candidates=candidate_results, modelHyperparameters=model_hyperparameters,
        modelCrossValidationRmse=model_cv_rmse,
        candidatesEvaluated=len(evaluated), seedCandidates=len(initial_candidates),
        adaptiveCandidatesEvaluated=adaptive_evaluated, shortlisted=len(validated),
        periods=dict(train=dict(start=timestamps[0], end=timestamps[1], metrics=train_metrics),
                     validation=dict(start=timestamps[1], end=timestamps[2], metrics=validation_metrics),
                     forwardTest=dict(start=timestamps[2], end=timestamps[3],
                                      metrics=forward_metrics)),
    )

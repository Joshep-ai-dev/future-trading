"""Past-only forecast benchmarks and empirical trade-outcome calibration.

Future prices are used only to label completed historical proposals. Every
statistic used to decide at t is delayed by the entire holding horizon + 1.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def proposal_returns(frame, probabilities, atr, signals, settings, costs):
    """Vectorized, independent next-open trials with the actual adaptive exit rule.

    Stops win OHLC ties. Overlapping trials are excluded when fitting quality
    statistics below. Returns are per unit, net of adverse fills and costs.
    """
    n, horizon = len(frame), settings.forecast_max_hold_bars or settings.horizon
    side = np.asarray(signals, float)
    def future(values, step):
        result = np.full(n, np.nan)
        if step < n:
            result[:-step] = np.asarray(values)[step:]
        return result
    adverse = costs['slippage']+costs['spread']/2
    fee = costs['fee_bps']/10000
    entry = future(frame.open, 1)+side*adverse
    up, down, trend = (probabilities[f'forecast_{key}'].to_numpy(float) for key in ('up', 'down', 'trend'))
    scale = np.asarray(atr, float)
    target_distance = np.where(side > 0, up, down)*scale*settings.forecast_target_fraction
    stop_distance = np.where(side > 0, down, up)*scale*settings.forecast_stop_buffer
    target = entry+side*np.maximum(costs['min_tick'], target_distance)
    stop = entry-side*np.maximum(costs['min_tick'], stop_distance)
    result = np.full(n, np.nan)
    active = (side != 0) & np.isfinite(entry+stop+target)
    invalid = np.zeros(n, bool)
    stamps = frame.index.asi8
    for step in range(1, min(horizon, n-1)+1):
        opening, high, low, close = (future(frame[key], step) for key in ('open', 'high', 'low', 'close'))
        gap = future(stamps, step)-future(stamps, step-1) if step > 1 else future(stamps, 1)-stamps
        invalid |= ~np.isfinite(gap) | (gap != costs['bar_seconds']*1_000_000_000)
        stopped = active & np.where(side > 0, low <= stop, high >= stop)
        touched = active & ~stopped & np.where(side > 0, high >= target, low <= target)
        price = np.where(stopped, np.where(side > 0, np.minimum(opening, stop), np.maximum(opening, stop)),
                         np.where(side > 0, np.maximum(opening, target), np.minimum(opening, target)))
        # On the entry bar the opening gap cannot be captured as pre-entry profit.
        if step == 1:
            price = np.where(touched, target, price)
        next_trend = future(trend, step)
        model_exit = active & ~stopped & ~touched & np.isfinite(next_trend) & (side*next_trend <= 0) & settings.forecast_adaptive_exits
        timeout = active & ~stopped & ~touched & (step == horizon)
        close_now = stopped | touched | model_exit | timeout
        price = np.where(model_exit | timeout, close, price)
        fill = price-side*adverse
        gap_exit = (stopped & (side*(opening-stop) <= 0)) | (touched & (side*(opening-target) >= 0) & (step > 1))
        elapsed = np.where(gap_exit, step-1, step)
        funding = entry*costs['funding_bps']/10000*side*elapsed*costs['bar_seconds']/(8*3600)
        net = side*(fill-entry)-fee*(entry+np.abs(fill))-funding
        result[close_now] = net[close_now]
        active &= ~close_now
        # Reforecast at this completed close; levels apply to following candles.
        next_up, next_down = future(up*scale, step), future(down*scale, step)
        candidate = close-side*np.maximum(costs['min_tick'], np.where(side > 0, next_down, next_up)*settings.forecast_stop_buffer)
        valid_update = np.isfinite(candidate+next_up+next_down+next_trend) & settings.forecast_adaptive_exits
        stop = np.where(valid_update, np.where(side > 0, np.maximum(stop, candidate), np.minimum(stop, candidate)), stop)
        target = np.where(valid_update, close+side*np.maximum(costs['min_tick'], np.where(side > 0, next_up, next_down)*settings.forecast_target_fraction), target)
    # Conservative: require a complete, uninterrupted holding window even if
    # a proposal exits early; never accidentally use a partial trailing label.
    result[invalid] = np.nan
    result[max(0, n-horizon):] = np.nan
    return pd.Series(result, index=frame.index)


def validate_forecasts(prepared, settings, raw_signals, *, min_tick, bar_seconds, fee_bps, slippage, spread, funding_bps):
    frame, p, atr = prepared.clean, prepared.walk.probabilities, prepared.atr
    horizon, window, minimum = settings.horizon, settings.train_bars, 30
    delay = max(horizon, settings.forecast_max_hold_bars)+1
    truth = prepared.forecast_targets
    if truth is None:
        return np.zeros(len(frame), bool), dict(samples=0, modelMaeAtr=None, baselineMaeAtr=None, uncertaintyQuantile=.9, calibrationDelay=delay, minimumQualitySamples=minimum, proposedEntries=int(np.count_nonzero(raw_signals)), benchmarkPassed=0, uncertaintyPassed=0, qualityPassed=0, message='No forecast truth available for historical calibration'), pd.DataFrame(index=frame.index)
    estimate = p[['forecast_up', 'forecast_down', 'forecast_trend']].to_numpy(float)
    target = truth[['up', 'down', 'trend']].to_numpy(float)
    # A range baseline knows only completed past outcomes; direction baseline is no change.
    baseline = truth[['up', 'down', 'trend']].shift(delay).rolling(window, min_periods=minimum).mean()
    baseline['trend'] = 0.
    residual = pd.DataFrame(np.abs(estimate-target), index=frame.index, columns=['up', 'down', 'trend'])
    baseline_error = (baseline-truth[['up', 'down', 'trend']]).abs()
    known = np.isfinite(estimate).all(axis=1) & baseline.notna().all(axis=1).to_numpy() & np.isfinite(target).all(axis=1)
    model_error = residual.where(pd.Series(known, index=frame.index)).mean(axis=1)
    naive_error = baseline_error.where(pd.Series(known, index=frame.index)).mean(axis=1)
    past_error = model_error.shift(delay).rolling(window, min_periods=minimum).mean()
    past_baseline = naive_error.shift(delay).rolling(window, min_periods=minimum).mean()
    uncertainty = residual.trend.where(known).shift(delay).rolling(window, min_periods=minimum).quantile(.9)
    round_trip = 2*(slippage+spread/2)+2*frame.close*fee_bps/10000
    uncertainty_ok = np.abs(p.forecast_trend)*atr > uncertainty*atr+round_trip
    benchmark_ok = past_error < past_baseline
    costs = dict(min_tick=min_tick, bar_seconds=bar_seconds or 300, fee_bps=fee_bps,
                 slippage=slippage, spread=spread, funding_bps=funding_bps)
    outcome = proposal_returns(frame, p, atr, raw_signals, settings, costs)
    # Non-overlapping proposal windows avoid counting every adjacent candle as
    # independent evidence. Sampling does not inspect outcomes or predictions ahead.
    sample = np.zeros(len(frame), bool)
    next_sample = 0
    for i, signal in enumerate(raw_signals):
        if signal and i >= next_sample:
            sample[i] = True
            next_sample = i+max(horizon, settings.forecast_max_hold_bars)+1
    probability = np.full(len(frame), np.nan)
    expectancy = np.full(len(frame), np.nan)
    count = np.zeros(len(frame))
    agreement = p[['p_long', 'p_short']].max(axis=1).to_numpy()
    bucket = np.minimum(3, np.searchsorted([.6, .75, .9], agreement))
    for side in (-1, 1):
        for band in range(4):
            chosen = (np.asarray(raw_signals) == side) & (bucket == band)
            historical = outcome.where(sample & chosen).shift(delay)
            rolling = historical.rolling(window, min_periods=minimum)
            counts = historical.rolling(window, min_periods=1).count()
            wins = historical.gt(0).where(historical.notna()).rolling(window, min_periods=minimum).mean()
            # A dispersion buffer is conservative, not a formal confidence bound:
            # market observations remain dependent and nonstationary.
            net = rolling.mean()-rolling.std()/np.sqrt(counts.clip(lower=1))
            probability[chosen] = wins.to_numpy()[chosen]
            expectancy[chosen] = net.to_numpy()[chosen]
            count[chosen] = counts.to_numpy()[chosen]
    quality_ok = (probability >= settings.quality_threshold) & (expectancy > 0) & (count >= minimum)
    allowed = benchmark_ok.to_numpy() & uncertainty_ok.to_numpy() & quality_ok
    diagnostics = pd.DataFrame(dict(p_trade_win=probability, net_expectancy=expectancy,
                                     forecast_uncertainty_atr=uncertainty, quality_samples=count), index=frame.index)
    evaluated = np.arange(len(frame)) >= prepared.start_index
    valid = known & evaluated
    proposed = (np.asarray(raw_signals) != 0) & evaluated
    report = dict(samples=int(valid.sum()), modelMaeAtr=float(model_error[valid].mean()) if valid.any() else None,
                  baselineMaeAtr=float(naive_error[valid].mean()) if valid.any() else None,
                  uncertaintyQuantile=.9, calibrationDelay=delay, minimumQualitySamples=minimum,
                  proposedEntries=int(np.count_nonzero(np.asarray(raw_signals)[evaluated])),
                  benchmarkPassed=int((benchmark_ok.to_numpy() & proposed).sum()),
                  uncertaintyPassed=int((uncertainty_ok.to_numpy() & proposed).sum()),
                  qualityPassed=int((quality_ok & proposed).sum()),
                  message='Entry checks use matured out-of-sample forecasts and non-overlapping completed proposals. Tree agreement is not trade-win probability.')
    return allowed, report, diagnostics

"""Local implementation of the supplied Python and Pine Markov frameworks.

State order is always Bear / Sideways / Bull, including Pine mode.
"""
import argparse
import json
import numpy as np
import pandas as pd
from .data import TIMEFRAMES, load_bars

STATES = ['Bear', 'Sideways', 'Bull']


def label_regimes(close, window=20, threshold=.05, method='python', bear_threshold=.05):
    valid = close.rolling(window+1).count().eq(window+1)
    ratio = close / close.shift(window)
    returns = np.log(ratio) if method == 'pine' else ratio - 1
    bear = bear_threshold if method == 'pine' else threshold
    return np.where(valid, np.where(returns > threshold, 2, np.where(returns < -bear, 0, 1)), -1)


def transition_counts(labels):
    counts = np.zeros((3, 3), dtype=int)
    a, b = labels[:-1], labels[1:]
    valid = (a >= 0) & (b >= 0)
    np.add.at(counts, (a[valid], b[valid]), 1)
    return counts


def transition_matrix(counts, method='python'):
    totals = counts.sum(axis=1, keepdims=True)
    # Match the reference: Python leaves unseen rows zero; Pine uses uniform.
    matrix = np.full((3, 3), 1/3 if method == 'pine' else 0.)
    return np.divide(counts, totals, out=matrix, where=totals != 0)


def stationary_distribution(matrix):
    # The Python reference's eigenvector is undefined for non-stochastic or
    # non-unique cases. Return no estimate instead of an arbitrary vector.
    if not np.allclose(matrix.sum(axis=1), 1):
        return None
    a = np.vstack((matrix.T - np.eye(3), np.ones(3)))
    if np.linalg.matrix_rank(a) < 3:
        return None
    p = np.linalg.lstsq(a, np.array([0., 0., 0., 1.]), rcond=None)[0]
    p = np.maximum(p, 0)
    return (p / p.sum()).tolist()


def walk_forward_backtest(close, labels, min_train=252, periods_per_year=252, capital=10000., cost_bps=0., start_date=None, end_date=None):
    """Reference timing: fit labels[:t], sign signal at t, score return t -> t+1.

    Missing bars are never compressed. Cost overlay is optional and separate
    from the reference's gross returns. No claim of executable close fills.
    """
    start = pd.Timestamp(start_date, tz='UTC') if start_date else None
    end = pd.Timestamp(end_date, tz='UTC') + pd.Timedelta(days=1) if end_date else None
    if start is not None and end is not None and start >= end:
        raise ValueError('Start date must be on or before end date.')
    seconds = int((close.index[1]-close.index[0]).total_seconds()) if len(close)>1 else 60
    stamps = close.index + pd.Timedelta(seconds=seconds)
    # Discard everything after the selected end before checking training history.
    if end is not None:
        keep = stamps <= end
        close, labels, stamps = close.loc[keep], labels[keep], stamps[keep]
    counts = np.zeros((3, 3), dtype=int)
    seen = 0
    gross, net, times, positions = [], [], [], []
    previous = 0.
    prices = close.to_numpy()
    eligible = int((labels >= 0).sum()) >= min_train + 30
    for t in range(len(labels)-1):
        state = labels[t]
        if eligible and state >= 0 and seen >= min_train and labels[t+1] >= 0 and (start is None or stamps[t] >= start):
            # counts currently contains transitions entirely before t.
            row = counts[state]
            signal = (row[2]-row[0])/row.sum() if row.sum() else 0.
            position = float(np.sign(signal))
            raw = position * (prices[t+1]/prices[t]-1)
            turnover = abs(position-previous)
            ends_segment = t+2 >= len(labels) or labels[t+2] < 0
            turnover += abs(position) if ends_segment else 0
            gross.append(raw)
            net.append(raw-turnover*cost_bps/10000)
            positions.append(position)
            times.append(t+1)
            previous = 0. if ends_segment else position
        if t and labels[t-1] >= 0 and state >= 0:
            counts[labels[t-1], state] += 1
        if state >= 0:
            seen += 1
    gross = np.asarray(gross)
    net = np.asarray(net)
    def metrics(returns):
        values = np.r_[capital, capital*np.cumprod(1+returns)]
        sd = returns.std(ddof=1) if len(returns)>1 else 0.
        return dict(balance=float(values[-1]), returnPct=float((values[-1]/capital-1)*100),
            maxDrawdown=float(np.min(values/np.maximum.accumulate(values)-1)*100),
            sharpe=float(returns.mean()/sd*np.sqrt(periods_per_year)) if sd>0 else None)
    equity = []
    if times:
        seconds = int((close.index[1]-close.index[0]).total_seconds())
        # CSV timestamps mark opens; close-to-close observations end one bar later.
        stamps = [int(close.index[t].timestamp())+seconds for t in [times[0]-1]+times]
        g = np.r_[capital, capital*np.cumprod(1+gross)]
        n = np.r_[capital, capital*np.cumprod(1+net)]
        equity = [dict(time=t, value=float(v), gross=float(gv)) for t,v,gv in zip(stamps,n,g)]
    return dict(**metrics(net), gross=metrics(gross), equity=equity, evaluatedBars=len(net),
                positionChanges=int(np.count_nonzero(np.diff(np.r_[0., positions]))),
                status='ok' if times else ('insufficient_history' if not eligible else 'no_evaluable_bars'), requiredLabels=min_train+30,
                range=dict(startDate=str(start_date) if start_date else None, endDate=str(end_date) if end_date else None,
                           actualStart=equity[0]['time'] if equity else None, actualEnd=equity[-1]['time'] if equity else None),
                availableLabels=int((labels>=0).sum()), periodsPerYear=periods_per_year)


def hmm_summary(close, enabled):
    if not enabled:
        return dict(available=False, reason='Disabled')
    try:
        from hmmlearn.hmm import GaussianHMM
    except ImportError:
        return dict(available=False, reason='Optional dependency missing: install requirements-hmm.txt')
    returns = close.pct_change(fill_method=None).dropna().to_numpy().reshape(-1, 1)
    if len(returns) < 30:
        return dict(available=False, reason='HMM needs at least 30 valid returns.')
    try:
        model = GaussianHMM(n_components=3, covariance_type='diag', n_iter=200, random_state=42)
        model.fit(returns)
        means = model.means_.ravel()
        order = np.argsort(means)
        return dict(available=True, regimes=[dict(label=STATES[rank], latentState=int(k),
                    meanReturn=float(means[k])) for rank,k in enumerate(order)],
                    converged=bool(model.monitor_.converged))
    except Exception as error:
        return dict(available=False, reason=f'HMM could not fit: {error}')


def transition_markers(labels, times, hold):
    markers, last, run, current = [], None, 0, -1
    for i,state in enumerate(labels):
        run = run+1 if state >= 0 and state == current else 1
        current = state
        if state < 0:
            run = 0
        elif run >= hold and state != last:
            if last is not None:
                markers.append(dict(time=int(times[i-hold+1].timestamp()), confirmedAt=int(times[i].timestamp()),
                                    text=f'{STATES[last]} → {STATES[state]}', regime=STATES[state]))
            last = state
    return markers


def analyze(frame, quality, window=20, threshold=.05, min_train=252, horizon=5,
            cost_bps=0., capital=10000., timeframe='1m', method='python', bear_threshold=.05,
            stationary_power=50, min_regime_hold=4, hmm=False):
    close = frame.close
    labels = label_regimes(close, window, threshold, method, bear_threshold)
    indexes = np.flatnonzero(labels >= 0)
    if not len(indexes):
        raise ValueError(f'Need at least {window+1} consecutive complete bars for this lookback.')
    latest = int(indexes[-1])
    counts = transition_counts(labels)
    matrix = transition_matrix(counts, method)
    state = int(labels[latest])
    probs = matrix[state]
    # If a Python row is unobserved, 0/0 is unknown, not a probability forecast.
    next_probs = probs.tolist() if np.isclose(probs.sum(),1) else None
    forecast_row = np.linalg.matrix_power(matrix,horizon)[state]
    forecast = forecast_row.tolist() if np.isclose(forecast_row.sum(),1) else None
    stationary = stationary_distribution(matrix)
    # Pine takes row 0 in its Sideways/Bull/Bear encoding (Sideways here).
    pine_mix = np.linalg.matrix_power(matrix, stationary_power)[1].tolist() if method=='pine' else None
    seconds = TIMEFRAMES[timeframe]
    backtest = walk_forward_backtest(close, labels, min_train, 365*86400/seconds, capital, cost_bps)
    full_markers = transition_markers(labels, frame.index, min_regime_hold)
    visible = frame.loc[frame.close.notna()].tail(5000)
    candles = [dict(time=int(t.timestamp()), open=float(r.open), high=float(r.high), low=float(r.low), close=float(r.close),
        regime=STATES[labels[frame.index.get_loc(t)]] if labels[frame.index.get_loc(t)]>=0 else 'Warmup')
        for t,r in visible.iterrows()]
    # Keep chart payload bounded, preserving all observations in metric calculations.
    eq = backtest['equity']
    if len(eq)>5000:
        take = np.unique(np.linspace(0,len(eq)-1,5000,dtype=int))
        backtest['equity'] = [eq[i] for i in take]
    return dict(states=STATES, quality=quality, dataRange=dict(startDate=str(frame.index[frame.close.notna()][0].date()),
        endDate=str(frame.index[frame.close.notna()][-1].date())), params=dict(window=window,threshold=threshold,min_train=min_train,
        horizon=horizon,cost_bps=cost_bps,capital=capital,timeframe=timeframe,method=method,bear_threshold=bear_threshold,
        stationary_power=stationary_power,min_regime_hold=min_regime_hold,hmm=hmm), candles=candles,
        markers=[m for m in full_markers if m['time']>=candles[0]['time']], currentRegime=STATES[state],
        asOf=int(frame.index[latest].timestamp()+seconds), transitionCounts=counts.tolist(),
        transitionMatrix=matrix.tolist(), nextProbabilities=next_probs, forecast=forecast, stationary=stationary,
        pineMix=pine_mix, signal=float(probs[2]-probs[0]) if next_probs is not None else None,
        backtest=backtest, hmm=hmm_summary(close,hmm), unseenStates=[STATES[i] for i in range(3) if not counts[i].sum()])


def main():
    parser = argparse.ArgumentParser(description='Markov analysis of the local OKX XAG CSV')
    parser.add_argument('--timeframe', choices=TIMEFRAMES, default='1m')
    parser.add_argument('--method', choices=['python','pine'], default='python')
    parser.add_argument('--window', type=int, default=20)
    parser.add_argument('--threshold', type=float, default=.05)
    parser.add_argument('--bear-threshold', type=float, default=.05)
    parser.add_argument('--min-train', type=int, default=252)
    parser.add_argument('--horizon', type=int, default=5)
    parser.add_argument('--hmm', action='store_true')
    args = vars(parser.parse_args())
    from .app import Parameters
    params = Parameters(**args)
    frame, quality = load_bars(params.timeframe)
    result = analyze(frame, quality, **params.model_dump())
    for key in ['candles', 'markers']:
        result.pop(key)
    result['backtest'].pop('equity')
    print(json.dumps(result, indent=2, allow_nan=False))


if __name__ == '__main__':
    main()

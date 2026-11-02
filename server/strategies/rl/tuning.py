"""Train and evaluate one PPO configuration; no grid or random search."""
from dataclasses import asdict

import pandas as pd

from server.market.data import TIMEFRAMES
from server.strategies.fine_tuning import _score
from server.strategies.rl.settings import RLSettings
from server.strategies.rl.strategy import run_rl_backtest
from server.strategies.strategy import seconds, split_points


def rl_train_and_evaluate(frame, request, progress=None, validation_start=None, forward_start=None):
    latest = [0]
    def report(percent: int, message: str) -> None:
        latest[0] = max(latest[0], percent)
        if progress:
            progress(latest[0], message)
    base = RLSettings(**request.rl)
    duration = TIMEFRAMES[request.entry_timeframe]
    start = pd.Timestamp(seconds(request.start_date), unit='s', tz='UTC')
    end = pd.Timestamp(seconds(request.end_date)+86400, unit='s', tz='UTC')
    clean = frame.dropna(subset=['open', 'high', 'low', 'close'])
    clean = clean.loc[clean.index+pd.Timedelta(seconds=duration) <= end]
    index = clean.index[clean.index >= start]
    if len(index) < 600:
        raise ValueError('PPO evaluation needs at least 600 evaluation candles plus training history')
    validation, forward = split_points(index, validation_start, forward_start)
    cuts = (index[0], index[validation], index[forward], index[-1]+pd.Timedelta(seconds=duration))
    def segment(settings, number):
        left, right = cuts[number:number+2]
        source = clean.loc[clean.index+pd.Timedelta(seconds=duration) <= right]
        result = run_rl_backtest(source, settings, initial_capital=request.capital, leverage=request.max_leverage,
                                 start=left, close_at_end=True, bar_seconds=duration, min_tick=request.tick_size,
                                 fee_bps=request.fee_bps, slippage=request.slippage, spread=request.spread,
                                 funding_bps=request.funding_bps,
                                 progress=lambda percent, message: report(min(94, 5+number*30+int(percent*.3)), message))
        metrics = _score(result, request.capital)
        metrics['halted'] = bool(result.get('halted', False))
        return metrics

    metrics = []
    for number, name in enumerate(('earlier period', 'validation', 'forward test')):
        report(2+number*30, f'PPO training and evaluation: {name}')
        metrics.append(segment(base, number))
    train, validation_metrics, forward_metrics = metrics
    reasons = []
    for name, values, minimum in (('Earlier period', train, 50), ('Validation', validation_metrics, 30)):
        if values['netPnl'] <= 0:
            reasons.append(f"{name} net profit is {values['netPnl']:.2f}; positive profit after costs is required.")
        if values['trades'] < minimum:
            reasons.append(f"{name} has {values['trades']} trades; at least {minimum} are required.")
        if values['halted']:
            reasons.append(f'{name} hit the drawdown risk limit.')
    settings = request.model_copy(update={'rl': asdict(base)}).model_dump(mode='json')
    parameters = dict(seed=base.seed, learning_rate=base.learning_rate, timesteps=base.timesteps)
    periods = dict(train=dict(metrics=train), validation=dict(metrics=validation_metrics), forwardTest=dict(metrics=forward_metrics))
    case = dict(id='ppo-training', rank=1, reliable=not reasons, reliabilityReasons=reasons,
                bestParameters=parameters, bestSettings=settings, periods=periods)
    report(100, 'PPO training and evaluation complete')
    return dict(bestSettings=settings, bestParameters=parameters, searchMethod='training', gridAxes=None,
                model='PPO training and evaluation',
                objective='One configured PPO policy; eligible checkpoints rank by return divided by drawdown (1 percentage point floor), then net profit. Forward data is reporting-only.',
                rankingObjective='risk_adjusted_return', candidates=[case], candidatesEvaluated=1, seedCandidates=1,
                adaptiveCandidatesEvaluated=0, shortlisted=1, modelHyperparameters=None, modelCrossValidationRmse=None,
                periods={name:dict(start=int(cuts[i].timestamp()), end=int(cuts[i+1].timestamp()), metrics=metrics[i])
                         for i, name in enumerate(('train', 'validation', 'forwardTest'))})

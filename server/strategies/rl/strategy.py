from __future__ import annotations

import numpy as np
import pandas as pd

from server.strategies.rl.features import build_rl_features, regime_breakdown
from server.strategies.ml.strategy import _atr
from server.strategies.rl.environment import TradingEnv
from server.strategies.rl.settings import RLSettings
from server.strategies.rl.training import train_policy


def run_rl_backtest(frame: pd.DataFrame, settings: RLSettings, *, initial_capital: float, leverage: float,
                    start=None, close_at_end=False, bar_seconds=300, min_tick=.01,
                    fee_bps=0., slippage=0., spread=0., funding_bps=0., progress=None) -> dict:
    clean = frame.dropna(subset=['open', 'high', 'low', 'close'])
    features = build_rl_features(clean)
    atr = _atr(clean, 14).to_numpy(float)
    first = int(clean.index.searchsorted(start)) if start is not None else settings.train_bars
    first = max(settings.lookback, first)
    if first >= len(clean):
        empty = clean.iloc[:0].assign(equity=float(initial_capital), long_signal=False, short_signal=False,
                                      stop=np.nan, target=np.nan, position=0, atr=np.nan, trailing_active=False, rl_action=0)
        return dict(bars=empty, trades=pd.DataFrame(), open_position=None, cash=float(initial_capital), halted=False,
                    report=dict(kind='rl', algorithm='PPO', folds=[], featureCount=features.shape[1], trainedBars=0,
                                accuracy=None, importance={}, labelBalance=dict(long=0., none=0., short=0.),
                                blockedByCost=0, medianTarget=None, medianRoundTripCost=None,
                                message='Waiting for a completed evaluation candle after the training history.'))
    execution = dict(capital=initial_capital, leverage=leverage, fee_bps=fee_bps, slippage=slippage,
                     spread=spread, funding_bps=funding_bps, min_tick=min_tick, bar_seconds=bar_seconds or 300)
    # Normalized observations are supplied by the current causal policy, not fitted on evaluation data.
    env = TradingEnv(clean, np.zeros(features.shape, np.float32), atr, settings, first_observation=first-1,
                     liquidate_at_end=close_at_end, **execution)
    env.reset(seed=settings.seed)
    folds, model, scaler = [], None, None
    policy_accepted = False
    next_training = first-1
    while not env.done:
        if env.t >= next_training:
            left, right = max(0, env.t+1-settings.train_bars), env.t+1
            if right-left >= 500:
                def checkpoint_progress(done: int, total: int) -> None:
                    if progress:
                        progress(min(94, int(90*(env.t-first+1+(done/total)*min(settings.retrain_every, len(clean)-env.t))/max(1, len(clean)-first))),
                                 f'PPO: training past candles, checkpoint {done} of {total}')
                model, scaler, metadata = train_policy(clean.iloc[left:right], features.iloc[left:right], atr[left:right],
                                                      settings, execution, progress=checkpoint_progress)
                policy_accepted = bool(metadata.get('accepted', False))
                folds.append(dict(start=int(clean.index[env.t+1].timestamp()),
                                  end=int(clean.index[min(len(clean)-1, env.t+settings.retrain_every)].timestamp()),
                                  trainRows=right-left, bars=min(settings.retrain_every, len(clean)-env.t-1), accuracy=None,
                                  training=metadata))
                env.features = scaler.transform(features.to_numpy(float))
            next_training += settings.retrain_every
        observation = env.observation()
        action = 0 if model is None or not policy_accepted else int(model.predict(observation, deterministic=True)[0])
        env.step(action)
        env.records[-1]['rl_accepted'] = policy_accepted
    result = env.result()
    rejected = sum(not fold['training'].get('accepted', False) for fold in folds)
    result['report'] = dict(kind='rl', algorithm='PPO', folds=folds, featureCount=features.shape[1],
                            regimes=regime_breakdown(clean, result['bars'], result['trades']),
                            rejectedPolicyBlocks=rejected,
                            trainedBars=sum(f['bars'] for f in folds), accuracy=None, importance={},
                            labelBalance=dict(long=0., none=0., short=0.), blockedByCost=0,
                            medianTarget=None, medianRoundTripCost=None,
                            message=('Insufficient past training history; the policy stayed flat.' if not folds else
                                     'No policy passed past selection and confirmation; the policy stayed flat.' if rejected == len(folds) else
                                     'Only policies passing past selection and confirmation can open positions. Each block retrains on earlier candles.'))
    return result

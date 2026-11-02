"""Causal PPO checkpoints, training-only normalization and content-addressed artifacts."""
from __future__ import annotations

from collections import OrderedDict
from copy import deepcopy
from dataclasses import asdict, dataclass
import hashlib
import json
from pathlib import Path
import threading

import numpy as np
import pandas as pd

from server.strategies.fine_tuning import _score
from server.strategies.rl.environment import TradingEnv
from server.strategies.rl.features import regime_breakdown
from server.strategies.rl.settings import RLSettings

MODEL_ROOT = Path(__file__).resolve().parents[3]/'data'/'rl_models'
TRAIN_LOCK = threading.RLock()
CACHE: OrderedDict = OrderedDict()
VERSION = 'ppo-target-position-v5-market-context-risk-ranking'


class CashPolicy:
    """Explicit no-trade fallback; never wrap an unaccepted PPO checkpoint."""

    def predict(self, observation: np.ndarray, deterministic: bool = True) -> tuple:
        action = np.zeros(len(observation), dtype=np.int64) if np.ndim(observation) == 2 else np.array(0)
        return action, None


@dataclass
class Normalizer:
    mean: np.ndarray
    std: np.ndarray

    @classmethod
    def fit(cls, values: np.ndarray) -> 'Normalizer':
        values = np.where(np.isfinite(values), values, np.nan)
        count = np.isfinite(values).sum(axis=0)
        mean = np.nansum(values, axis=0)/np.maximum(count, 1)
        variance = np.nansum((values-mean)**2, axis=0)/np.maximum(count, 1)
        std = np.sqrt(variance)
        return cls(mean, np.where(std > 1e-8, std, 1.))

    def transform(self, values: np.ndarray) -> np.ndarray:
        return np.clip(np.nan_to_num((values-self.mean)/self.std, nan=0., posinf=0., neginf=0.), -10., 10.).astype(np.float32)


def checkpoint_rejection(metrics: dict) -> str | None:
    if not all(np.isfinite(metrics[key]) for key in ('netPnl', 'winRate', 'maxDrawdownPct', 'trades')):
        return 'Invalid validation metrics'
    if metrics.get('halted', False):
        return 'Validation hit the drawdown risk limit'
    if metrics['netPnl'] <= 0:
        return 'Did not beat staying flat after costs'
    if metrics['trades'] < 10:
        return 'Fewer than 10 validation trades'
    return None


def checkpoint_rank(metrics: dict) -> tuple:
    accepted = checkpoint_rejection(metrics) is None
    profit = metrics['netPnl'] if accepted else min(0., metrics['netPnl'])
    # Return and drawdown are both percentage points, with a 1-point floor
    # so a tiny measured drawdown cannot dominate checkpoint selection.
    risk_return = metrics.get('returnPct', 0.)/max(1., abs(metrics['maxDrawdownPct'])) if accepted else 0.
    return (accepted, risk_return, profit, metrics['maxDrawdownPct'], metrics['winRate'] if accepted else 0.,
            0 if accepted else -metrics['trades'])


def evaluate(model, bars: pd.DataFrame, values: np.ndarray, atr: np.ndarray, settings: RLSettings,
             execution: dict, first: int) -> dict:
    env = TradingEnv(bars, values, atr, settings, first_observation=first, **execution)
    observation, _ = env.reset(seed=settings.seed)
    while not env.done:
        action, _ = model.predict(observation, deterministic=True)
        observation, _, _, _, _ = env.step(int(action))
    result = env.result()
    metrics = _score(result, execution['capital'])
    trades = result['trades']
    def total(column: str) -> float:
        return float(trades[column].sum()) if len(trades) else 0.
    metrics.update(fees=total('fees'), executionCost=total('execution_cost'), funding=total('funding'),
                   transactionCosts=total('fees')+total('execution_cost'), grossPnl=total('gross_pnl'),
                   positionChanges=env.position_changes, turnover=env.turnover_notional/execution['capital'], halted=env.halted)
    metrics['regimes'] = regime_breakdown(bars, result['bars'], trades)
    return metrics


def train_policy(bars: pd.DataFrame, features: pd.DataFrame, atr: np.ndarray, settings: RLSettings,
                 execution: dict, progress=None) -> tuple:
    from stable_baselines3 import PPO
    import torch

    if len(bars) < 500:
        raise ValueError('PPO needs at least 500 historical candles before evaluation')
    split = int(len(bars)*.8)
    if len(bars)-split < 2 or split <= settings.lookback:
        raise ValueError('Not enough candles for separate PPO training and validation')
    fingerprint = dict(version=VERSION, settings=asdict(settings), execution=execution,
                       columns=list(features.columns),
                       candles=hashlib.sha256(pd.util.hash_pandas_object(bars, index=True).values.tobytes()).hexdigest(),
                       features=hashlib.sha256(pd.util.hash_pandas_object(features, index=True).values.tobytes()).hexdigest())
    key = hashlib.sha256(json.dumps(fingerprint, sort_keys=True).encode()).hexdigest()
    with TRAIN_LOCK:
        if key in CACHE:
            CACHE.move_to_end(key)
            return CACHE[key]
        directory = MODEL_ROOT/key
        if (directory/'metadata.json').exists():
            metadata = json.loads((directory/'metadata.json').read_text(encoding='utf-8'))
            with np.load(directory/'normalizer.npz') as normal:
                scaler = Normalizer(normal['mean'], normal['std'])
            model = PPO.load(directory/'policy.zip', device='cpu') if metadata['accepted'] else CashPolicy()
            artifact = (model, scaler, metadata)
        else:
            scaler = Normalizer.fit(features.iloc[:split].to_numpy(float))
            values = scaler.transform(features.to_numpy(float))
            baseline = evaluate(CashPolicy(), bars, values, atr, settings, execution, split-1)
            env = TradingEnv(bars.iloc[:split], values[:split], atr[:split], settings,
                             random_start=True, episode_bars=512, **execution)
            # Small MLP updates are much faster with a bounded CPU thread count.
            previous_threads = torch.get_num_threads()
            try:
                torch.set_num_threads(2)
                model = PPO('MlpPolicy', env, learning_rate=settings.learning_rate, n_steps=256, batch_size=64,
                            n_epochs=5, gamma=.99, seed=settings.seed, device='cpu', verbose=0,
                            policy_kwargs=dict(net_arch=[32, 32]))
                checkpoints, best, best_state = [], baseline, None
                selected_steps = None
                best_attempt = None
                iterations = max(1, (settings.timesteps+2047)//2048)
                trained_steps = 0
                for number in range(iterations):
                    remaining = settings.timesteps-trained_steps
                    chunk = min(2048, max(256, remaining))
                    model.learn(total_timesteps=chunk, reset_num_timesteps=number == 0)
                    trained_steps = int(model.num_timesteps)
                    metrics = evaluate(model, bars, values, atr, settings, execution, split-1)
                    reason = checkpoint_rejection(metrics)
                    checkpoints.append(dict(steps=int(model.num_timesteps), metrics=metrics, accepted=reason is None, reason=reason))
                    if best_attempt is None or checkpoint_rank(metrics) > checkpoint_rank(best_attempt):
                        best_attempt = metrics
                    if reason is None and checkpoint_rank(metrics) > checkpoint_rank(best):
                        best, best_state = metrics, deepcopy(model.policy.state_dict())
                        selected_steps = int(model.num_timesteps)
                    if progress:
                        progress(number+1, iterations)
                if best_state is not None:
                    model.policy.load_state_dict(best_state)
            finally:
                torch.set_num_threads(previous_threads)
            metadata = dict(key=key, algorithm='PPO', trainStart=bars.index[0].isoformat(),
                            trainEnd=bars.index[split-1].isoformat(), validationStart=bars.index[split].isoformat(),
                            validationEnd=bars.index[-1].isoformat(), steps=trained_steps,
                            accepted=best_state is not None, selectedCheckpointSteps=selected_steps,
                            selectionReason='Passed past validation' if best_state is not None else 'No checkpoint passed validation; staying flat',
                            baseline=baseline, candidateValidation=best_attempt, validation=best, checkpoints=checkpoints)
            directory.mkdir(parents=True, exist_ok=True)
            if best_state is not None:
                model.save(directory/'policy.zip')
            else:
                model = CashPolicy()
            np.savez(directory/'normalizer.npz', mean=scaler.mean, std=scaler.std)
            # Metadata is the commit marker; interrupted writes are retrained.
            (directory/'metadata.json').write_text(json.dumps(metadata, allow_nan=False), encoding='utf-8')
            artifact = (model, scaler, metadata)
        CACHE[key] = artifact
        while len(CACHE) > 8:
            CACHE.popitem(last=False)
        return artifact

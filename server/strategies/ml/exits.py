"""Learned exits and market regimes, trained inside every walk-forward block.

``ExitModel`` learns how far price usually moves for and against each side
within the horizon (MFE / MAE, in ATR units) with quantile regression. A lower
MFE quantile gives a take-profit that is often reached; a higher MAE quantile
gives a stop outside normal noise. The trailing stop reuses the learned noise
level. ``RegimeModel`` clusters candles into market states with a Gaussian
mixture on trend, volatility, efficiency and ADX and names each cluster from
its average behaviour. Both see only the block's training window.
"""
from __future__ import annotations

import importlib.util
from dataclasses import dataclass

import numpy as np
import pandas as pd

TARGETS = ('long_mfe', 'long_mae', 'short_mfe', 'short_mae')
REGIME_FEATURES = ('ret_24', 'realized_vol_48', 'efficiency_24', 'adx_14', 'ema_slope_50')
REGIME_NAMES = ('Trend up', 'Trend down', 'Range', 'Volatile')


def _cuda() -> bool:
    try:
        import torch
        return torch.cuda.is_available()
    except (ImportError, RuntimeError):
        return False


class _QuantilePair:
    """Predicts the (target, stop) quantiles of one excursion."""

    def __init__(self, quantiles: tuple[float, float], seed: int):
        self.quantiles, self.seed, self.models = quantiles, seed, []

    def fit(self, x: np.ndarray, y: np.ndarray, weights: np.ndarray | None):
        # Small tabular data trains fastest on the CPU: GPU boosting pays a launch cost per tree that
        # outweighs the work at a few thousand rows (measured: ~9 s per backtest vs <1 s here).
        if importlib.util.find_spec('lightgbm'):
            from lightgbm import LGBMRegressor
            self.models = [LGBMRegressor(objective='quantile', alpha=q, n_estimators=150, learning_rate=.05,
                                         num_leaves=15, min_child_samples=60, max_bin=63, subsample=.8, subsample_freq=1,
                                         colsample_bytree=.8, random_state=self.seed, n_jobs=2, verbose=-1)
                           .fit(x, y, sample_weight=weights) for q in self.quantiles]
        elif importlib.util.find_spec('xgboost'):
            from xgboost import XGBRegressor
            model = XGBRegressor(objective='reg:quantileerror', quantile_alpha=np.asarray(self.quantiles),
                                 n_estimators=150, learning_rate=.06, max_depth=4, max_bin=64, min_child_weight=5,
                                 subsample=.8, colsample_bytree=.8, tree_method='hist', random_state=self.seed, n_jobs=2)
            self.models = [model.fit(x, y, sample_weight=weights)]
        else:
            from sklearn.ensemble import HistGradientBoostingRegressor
            self.models = [HistGradientBoostingRegressor(loss='quantile', quantile=q, max_iter=120, learning_rate=.06,
                                                         max_leaf_nodes=15, min_samples_leaf=60, random_state=self.seed)
                           .fit(x, y, sample_weight=weights) for q in self.quantiles]
        return self

    def predict(self, x: np.ndarray) -> np.ndarray:
        if len(self.models) == 1:
            output = np.asarray(self.models[0].predict(x))
            return output if output.ndim == 2 else np.column_stack([output, output])
        return np.column_stack([model.predict(x) for model in self.models])


@dataclass
class ExitModel:
    """Learned exits from two excursions: the rise ("up") and the fall ("down") after a candle.

    A long's take-profit and a short's stop both come from the rise; a long's stop and a short's
    take-profit both come from the fall. Each excursion is one model predicting the target and stop
    quantiles, so the four exits share two excursion targets.
    """
    up: _QuantilePair
    down: _QuantilePair
    floor: float
    ceiling: float

    @classmethod
    def fit(cls, features: pd.DataFrame, targets: pd.DataFrame, rows: slice, *, tp_quantile: float,
            sl_quantile: float, floor: float = .3, ceiling: float = 6., seed: int = 7, half_life: float = 0) -> 'ExitModel':
        x, y = features.iloc[rows], targets.iloc[rows]
        mask = y.notna().all(axis=1).to_numpy()
        age = np.arange(len(mask)-1, -1, -1, dtype=float)
        weights = np.power(.5, age/half_life)[mask] if half_life and half_life > 0 else None
        if mask.sum() < 200:
            raise ValueError('Too few labelled candles to learn exits')
        matrix = x.to_numpy()[mask]
        quantiles = (tp_quantile, sl_quantile)
        up = _QuantilePair(quantiles, seed).fit(matrix, y['long_mfe'].to_numpy()[mask], weights)
        down = _QuantilePair(quantiles, seed).fit(matrix, y['long_mae'].to_numpy()[mask], weights)
        return cls(up, down, floor, ceiling)

    def predict(self, features: pd.DataFrame, rows: slice) -> pd.DataFrame:
        x = features.iloc[rows].to_numpy()
        up, down = self.up.predict(x), self.down.predict(x)
        values = dict(long_tp=up[:, 0], short_sl=up[:, 1], long_sl=down[:, 1], short_tp=down[:, 0])
        return pd.DataFrame({key: np.clip(value, self.floor, self.ceiling) for key, value in values.items()},
                            index=features.index[rows])


@dataclass
class RegimeModel:
    mixture: object
    mean: np.ndarray
    std: np.ndarray
    names: dict[int, str]
    columns: list[str]

    @classmethod
    def fit(cls, features: pd.DataFrame, rows: slice, seed: int = 7) -> 'RegimeModel | None':
        columns = [column for column in REGIME_FEATURES if column in features.columns]
        if len(columns) < 3:
            return None
        from sklearn.mixture import GaussianMixture
        data = features.iloc[rows][columns].dropna().to_numpy(float)
        if len(data) < 200:
            return None
        mean, std = data.mean(axis=0), data.std(axis=0)
        std = np.where(std > 1e-9, std, 1.)
        mixture = GaussianMixture(4, covariance_type='full', random_state=seed, n_init=2).fit((data-mean)/std)
        return cls(mixture, mean, std, cls._name(mixture, mean, std, columns), columns)

    @staticmethod
    def _name(mixture, mean, std, columns) -> dict[int, str]:
        centres = pd.DataFrame(mixture.means_*std+mean, columns=columns)
        trend = centres['ret_24'] if 'ret_24' in centres else centres.iloc[:, 0]
        volatility = centres['realized_vol_48'] if 'realized_vol_48' in centres else centres.iloc[:, 1]
        free = list(range(len(centres)))
        names = {}
        # Greedy: most volatile cluster first, then the strongest up and down trends; the rest is range.
        for name, score in (('Volatile', volatility), ('Trend up', trend), ('Trend down', -trend)):
            choice = max(free, key=lambda index: score[index])
            names[int(choice)] = name
            free.remove(choice)
        names.update({int(index): 'Range' for index in free})
        return names

    def predict(self, features: pd.DataFrame, rows: slice) -> np.ndarray:
        block = features.iloc[rows][self.columns]
        output = np.full(len(block), -1)
        known = block.notna().all(axis=1).to_numpy()
        if known.any():
            labels = self.mixture.predict((block.to_numpy(float)[known]-self.mean)/self.std)
            output[known] = [REGIME_NAMES.index(self.names[int(label)]) for label in labels]
        return output

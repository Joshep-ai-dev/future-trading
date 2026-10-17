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


def _regressor(quantile: float, seed: int):
    if importlib.util.find_spec('lightgbm'):
        from lightgbm import LGBMRegressor
        return LGBMRegressor(objective='quantile', alpha=quantile, n_estimators=150, learning_rate=.05,
                             num_leaves=15, min_child_samples=60, max_bin=63, subsample=.8, subsample_freq=1,
                             colsample_bytree=.8, random_state=seed, n_jobs=4, verbose=-1)
    from sklearn.ensemble import HistGradientBoostingRegressor
    return HistGradientBoostingRegressor(loss='quantile', quantile=quantile, max_iter=120, learning_rate=.06,
                                         max_leaf_nodes=15, min_samples_leaf=60, random_state=seed)


@dataclass
class ExitModel:
    models: dict
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
        models = {}
        for target in TARGETS:
            quantile = tp_quantile if target.endswith('mfe') else sl_quantile
            model = _regressor(quantile, seed)
            model.fit(x.to_numpy()[mask], y[target].to_numpy()[mask], sample_weight=weights)
            models[target] = model
        return cls(models, floor, ceiling)

    def predict(self, features: pd.DataFrame, rows: slice) -> pd.DataFrame:
        x = features.iloc[rows].to_numpy()
        values = {target: np.clip(model.predict(x), self.floor, self.ceiling) for target, model in self.models.items()}
        return pd.DataFrame(values, index=features.index[rows])


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

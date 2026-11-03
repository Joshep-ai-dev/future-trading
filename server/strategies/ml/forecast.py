"""One multi-output tree model for future upper/lower excursions and trend.

Targets are in current ATR units, so price levels can change without changing
the meaning of the forecast. Each tree shares its splits across all outputs.
Tree vote fractions describe agreement, not calibrated win probabilities.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.ensemble import ExtraTreesRegressor
from sklearn.impute import SimpleImputer


@dataclass
class ForecastModel:
    estimator: ExtraTreesRegressor
    imputer: SimpleImputer
    names: list[str]
    trend_estimator: object = None

    @classmethod
    def fit(cls, features: pd.DataFrame, targets: pd.DataFrame, rows: slice) -> 'ForecastModel':
        x, y = features.iloc[rows], targets.iloc[rows]
        valid = np.isfinite(y.to_numpy()).all(axis=1)
        if valid.sum() < 300:
            raise ValueError('Too few complete future ranges to train the forecast')
        imputer = SimpleImputer(strategy='median', keep_empty_features=True)
        matrix = imputer.fit_transform(x.to_numpy()[valid])
        model = ExtraTreesRegressor(n_estimators=100, max_depth=10, min_samples_leaf=20,
                                    max_features=.8, random_state=7, n_jobs=2)
        model.fit(matrix, y.to_numpy()[valid])
        # Closing direction gets independent splits, rather than competing
        # against the two nonnegative range targets in a shared tree objective.
        trend = ExtraTreesRegressor(n_estimators=100, max_depth=10, min_samples_leaf=20,
                                    max_features=.8, random_state=7, n_jobs=2)
        trend.fit(matrix, y.to_numpy()[valid, 2])
        return cls(model, imputer, list(features.columns), trend)

    def forecast_rows(self, features: pd.DataFrame, rows: slice) -> np.ndarray:
        values = self.estimator.predict(self.imputer.transform(features.iloc[rows].to_numpy()))
        if self.trend_estimator is not None:
            values[:, 2] = self.trend_estimator.predict(self.imputer.transform(features.iloc[rows].to_numpy()))
        up, down = np.maximum(values[:, 0], 0.), np.maximum(values[:, 1], 0.)
        return np.column_stack([up, down, np.clip(values[:, 2], -down, up)])

    def predict_rows(self, features: pd.DataFrame, rows: slice) -> np.ndarray:
        matrix = self.imputer.transform(features.iloc[rows].to_numpy())
        trends = (np.array([tree.predict(matrix) for tree in self.trend_estimator.estimators_])
                  if self.trend_estimator is not None else np.array([tree.predict(matrix)[:, 2] for tree in self.estimator.estimators_]))
        return np.column_stack([(trends < 0).mean(axis=0), (trends == 0).mean(axis=0), (trends > 0).mean(axis=0)])

    def importance(self) -> dict[str, float]:
        return dict(zip(self.names, map(float, self.estimator.feature_importances_)))

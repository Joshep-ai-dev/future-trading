"""Registry of classifiers usable by the ML strategy.

Each entry builds a scikit-learn compatible estimator. ``train_model`` hides
library differences (label encoding, missing classes, NaN handling) and always
returns probabilities in the order (short, none, long). Add a model by
registering a ``ModelSpec``; optional libraries are detected at runtime.
"""
from __future__ import annotations

import importlib.util
from dataclasses import dataclass
from typing import Callable

import numpy as np

from server.strategies.ml.labels import CLASSES

ENCODED = {label: index for index, label in enumerate(CLASSES)}


def _installed(module: str) -> bool:
    return importlib.util.find_spec(module) is not None


def _imputed(estimator, scale: bool = False):
    from sklearn.impute import SimpleImputer
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    steps = [SimpleImputer(strategy='median')]
    if scale:
        steps.append(StandardScaler())
    return make_pipeline(*steps, estimator)


def _lightgbm(seed: int):
    from lightgbm import LGBMClassifier
    return LGBMClassifier(n_estimators=200, learning_rate=.05, num_leaves=15, min_child_samples=60, max_bin=63,
                          subsample=.8, subsample_freq=1, colsample_bytree=.8, reg_lambda=1.,
                          class_weight='balanced', random_state=seed, n_jobs=4, verbose=-1)


def _xgboost(seed: int):
    from xgboost import XGBClassifier
    return XGBClassifier(n_estimators=200, learning_rate=.06, max_depth=4, max_bin=64, min_child_weight=5,
                         subsample=.8, colsample_bytree=.8, reg_lambda=1., tree_method='hist',
                         objective='multi:softprob', eval_metric='mlogloss', random_state=seed, n_jobs=4)


def _hist_gbm(seed: int):
    from sklearn.ensemble import HistGradientBoostingClassifier
    return HistGradientBoostingClassifier(max_iter=150, learning_rate=.08, max_leaf_nodes=15, max_bins=63,
                                          min_samples_leaf=60, l2_regularization=1., class_weight='balanced',
                                          random_state=seed)


def _random_forest(seed: int):
    from sklearn.ensemble import RandomForestClassifier
    return _imputed(RandomForestClassifier(n_estimators=250, max_depth=10, min_samples_leaf=40,
                                           max_features='sqrt', class_weight='balanced_subsample',
                                           random_state=seed, n_jobs=-1))


def _extra_trees(seed: int):
    from sklearn.ensemble import ExtraTreesClassifier
    return _imputed(ExtraTreesClassifier(n_estimators=300, max_depth=12, min_samples_leaf=40,
                                         max_features='sqrt', class_weight='balanced', random_state=seed, n_jobs=-1))


def _logistic(seed: int):
    from sklearn.linear_model import LogisticRegression
    return _imputed(LogisticRegression(C=.3, max_iter=600, class_weight='balanced'), scale=True)


def _neural(seed: int):
    from sklearn.neural_network import MLPClassifier
    return _imputed(MLPClassifier(hidden_layer_sizes=(96, 48), alpha=1e-3, learning_rate_init=1e-3,
                                  batch_size=256, max_iter=60, early_stopping=True, n_iter_no_change=6,
                                  random_state=seed), scale=True)


@dataclass(frozen=True)
class ModelSpec:
    key: str
    label: str
    family: str
    description: str
    build: Callable[[int], object]
    requires: str | None = None
    balanced: bool = True

    def available(self) -> bool:
        return self.requires is None or _installed(self.requires)


MODELS: dict[str, ModelSpec] = {spec.key: spec for spec in (
    ModelSpec('lightgbm', 'LightGBM', 'Gradient boosting', 'Fast boosted trees; strongest default for tabular indicators.', _lightgbm, 'lightgbm'),
    ModelSpec('xgboost', 'XGBoost', 'Gradient boosting', 'Boosted trees with a different regularisation; good ensemble partner.', _xgboost, 'xgboost', balanced=False),
    ModelSpec('hist_gbm', 'Histogram GBM', 'Gradient boosting', 'scikit-learn boosted trees; no extra install.', _hist_gbm),
    ModelSpec('random_forest', 'Random forest', 'Bagged trees', 'Averaged deep trees; stable and hard to overfit.', _random_forest),
    ModelSpec('extra_trees', 'Extra trees', 'Bagged trees', 'More randomised forest; adds diversity to an ensemble.', _extra_trees),
    ModelSpec('logistic', 'Logistic regression', 'Linear', 'Simple linear baseline on scaled features.', _logistic),
    ModelSpec('neural_net', 'Neural network (MLP)', 'Deep learning', 'Two-layer neural network on scaled features with early stopping.', _neural),
)}


def available_models() -> list[dict]:
    return [dict(key=spec.key, label=spec.label, family=spec.family, description=spec.description,
                 available=spec.available(), requires=spec.requires) for spec in MODELS.values()]


def _sample_weights(y: np.ndarray) -> np.ndarray:
    counts = np.bincount(y, minlength=len(CLASSES)).astype(float)
    weights = np.where(counts > 0, len(y)/(len(CLASSES)*np.maximum(counts, 1)), 0.)
    return weights[y]


@dataclass
class TrainedModel:
    key: str
    estimator: object
    classes: np.ndarray
    feature_names: list[str]

    def predict(self, features: np.ndarray) -> np.ndarray:
        """Probabilities with columns (short, none, long), zero for classes unseen in training."""
        output = np.zeros((len(features), len(CLASSES)))
        if len(features):
            output[:, self.classes] = self.estimator.predict_proba(features)
        return output

    def importance(self) -> dict[str, float]:
        estimator = self.estimator[-1] if hasattr(self.estimator, 'steps') else self.estimator
        values = getattr(estimator, 'feature_importances_', None)
        if values is None:
            return {}
        values = np.asarray(values, float)
        total = values.sum() or 1.
        return {name: float(value/total) for name, value in zip(self.feature_names, values)}


def train_model(key: str, features: np.ndarray, labels: np.ndarray, feature_names: list[str], seed: int = 7) -> TrainedModel:
    spec = MODELS.get(key)
    if spec is None:
        raise ValueError(f'Unknown model: {key}')
    if not spec.available():
        raise ValueError(f'{spec.label} needs the "{spec.requires}" package. Install requirements.txt and restart.')
    encoded = np.vectorize(ENCODED.get)(labels.astype(int))
    present = np.unique(encoded)
    if len(present) < 2:
        raise ValueError('The training window contains only one outcome; widen it or change the exit targets')
    remap = {cls: index for index, cls in enumerate(present)}
    target = np.vectorize(remap.get)(encoded)
    estimator = spec.build(seed)
    fit_args = {}
    if not spec.balanced:
        fit_args['sample_weight'] = _sample_weights(target)
    estimator.fit(features, target, **fit_args)
    return TrainedModel(key, estimator, present, feature_names)

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
GPU_MIN_ROWS = 50_000  # Below this, tree models train faster on the CPU (measured on this project's data).
GPU_CAPABLE = {'xgboost', 'cnn_1d', 'lstm'}  # LightGBM (pip build) and scikit-learn models are CPU-only.


def use_gpu(device: str, rows: int) -> bool:
    """'gpu' forces CUDA where possible, 'cpu' never, 'auto' only when it is faster (large windows)."""
    if device == 'cpu' or not _cuda_available():
        return False
    return device == 'gpu' or rows >= GPU_MIN_ROWS


def _installed(module: str) -> bool:
    return importlib.util.find_spec(module) is not None


def _cuda_available() -> bool:
    """Share PyTorch's reliable CUDA/driver detection with GPU-capable models."""
    try:
        import torch
        return torch.cuda.is_available()
    except (ImportError, RuntimeError):
        return False


def compute_status() -> dict:
    """Describe the accelerator that ML models can use on this server."""
    try:
        import torch
        available = torch.cuda.is_available()
        return {
            'gpuAvailable': available,
            'device': torch.cuda.get_device_name(0) if available else None,
            'torchVersion': torch.__version__,
            'cudaVersion': torch.version.cuda,
        }
    except (ImportError, RuntimeError):
        return {'gpuAvailable': False, 'device': None, 'torchVersion': None, 'cudaVersion': None}


def _imputed(estimator, scale: bool = False):
    from sklearn.impute import SimpleImputer
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    steps = [SimpleImputer(strategy='median')]
    if scale:
        steps.append(StandardScaler())
    return make_pipeline(*steps, estimator)


# Model capacity presets: how large each model may grow. Tuned by the grid search.
CAPACITY = {
    'light': dict(trees=100, leaves=7, depth=3, forest_depth=6, leaf=120, hidden=(48,), C=.1, sequence_hidden=16),
    'standard': dict(trees=200, leaves=15, depth=4, forest_depth=10, leaf=60, hidden=(96, 48), C=.3, sequence_hidden=32),
    'rich': dict(trees=400, leaves=31, depth=6, forest_depth=14, leaf=30, hidden=(160, 80), C=1., sequence_hidden=64),
}


def _lightgbm(seed: int, c: dict):
    from lightgbm import LGBMClassifier
    return LGBMClassifier(n_estimators=c['trees'], learning_rate=.05, num_leaves=c['leaves'], min_child_samples=c['leaf'],
                          max_bin=63, subsample=.8, subsample_freq=1, colsample_bytree=.8, reg_lambda=1.,
                          class_weight='balanced', random_state=seed, n_jobs=2, verbose=-1)


def _xgboost(seed: int, c: dict):
    from xgboost import XGBClassifier
    return XGBClassifier(n_estimators=c['trees'], learning_rate=.06, max_depth=c['depth'], max_bin=64,
                         min_child_weight=max(1, c['leaf']//12), subsample=.8, colsample_bytree=.8, reg_lambda=1.,
                         tree_method='hist', device='cuda' if _cuda_available() else 'cpu',
                         objective='multi:softprob', eval_metric='mlogloss', random_state=seed, n_jobs=4)


def _hist_gbm(seed: int, c: dict):
    from sklearn.ensemble import HistGradientBoostingClassifier
    return HistGradientBoostingClassifier(max_iter=max(60, c['trees']*3//4), learning_rate=.08, max_leaf_nodes=c['leaves'],
                                          max_bins=63, min_samples_leaf=c['leaf'], l2_regularization=1.,
                                          class_weight='balanced', random_state=seed)


def _random_forest(seed: int, c: dict):
    from sklearn.ensemble import RandomForestClassifier
    return _imputed(RandomForestClassifier(n_estimators=c['trees'], max_depth=c['forest_depth'], min_samples_leaf=c['leaf']*2//3,
                                           max_features='sqrt', class_weight='balanced_subsample',
                                           random_state=seed, n_jobs=2))


def _extra_trees(seed: int, c: dict):
    from sklearn.ensemble import ExtraTreesClassifier
    return _imputed(ExtraTreesClassifier(n_estimators=c['trees']*3//2, max_depth=c['forest_depth']+2,
                                         min_samples_leaf=c['leaf']*2//3, max_features='sqrt',
                                         class_weight='balanced', random_state=seed, n_jobs=2))


def _logistic(seed: int, c: dict):
    from sklearn.linear_model import LogisticRegression
    return _imputed(LogisticRegression(C=c['C'], max_iter=600, class_weight='balanced'), scale=True)


def _neural(seed: int, c: dict):
    from sklearn.neural_network import MLPClassifier
    return _imputed(MLPClassifier(hidden_layer_sizes=c['hidden'], alpha=1e-3, learning_rate_init=1e-3,
                                  batch_size=256, max_iter=60, early_stopping=True, n_iter_no_change=6,
                                  random_state=seed), scale=True)


@dataclass(frozen=True)
class ModelSpec:
    key: str
    label: str
    family: str
    description: str
    build: Callable[[int, dict], object] | None
    requires: str | None = None
    balanced: bool = True
    sequence: str | None = None  # 'cnn' or 'lstm' for PyTorch window models; None for tabular models.

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
    ModelSpec('cnn_1d', '1D-CNN', 'Deep learning', 'Dilated convolutions over the last 32 candles of features; learns short patterns.', None, 'torch', sequence='cnn'),
    ModelSpec('lstm', 'LSTM', 'Deep learning', 'Recurrent network over the last 32 candles; slower, learns longer dependencies.', None, 'torch', sequence='lstm'),
)}


def available_models() -> list[dict]:
    cuda = _cuda_available()
    gpu_models = GPU_CAPABLE
    return [dict(key=spec.key, label=spec.label, family=spec.family, description=spec.description,
                 available=spec.available(), requires=spec.requires,
                 device='cuda' if cuda and spec.key in gpu_models else 'cpu') for spec in MODELS.values()]


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

    def predict_rows(self, features, rows: slice) -> np.ndarray:
        return self.predict(features.iloc[rows].to_numpy())

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


def recency_weights(count: int, half_life: float) -> np.ndarray | None:
    """Weight 1 for the newest row, halving every ``half_life`` rows back; None disables weighting."""
    if not half_life or half_life <= 0 or count == 0:
        return None
    age = np.arange(count-1, -1, -1, dtype=float)
    return np.power(.5, age/half_life)


def train_model(key: str, features: np.ndarray, labels: np.ndarray, feature_names: list[str], seed: int = 7,
                capacity: str = 'standard', recency: np.ndarray | None = None, device: str = 'auto') -> TrainedModel:
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
    estimator = spec.build(seed, CAPACITY[capacity])
    if spec.key == 'xgboost':
        estimator.set_params(device='cuda' if use_gpu(device, len(target)) else 'cpu')
    weights = None if spec.balanced else _sample_weights(target)
    if recency is not None and spec.key != 'neural_net':  # MLPClassifier cannot take sample weights.
        weights = recency if weights is None else weights*recency
    fit_args = {}
    if weights is not None:
        # Pipelines route the weights to their final estimator step.
        name = f'{estimator.steps[-1][0]}__sample_weight' if hasattr(estimator, 'steps') else 'sample_weight'
        fit_args[name] = weights
    estimator.fit(features, target, **fit_args)
    return TrainedModel(key, estimator, present, feature_names)


def fit_model(key: str, features, labels, rows: slice, seed: int = 7, capacity: str = 'standard', half_life: float = 0,
              device: str = 'auto'):
    """Train ``key`` on the labelled rows in ``rows`` of the full feature table.

    Sequence models may read lookback context before ``rows.start``; tabular
    models use only the rows themselves. The result has ``predict_rows``.
    """
    spec = MODELS.get(key)
    if spec is None:
        raise ValueError(f'Unknown model: {key}')
    if not spec.available():
        raise ValueError(f'{spec.label} needs the "{spec.requires}" package. Install requirements.txt and restart.')
    if spec.sequence:
        from server.strategies.ml.sequence import fit_sequence
        return fit_sequence(key, spec.sequence, features, labels, rows, seed=seed,
                            hidden=CAPACITY[capacity]['sequence_hidden'], half_life=half_life, device=device)
    window_x, window_y = features.iloc[rows], labels.iloc[rows]
    mask = window_y.notna().to_numpy()
    recency = recency_weights(len(mask), half_life)
    return train_model(key, window_x.to_numpy()[mask], window_y.to_numpy()[mask], list(features.columns), seed, capacity,
                       None if recency is None else recency[mask], device)

"""Trade-quality filter (meta-labeling) trained inside each walk-forward block.

The direction ensemble says *which side*; this model learns *when that call
is right*. Inside the block's training window a quick direction model is fit
on the first part and predicts the held-out last part. Wherever it would have
signalled, the realised outcome (did that side's barrier win?) becomes a
binary label. The quality model sees the indicator features plus the
direction probabilities and outputs P(trade wins). Everything uses only the
block's past window, so the filter adds no look-ahead.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from server.strategies.ml.models import MODELS, fit_model

INNER_SPLIT = .7
CANDIDATE_PROBABILITY = .4
MIN_EXAMPLES = 120


def _inputs(features: np.ndarray, probabilities: np.ndarray) -> np.ndarray:
    side = np.where(probabilities[:, 2] >= probabilities[:, 0], 1., -1.)
    chosen = np.maximum(probabilities[:, 0], probabilities[:, 2])
    edge = np.abs(probabilities[:, 2]-probabilities[:, 0])
    return np.column_stack([features, probabilities, side, chosen, edge])


def _classifier(seed: int, gpu: bool = False):
    if gpu:
        from xgboost import XGBClassifier
        return XGBClassifier(n_estimators=150, learning_rate=.05, max_depth=3, max_bin=64, min_child_weight=3,
                             subsample=.8, colsample_bytree=.7, reg_lambda=2., tree_method='hist', device='cuda',
                             random_state=seed, n_jobs=2)
    from lightgbm import LGBMClassifier
    return LGBMClassifier(n_estimators=150, learning_rate=.05, num_leaves=7, min_child_samples=30, max_bin=63,
                          subsample=.8, subsample_freq=1, colsample_bytree=.7, reg_lambda=2., class_weight='balanced',
                          random_state=seed, n_jobs=2, verbose=-1)


@dataclass
class MetaModel:
    model: object
    base_rate: float

    @classmethod
    def fit(cls, features: pd.DataFrame, labels: pd.Series, rows: slice, *, primary: str, capacity: str,
            half_life: float, seed: int = 7, device: str = 'auto') -> 'MetaModel | None':
        start, stop = rows.start or 0, rows.stop
        cut = start+int((stop-start)*INNER_SPLIT)
        if not MODELS['lightgbm'].available() or stop-cut < 200:
            return None
        try:
            inner = fit_model(primary, features, labels, slice(start, cut), capacity=capacity, half_life=half_life,
                              seed=seed, device=device)
        except ValueError:
            return None
        held_out = slice(cut, stop)
        probabilities = np.nan_to_num(inner.predict_rows(features, held_out), nan=1/3)
        truth = labels.iloc[held_out].to_numpy()
        side = np.where(probabilities[:, 2] >= probabilities[:, 0], 1, -1)
        candidate = (np.maximum(probabilities[:, 0], probabilities[:, 2]) >= CANDIDATE_PROBABILITY) & np.isfinite(truth)
        if candidate.sum() < MIN_EXAMPLES:
            return None
        won = (truth[candidate] == side[candidate]).astype(int)
        if won.min() == won.max():
            return None
        x = _inputs(features.iloc[held_out].to_numpy()[candidate], probabilities[candidate])
        from server.strategies.ml.models import use_gpu
        gpu = use_gpu(device, len(won)) and MODELS['xgboost'].available()
        weights = None
        if gpu:  # XGBoost has no class_weight; balance the classes with sample weights instead.
            share = won.mean()
            weights = np.where(won == 1, .5/share, .5/(1-share))
        model = _classifier(seed, gpu).fit(x, won, sample_weight=weights)
        return cls(model, float(won.mean()))

    def predict(self, features: pd.DataFrame, rows: slice, probabilities: np.ndarray) -> np.ndarray:
        """P(win) for each row's preferred side."""
        x = _inputs(features.iloc[rows].to_numpy(), np.nan_to_num(probabilities, nan=1/3))
        return self.model.predict_proba(x)[:, 1]

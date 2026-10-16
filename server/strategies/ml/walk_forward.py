"""Causal walk-forward training and prediction with fold-level caching.

The evaluated period is split into consecutive blocks of ``retrain_every``
bars. Each block is predicted by an ensemble trained only on the
``train_bars`` labelled bars that end ``horizon`` bars before the block, so a
training label never uses a candle the block can see. Trained folds are cached
by their exact training window, so re-running a backtest, extending the range
or advancing a paper session only trains the new folds.
"""
from __future__ import annotations

import hashlib
import json
import threading
from collections import OrderedDict
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from server.strategies.ml.models import TrainedModel, train_model

MIN_TRAIN_ROWS = 300


@dataclass
class Fold:
    test_start: int
    test_end: int
    train_rows: int
    models: list[TrainedModel]
    weights: list[float]


@dataclass
class WalkForwardResult:
    probabilities: pd.DataFrame
    folds: list[dict] = field(default_factory=list)
    importance: dict[str, float] = field(default_factory=dict)


class FoldCache:
    def __init__(self, size: int = 256):
        self.size, self.lock, self.items = size, threading.Lock(), OrderedDict()

    def get(self, key):
        with self.lock:
            if key in self.items:
                self.items.move_to_end(key)
                return self.items[key]
        return None

    def put(self, key, value):
        with self.lock:
            self.items[key] = value
            self.items.move_to_end(key)
            while len(self.items) > self.size:
                self.items.popitem(last=False)


fold_cache = FoldCache()


def config_key(**parts) -> str:
    return hashlib.sha1(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()[:16]


def _train_fold(features: pd.DataFrame, labels: pd.Series, train_slice: slice, models: dict[str, float], key: str) -> Fold | None:
    window_x, window_y = features.iloc[train_slice], labels.iloc[train_slice]
    mask = window_y.notna().to_numpy()
    if mask.sum() < MIN_TRAIN_ROWS:
        return None
    first, last = window_x.index[0], window_x.index[-1]
    cache_key = (key, int(first.timestamp()), int(last.timestamp()), int(mask.sum()))
    cached = fold_cache.get(cache_key)
    if cached is not None:
        return cached
    x, y = window_x.to_numpy()[mask], window_y.to_numpy()[mask]
    trained, weights = [], []
    for name, weight in models.items():
        if weight > 0:
            trained.append(train_model(name, x, y, list(features.columns)))
            weights.append(float(weight))
    fold = Fold(0, 0, int(mask.sum()), trained, weights)
    fold_cache.put(cache_key, fold)
    return fold


def walk_forward(features: pd.DataFrame, labels: pd.Series, *, start_index: int, train_bars: int,
                 retrain_every: int, horizon: int, models: dict[str, float], key: str) -> WalkForwardResult:
    """Out-of-sample probabilities (short, none, long) for every bar from ``start_index``."""
    if not any(weight > 0 for weight in models.values()):
        raise ValueError('Enable at least one model with a positive weight')
    n = len(features)
    probabilities = np.full((n, 3), np.nan)
    folds, importance = [], {}
    # Block boundaries are anchored at the evaluation start so they stay identical
    # when more candles arrive, which keeps cached folds valid for paper trading.
    for block_start in range(start_index, n, retrain_every):
        block_end = min(n, block_start+retrain_every)
        train_end = block_start-horizon
        train_start = max(0, train_end-train_bars)
        if train_end <= train_start:
            continue
        fold = _train_fold(features, labels, slice(train_start, train_end), models, key)
        if fold is None:
            continue
        block = features.iloc[block_start:block_end].to_numpy()
        total = sum(fold.weights)
        blended = sum(weight*model.predict(block) for model, weight in zip(fold.models, fold.weights))/total
        probabilities[block_start:block_end] = blended
        truth = labels.iloc[block_start:block_end].to_numpy()
        known = np.isfinite(truth)
        predicted = np.array([-1, 0, 1])[np.argmax(blended, axis=1)]
        folds.append(dict(start=int(features.index[block_start].timestamp()), end=int(features.index[block_end-1].timestamp()),
                          trainRows=fold.train_rows, bars=block_end-block_start,
                          accuracy=float((predicted[known] == truth[known]).mean()) if known.any() else None))
        for model in fold.models:
            for name, value in model.importance().items():
                importance[name] = importance.get(name, 0.)+value
    if importance:
        total = sum(importance.values()) or 1.
        importance = dict(sorted(((k, v/total) for k, v in importance.items()), key=lambda item: -item[1]))
    frame = pd.DataFrame(probabilities, index=features.index, columns=['p_short', 'p_none', 'p_long'])
    return WalkForwardResult(frame, folds, importance)

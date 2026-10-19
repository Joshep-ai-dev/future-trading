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
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from collections import OrderedDict
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from server.strategies.ml.exits import ExitModel, RegimeModel
from server.strategies.ml.meta import MetaModel
from server.strategies.ml.models import fit_model

MIN_TRAIN_ROWS = 300
WORKERS = max(1, min(8, (os.cpu_count() or 2)//3))  # blocks train in parallel; each model uses ~2 threads


@dataclass
class Fold:
    test_start: int
    test_end: int
    train_rows: int
    models: list
    weights: list[float]
    exits: object = None
    regimes: object = None
    meta: object = None


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


def _train_fold(features: pd.DataFrame, labels: pd.Series, train_slice: slice, models: dict[str, float], key: str,
                capacity: str = 'standard', exit_targets: pd.DataFrame | None = None, quantiles=(.4, .7),
                half_life: float = 0, meta: bool = False) -> Fold | None:
    window_x, window_y = features.iloc[train_slice], labels.iloc[train_slice]
    mask = window_y.notna().to_numpy()
    if mask.sum() < MIN_TRAIN_ROWS:
        return None
    first, last = window_x.index[0], window_x.index[-1]
    cache_key = (key, int(first.timestamp()), int(last.timestamp()), int(mask.sum()))
    cached = fold_cache.get(cache_key)
    if cached is not None:
        return cached
    trained, weights = [], []
    for name, weight in models.items():
        if weight > 0:
            trained.append(fit_model(name, features, labels, train_slice, capacity=capacity, half_life=half_life))
            weights.append(float(weight))
    fold = Fold(0, 0, int(mask.sum()), trained, weights)
    if exit_targets is not None:
        try:
            fold.exits = ExitModel.fit(features, exit_targets, train_slice, tp_quantile=quantiles[0], sl_quantile=quantiles[1],
                                       half_life=half_life)
        except ValueError:
            fold.exits = None  # Too little data in this window; the strategy falls back to fixed exits.
    fold.regimes = RegimeModel.fit(features, train_slice)  # Market regimes are always learned.
    if meta:
        primary = next(name for name, weight in models.items() if weight > 0)
        fold.meta = MetaModel.fit(features, labels, train_slice, primary=primary, capacity=capacity, half_life=half_life)
    fold_cache.put(cache_key, fold)
    return fold


def walk_forward(features: pd.DataFrame, labels: pd.Series, *, start_index: int, train_bars: int,
                 retrain_every: int, horizon: int, models: dict[str, float], key: str,
                 capacity: str = 'standard', progress=None, exit_targets: pd.DataFrame | None = None,
                 quantiles=(.4, .7), half_life: float = 0, meta: bool = False) -> WalkForwardResult:
    """Out-of-sample probabilities (short, none, long) for every bar from ``start_index``.

    With ``exit_targets`` every block also learns take-profit / stop distances
    (``long_tp``, ``long_sl``, ``short_tp``, ``short_sl`` in ATR) and a market
    regime per candle (``regime``: index into ``REGIME_NAMES``, -1 unknown).
    """
    if not any(weight > 0 for weight in models.values()):
        raise ValueError('Enable at least one model with a positive weight')
    n = len(features)
    probabilities = np.full((n, 3), np.nan)
    exits = np.full((n, 4), np.nan)
    regimes = np.full(n, -1)
    quality = np.full(n, np.nan)
    folds, importance = [], {}
    # Block boundaries are anchored at the evaluation start so they stay identical
    # when more candles arrive, which keeps cached folds valid for paper trading.
    blocks = list(range(start_index, n, retrain_every))
    windows = {}
    for block_start in blocks:
        train_end = block_start-horizon
        train_start = max(0, train_end-train_bars)
        if train_end > train_start:
            windows[block_start] = slice(train_start, train_end)
    # Blocks are independent: train them in parallel, then predict in order.
    done = [0]
    lock = threading.Lock()

    def train(block_start):
        fold = _train_fold(features, labels, windows[block_start], models, key, capacity, exit_targets, quantiles, half_life, meta)
        with lock:
            done[0] += 1
            if progress:
                progress(done[0], len(windows))
        return block_start, fold

    with ThreadPoolExecutor(max_workers=max(1, min(WORKERS, len(windows)))) as pool:
        trained = dict(pool.map(train, windows))
    for block_start in blocks:
        block_end = min(n, block_start+retrain_every)
        fold = trained.get(block_start)
        if fold is None:
            continue
        rows = slice(block_start, block_end)
        total = sum(fold.weights)
        blended = sum(weight*np.nan_to_num(model.predict_rows(features, rows), nan=1/3)
                      for model, weight in zip(fold.models, fold.weights))/total
        probabilities[block_start:block_end] = blended
        if fold.exits is not None:
            exits[block_start:block_end] = fold.exits.predict(features, rows).to_numpy()
        if fold.regimes is not None:
            regimes[block_start:block_end] = fold.regimes.predict(features, rows)
        if fold.meta is not None:
            quality[block_start:block_end] = fold.meta.predict(features, rows, blended)
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
    frame[['long_tp', 'long_sl', 'short_tp', 'short_sl']] = exits
    frame['regime'] = regimes
    frame['p_win'] = quality
    return WalkForwardResult(frame, folds, importance)

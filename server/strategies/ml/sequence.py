"""PyTorch sequence classifiers (1D-CNN, LSTM) over windows of recent candles.

A sample for bar ``t`` is the window of the ``lookback`` feature rows ending at
``t``; windows may reach before the training range into older, already known
candles, so they never contain anything after ``t``. Features are standardised
with training statistics only. Training is deterministic for a fixed seed,
class-weighted, and stops early on a time-ordered validation tail.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from server.strategies.ml.labels import CLASSES

ENCODED = {label: index for index, label in enumerate(CLASSES)}


def _torch():
    import torch
    torch.set_num_threads(4)
    return torch


def _device(torch):
    """Use the first CUDA GPU when the installed PyTorch build supports it."""
    return torch.device('cuda' if torch.cuda.is_available() else 'cpu')


def _windows(values: np.ndarray, ends: np.ndarray, lookback: int) -> np.ndarray:
    """Array (samples, lookback, features) of windows ending at each index in ``ends``."""
    offsets = np.arange(-lookback+1, 1)
    return values[ends[:, None]+offsets[None, :]]


def _network(kind: str, features: int, hidden: int):
    torch = _torch()
    nn = torch.nn

    class CNN(nn.Module):
        def __init__(self):
            super().__init__()
            self.body = nn.Sequential(
                nn.Conv1d(features, hidden, 3, padding=1), nn.GELU(),
                nn.Conv1d(hidden, hidden, 3, padding=2, dilation=2), nn.GELU(),
                nn.Conv1d(hidden, hidden, 3, padding=4, dilation=4), nn.GELU(), nn.Dropout(.2))
            self.head = nn.Linear(hidden*2, len(CLASSES))

        def forward(self, x):
            h = self.body(x.transpose(1, 2))
            return self.head(torch.cat([h.mean(dim=2), h[:, :, -1]], dim=1))

    class LSTM(nn.Module):
        def __init__(self):
            super().__init__()
            self.lstm = nn.LSTM(features, hidden, batch_first=True)
            self.head = nn.Sequential(nn.Dropout(.2), nn.Linear(hidden, len(CLASSES)))

        def forward(self, x):
            output, _ = self.lstm(x)
            return self.head(output[:, -1])

    return CNN() if kind == 'cnn' else LSTM()


@dataclass
class SequenceModel:
    key: str
    kind: str
    network: object
    mean: np.ndarray
    std: np.ndarray
    lookback: int
    classes: np.ndarray
    feature_names: list[str]

    def _prepared(self, features: pd.DataFrame) -> np.ndarray:
        values = (features.to_numpy(np.float32)-self.mean)/self.std
        return np.nan_to_num(values, nan=0., posinf=0., neginf=0.).astype(np.float32)

    def predict_rows(self, features: pd.DataFrame, rows: slice) -> np.ndarray:
        torch = _torch()
        device = next(self.network.parameters()).device
        start, stop = rows.start or 0, rows.stop if rows.stop is not None else len(features)
        output = np.full((stop-start, len(CLASSES)), np.nan)
        ends = np.arange(start, stop)
        usable = ends >= self.lookback-1
        if usable.any():
            values = self._prepared(features)
            self.network.eval()
            with torch.no_grad():
                probabilities = []
                for chunk in np.array_split(ends[usable], max(1, usable.sum()//2048)):
                    batch = torch.from_numpy(_windows(values, chunk, self.lookback)).to(device)
                    logits = self.network(batch)
                    probabilities.append(torch.softmax(logits, dim=1).cpu().numpy())
            full = np.zeros((usable.sum(), len(CLASSES)))
            full[:, self.classes] = np.concatenate(probabilities)[:, :len(self.classes)]
            output[usable] = full
        return output

    def importance(self) -> dict[str, float]:
        return {}


def fit_sequence(key: str, kind: str, features: pd.DataFrame, labels: pd.Series, rows: slice, *,
                 lookback: int = 32, hidden: int = 32, epochs: int = 12, batch: int = 256, seed: int = 7,
                 half_life: float = 0) -> SequenceModel:
    torch = _torch()
    device = _device(torch)
    torch.manual_seed(seed)
    if device.type == 'cuda':
        torch.cuda.manual_seed_all(seed)
    np.random.seed(seed)
    start, stop = rows.start or 0, rows.stop
    train = features.iloc[start:stop]
    mean = np.nanmean(train.to_numpy(np.float32), axis=0)
    std = np.nanstd(train.to_numpy(np.float32), axis=0)
    mean, std = np.nan_to_num(mean), np.where(np.isfinite(std) & (std > 1e-8), std, 1.).astype(np.float32)
    ends = np.arange(max(start, lookback-1), stop)
    target_raw = labels.to_numpy()[ends]
    keep = np.isfinite(target_raw)
    ends, target_raw = ends[keep], target_raw[keep].astype(int)
    # Newer samples count more: weight halves every ``half_life`` candles back from the window end.
    recency = np.power(.5, (stop-1-ends)/half_life).astype(np.float32) if half_life and half_life > 0 else np.ones(len(ends), np.float32)
    encoded = np.vectorize(ENCODED.get)(target_raw)
    present = np.unique(encoded)
    if len(present) < 2:
        raise ValueError('The training window contains only one outcome; widen it or change the exit targets')
    remap = {cls: index for index, cls in enumerate(present)}
    target = np.vectorize(remap.get)(encoded)
    model = SequenceModel(key, kind, None, mean.astype(np.float32), std, lookback, present, list(features.columns))
    values = model._prepared(features)
    x = torch.from_numpy(_windows(values, ends, lookback)).to(device)
    y = torch.from_numpy(target.astype(np.int64)).to(device)
    split = int(len(x)*.85)
    counts = np.bincount(target[:split], minlength=len(present)).astype(np.float32)
    weights = torch.from_numpy(np.where(counts > 0, len(target[:split])/(len(present)*np.maximum(counts, 1)), 0.).astype(np.float32)).to(device)
    network = _network(kind, features.shape[1], hidden)
    if len(present) != len(CLASSES):
        last = network.head if kind == 'cnn' else network.head[-1]
        replacement = torch.nn.Linear(last.in_features, len(present))
        if kind == 'cnn':
            network.head = replacement
        else:
            network.head[-1] = replacement
    network = network.to(device)
    optimiser = torch.optim.AdamW(network.parameters(), lr=2e-3, weight_decay=1e-3)
    loss_fn = torch.nn.CrossEntropyLoss(weight=weights, reduction='none')
    sample_weight = torch.from_numpy(recency).to(device)
    best, best_state, patience = float('inf'), None, 0
    generator = torch.Generator().manual_seed(seed)
    for _ in range(epochs):
        network.train()
        order = torch.randperm(split, generator=generator)
        for i in range(0, split, batch):
            index = order[i:i+batch].to(device)
            optimiser.zero_grad()
            loss = (loss_fn(network(x[index]), y[index])*sample_weight[index]).sum()/sample_weight[index].sum()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(network.parameters(), 1.)
            optimiser.step()
        network.eval()
        with torch.no_grad():
            validation = float(loss_fn(network(x[split:]), y[split:]).mean()) if split < len(x) else 0.
        if validation < best-1e-4:
            best, best_state, patience = validation, {k: v.clone() for k, v in network.state_dict().items()}, 0
        else:
            patience += 1
            if patience >= 3:
                break
    if best_state is not None:
        network.load_state_dict(best_state)
    model.network = network
    return model

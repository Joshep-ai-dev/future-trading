"""Causal recurrent forecasts with training-only scaling and purged validation."""
from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
import threading

import numpy as np
import pandas as pd

TRAIN_LOCK = threading.RLock()


@dataclass
class SequenceForecast:
    network: object
    mean: np.ndarray
    std: np.ndarray
    lookback: int
    direction_scale: float
    epochs_trained: int

    @classmethod
    def fit(cls, features: pd.DataFrame, targets: pd.DataFrame, rows: slice, *, kind: str,
            lookback: int = 100, epochs: int = 30, horizon: int = 24,
            device: str = 'auto') -> 'SequenceForecast':
        import torch

        if kind not in ('rnn', 'lstm', 'gru'):
            raise ValueError('Unknown recurrent forecast model')
        ends = np.arange(max(rows.start or 0, lookback-1), rows.stop)
        ends = ends[np.isfinite(targets.iloc[ends].to_numpy()).all(axis=1)]
        if len(ends) < 300:
            raise ValueError('Recurrent forecast needs at least 300 complete sequence targets')
        validation = ends[int(len(ends)*.85):]
        training = ends[ends+horizon < validation[0]]
        if len(training) < 100:
            raise ValueError('Not enough training sequences after purging the validation horizon')
        raw = features.to_numpy(np.float32)
        # Include context used by training sequences, excluding the validation tail.
        fit_values = raw[max(0, training[0]-lookback+1):training[-1]+1]
        finite = np.isfinite(fit_values)
        count = finite.sum(axis=0).clip(1)
        mean = np.where(finite, fit_values, 0.).sum(axis=0)/count
        variance = np.where(finite, (fit_values-mean)**2, 0.).sum(axis=0)/count
        std = np.sqrt(variance)
        std = np.where(std > 1e-8, std, 1.)
        values = np.clip(np.nan_to_num((raw-mean)/std, nan=0., posinf=0., neginf=0.), -10, 10).astype(np.float32)
        truth = targets.to_numpy(np.float32)
        target_device = torch.device('cuda' if device != 'cpu' and torch.cuda.is_available() else 'cpu')
        offsets = np.arange(-lookback+1, 1)

        class Network(torch.nn.Module):
            def __init__(self) -> None:
                super().__init__()
                cell = {'rnn': torch.nn.RNN, 'lstm': torch.nn.LSTM, 'gru': torch.nn.GRU}[kind]
                self.recurrent = cell(features.shape[1], 32, batch_first=True)
                self.head = torch.nn.Linear(32, 3)

            def forward(self, x):
                output, _ = self.recurrent(x)
                return self.head(output[:, -1])

        def batch(indices):
            return torch.from_numpy(values[indices[:, None]+offsets]).to(target_device)

        # Bounded batches avoid materialising the entire candle-window tensor.
        with TRAIN_LOCK, torch.random.fork_rng(devices=[] if target_device.type == 'cpu' else [torch.cuda.current_device()]):
            previous_threads = torch.get_num_threads()
            try:
                torch.set_num_threads(2)
                torch.manual_seed(7)
                network = Network().to(target_device)
                optimizer = torch.optim.AdamW(network.parameters(), lr=.001, weight_decay=.001)
                loss_fn = torch.nn.SmoothL1Loss()
                generator = np.random.default_rng(7)
                best, state, patience, trained = float('inf'), None, 0, 0
                for epoch in range(epochs):
                    network.train()
                    order = generator.permutation(training)
                    for start in range(0, len(order), 128):
                        indices = order[start:start+128]
                        optimizer.zero_grad()
                        loss = loss_fn(network(batch(indices)), torch.from_numpy(truth[indices]).to(target_device))
                        loss.backward()
                        torch.nn.utils.clip_grad_norm_(network.parameters(), 1.)
                        optimizer.step()
                    network.eval()
                    loss_sum = 0.
                    with torch.no_grad():
                        for start in range(0, len(validation), 128):
                            indices = validation[start:start+128]
                            loss_sum += float(loss_fn(network(batch(indices)), torch.from_numpy(truth[indices]).to(target_device)))*len(indices)
                    score = loss_sum/len(validation)
                    trained = epoch+1
                    if score < best-1e-5:
                        best, state, patience = score, deepcopy(network.state_dict()), 0
                    else:
                        patience += 1
                        if patience >= 5:
                            break
                if state is None:
                    raise ValueError('Recurrent forecast training produced no finite checkpoint')
                network.load_state_dict(state)
            finally:
                torch.set_num_threads(previous_threads)
        scale = max(.1, float(np.std(truth[training, 2])))
        return cls(network, mean.astype(np.float32), std.astype(np.float32), lookback, scale, trained)

    def forecast_rows(self, features: pd.DataFrame, rows: slice) -> np.ndarray:
        import torch

        values = np.clip(np.nan_to_num((features.to_numpy(np.float32)-self.mean)/self.std,
                                      nan=0., posinf=0., neginf=0.), -10, 10).astype(np.float32)
        start, stop = rows.start or 0, rows.stop if rows.stop is not None else len(features)
        output = np.full((stop-start, 3), np.nan)
        ends = np.arange(max(start, self.lookback-1), stop)
        offsets = np.arange(-self.lookback+1, 1)
        device = next(self.network.parameters()).device
        self.network.eval()
        with TRAIN_LOCK, torch.no_grad():
            previous_threads = torch.get_num_threads()
            try:
                torch.set_num_threads(2)
                for left in range(0, len(ends), 128):
                    indices = ends[left:left+128]
                    batch = torch.from_numpy(values[indices[:, None]+offsets]).to(device)
                    output[indices-start] = self.network(batch).cpu().numpy()
            finally:
                torch.set_num_threads(previous_threads)
        up, down = np.maximum(output[:, 0], 0.), np.maximum(output[:, 1], 0.)
        return np.column_stack([up, down, np.clip(output[:, 2], -down, up)])

    def predict_rows(self, features: pd.DataFrame, rows: slice) -> np.ndarray:
        trend = self.forecast_rows(features, rows)[:, 2]/self.direction_scale
        logits = np.column_stack([-trend, np.zeros(len(trend)), trend])
        logits -= np.max(logits, axis=1, keepdims=True)
        scores = np.exp(logits)
        return scores/scores.sum(axis=1, keepdims=True)

    def importance(self) -> dict[str, float]:
        return {}

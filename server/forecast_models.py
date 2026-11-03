"""Account-scoped, immutable local model artifacts for forecast research."""
import json
import re
import time
import uuid
from datetime import date
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from pydantic import Field

from server.forecast_forward import ForwardForecastRequest
from server.forecast_research import forecast_inputs
from server.market.data import TIMEFRAMES
from server.strategies.ml.forecast import ForecastModel
from server.strategies.ml.sequence_forecast import SequenceForecast, forecast_network

ROOT = Path(__file__).resolve().parent.parent/'data'/'forecast_models'
VERSION = 2


class TrainForecastRequest(ForwardForecastRequest):
    name: str = Field(default='Silver forecast', min_length=1, max_length=80)
    training_end: date


def train_saved_model(frame: pd.DataFrame, request: TrainForecastRequest, owner: int, root: Path = ROOT) -> dict:
    duration = pd.Timedelta(seconds=TIMEFRAMES[request.timeframe])
    cutoff = min(pd.Timestamp(request.training_end, tz='UTC')+pd.Timedelta(days=1), pd.Timestamp.now(tz='UTC'))
    bars = frame.loc[frame.index+duration <= cutoff].tail(request.train_bars+request.horizon+200).copy()
    bars = bars.loc[np.isfinite(bars[['open', 'high', 'low', 'close']].to_numpy()).all(axis=1)]
    if len(bars) < 500 or bars.index.has_duplicates or not bars.index.is_monotonic_increasing:
        raise ValueError('Need at least 500 chronological completed candles before the training cutoff')
    features, atr, targets, _ = forecast_inputs(bars, request, duration)
    end = len(bars)-request.horizon
    rows = slice(max(0, end-request.train_bars), end)
    count = int(np.isfinite(targets.iloc[rows].to_numpy()).all(axis=1).sum())
    if count < 300:
        raise ValueError('Need 300 complete training samples after gaps and horizon exclusions')
    # Reserve the last 20% for an independent chronological quality check.
    # Purge training targets whose future horizon reaches the holdout.
    valid_ends = np.arange(rows.start, rows.stop)
    valid_ends = valid_ends[np.isfinite(targets.iloc[valid_ends].to_numpy()).all(axis=1)]
    validation = valid_ends[int(len(valid_ends)*.8):]
    fit_rows = slice(rows.start, int(validation[0])-request.horizon)
    count = int(np.isfinite(targets.iloc[fit_rows].to_numpy()).all(axis=1).sum())
    if count < 300:
        raise ValueError('Need 300 training samples plus a separate validation tail; increase training history')
    if request.model == 'extra_trees':
        model = ForecastModel.fit(features, targets, fit_rows)
        payload = dict(model=model)
    else:
        model = SequenceForecast.fit(features, targets, fit_rows, kind=request.model, lookback=request.lookback,
                                     epochs=request.epochs, horizon=request.horizon)
        payload = dict(state={key: value.detach().cpu() for key, value in model.network.state_dict().items()},
                       mean=model.mean, std=model.std, lookback=model.lookback, direction_scale=model.direction_scale,
                       epochs_trained=model.epochs_trained, features=features.shape[1])
    validation_rows = slice(int(validation[0]), int(validation[-1])+1)
    predicted = model.forecast_rows(features, validation_rows)[validation-validation[0]]
    scale = atr.iloc[validation].to_numpy()
    error = (predicted[:, 2]-targets.iloc[validation, 2].to_numpy())*scale
    baseline = np.abs(targets.iloc[validation, 2].to_numpy()*scale)
    mae, baseline_mae = float(np.abs(error).mean()), float(baseline.mean())
    quality = dict(samples=len(validation), closeMae=mae, baselineMae=baseline_mae,
                   skillPct=100*(1-mae/baseline_mae) if baseline_mae > 0 else None,
                   beatsBaseline=mae < baseline_mae, meanError=float(error.mean()),
                   start=bars.index[validation[0]].isoformat(), end=bars.index[validation[-1]].isoformat())
    # Report the holdout diagnostic, then use all available historical training
    # samples for the final fixed-configuration fit. Never use external test data.
    quality['stage'] = 'Chronological holdout diagnostic before final full-history refit'
    if request.model == 'extra_trees':
        model = ForecastModel.fit(features, targets, rows)
        payload = dict(model=model)
    else:
        model = SequenceForecast.fit(features, targets, rows, kind=request.model, lookback=request.lookback,
                                     epochs=request.epochs, horizon=request.horizon)
        payload = dict(state={key: value.detach().cpu() for key, value in model.network.state_dict().items()},
                       mean=model.mean, std=model.std, lookback=model.lookback, direction_scale=model.direction_scale,
                       epochs_trained=model.epochs_trained, features=features.shape[1])
    count = int(np.isfinite(targets.iloc[rows].to_numpy()).all(axis=1).sum())
    model_id = uuid.uuid4().hex
    label = 'Extra Trees' if request.model == 'extra_trees' else request.model.upper()
    name = f'Silver {label}' if request.name in ('Silver GRU', 'Silver LSTM', 'Silver RNN', 'Silver Extra Trees') else request.name
    metadata = dict(id=model_id, version=VERSION, name=name, createdAt=int(time.time()),
                    config=request.model_dump(exclude={'model_id', 'name', 'training_end'}),
                    trainStart=bars.index[rows.start].isoformat(), trainedThrough=(bars.index[-1]+duration).isoformat(),
                    trainingRows=count, validation=quality, featureNames=list(features.columns), epochsTrained=getattr(model, 'epochs_trained', None))
    directory = root/str(int(owner))
    directory.mkdir(parents=True, exist_ok=True)
    joblib.dump(payload, directory/f'{model_id}.joblib')
    temporary = directory/f'{model_id}.json.tmp'
    temporary.write_text(json.dumps(metadata, allow_nan=False), encoding='utf-8')
    temporary.replace(directory/f'{model_id}.json')
    return metadata


def list_models(owner: int, root: Path = ROOT) -> list[dict]:
    directory = root/str(int(owner))
    values = [json.loads(path.read_text(encoding='utf-8')) for path in directory.glob('*.json')]
    return sorted(values, key=lambda item: item['createdAt'], reverse=True)


def load_model(owner: int, model_id: str, root: Path = ROOT) -> tuple:
    if not re.fullmatch(r'[0-9a-f]{32}', model_id):
        raise ValueError('Invalid model ID')
    directory = root/str(int(owner))
    path = directory/f'{model_id}.json'
    if not path.exists():
        raise ValueError('Saved model not found for this account')
    metadata = json.loads(path.read_text(encoding='utf-8'))
    if metadata['version'] not in (1, VERSION):
        raise ValueError('This model version is no longer supported; train a new model')
    # Only server-created artifacts are loaded; no user-supplied pickle uploads.
    payload = joblib.load(directory/f'{model_id}.joblib')
    if metadata['config']['model'] == 'extra_trees':
        return payload['model'], metadata
    network = forecast_network(metadata['config']['model'], payload['features'])
    network.load_state_dict(payload['state'])
    network.eval()
    return SequenceForecast(network, payload['mean'], payload['std'], payload['lookback'],
                            payload['direction_scale'], payload['epochs_trained']), metadata


def delete_model(owner: int, model_id: str, root: Path = ROOT) -> bool:
    if not re.fullmatch(r'[0-9a-f]{32}', model_id):
        raise ValueError('Invalid model ID')
    directory = root/str(int(owner))
    metadata = directory/f'{model_id}.json'
    if not metadata.exists():
        return False
    # Remove only the named account's model artifacts; prediction records remain.
    (directory/f'{model_id}.joblib').unlink(missing_ok=True)
    metadata.unlink()
    return True

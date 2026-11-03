"""Standalone historical forecast experiments; no orders or strategy execution."""
from datetime import date
from typing import Literal

import numpy as np
import pandas as pd
from pydantic import BaseModel, Field, model_validator

from server.market.data import TIMEFRAMES
from server.strategies.ml.features import build_features
from server.strategies.ml.forecast import ForecastModel
from server.strategies.ml.labels import excursions
from server.strategies.ml.sequence_forecast import SequenceForecast
from server.strategies.ml.strategy import _atr


class ForecastRequest(BaseModel):
    model: Literal['extra_trees', 'rnn', 'lstm', 'gru'] = 'gru'
    timeframe: Literal['1m', '3m', '5m', '10m', '15m', '30m', '1h', '4h', '1d'] = '15m'
    start_date: date
    end_date: date
    train_bars: int = Field(default=6000, ge=500, le=50000)
    lookback: int = Field(default=100, ge=1, le=500)
    horizon: int = Field(default=12, ge=1, le=100)
    epochs: int = Field(default=30, ge=1, le=100)

    @model_validator(mode='after')
    def ordered_dates(self):
        if self.end_date < self.start_date:
            raise ValueError('Test end must be on or after test start')
        return self


def run_forecast_test(frame: pd.DataFrame, request: ForecastRequest) -> dict:
    duration = pd.Timedelta(seconds=TIMEFRAMES[request.timeframe])
    start = pd.Timestamp(request.start_date, tz='UTC')
    end = pd.Timestamp(request.end_date, tz='UTC')+pd.Timedelta(days=1)
    # Keep only completed bars within the selected end date. Preserve gaps:
    # sequences must never silently treat separated candles as adjacent.
    source = frame.loc[frame.index+duration <= end]
    if source.index.has_duplicates or not source.index.is_monotonic_increasing:
        raise ValueError('Forecast data timestamps must be unique and chronological')
    first = int(source.index.searchsorted(start))
    left = max(0, first-request.train_bars-request.horizon-200)
    bars = source.iloc[left:].copy()
    complete = np.isfinite(bars[['open', 'high', 'low', 'close']].to_numpy()).all(axis=1)
    incomplete_rows = int((~complete).sum())
    bars = bars.loc[complete].copy()
    if bars.empty:
        raise ValueError('No complete candles in the selected history')
    # Segment on every timestamp discontinuity, including removed partial bars.
    segments = bars.index.to_series().diff().ne(duration).cumsum()
    first = int(bars.index.searchsorted(start))
    train_end = first-request.horizon
    train_start = max(0, train_end-request.train_bars)
    if train_end-train_start < 500:
        raise ValueError('Need at least 500 training candles before the test, plus horizon history')
    if len(bars)-first <= request.horizon:
        raise ValueError('Test period needs more candles than the forecast horizon')
    if len(bars)-first > 3000:
        raise ValueError('Limit each forecast test to 3000 candles; shorten dates or use a larger timeframe')
    features, atr, targets, eligible = forecast_inputs(bars, request, duration)
    rows = slice(train_start, train_end)
    training_rows = int(np.isfinite(targets.iloc[rows].to_numpy()).all(axis=1).sum())
    if training_rows < 300:
        raise ValueError(f'Only {training_rows} usable training samples after excluding gaps and incomplete horizons; need at least 300. Increase training candles or reduce observed candles/horizon.')
    stop = len(bars)-request.horizon
    usable_test = eligible.iloc[first:stop].to_numpy()
    if not usable_test.any():
        raise ValueError('No complete prediction windows in the test period. Reduce observed candles/horizon or extend the test dates.')
    if request.model == 'extra_trees':
        model = ForecastModel.fit(features, targets, rows)
    else:
        model = SequenceForecast.fit(features, targets, rows, kind=request.model,
                                     lookback=request.lookback, epochs=request.epochs, horizon=request.horizon)
    # Freeze the model for the entire holdout. Actual outcomes never retrain it.
    predictions = model.forecast_rows(features, slice(first, stop))
    points = []
    for offset, index in enumerate(range(first, stop)):
        if not usable_test[offset]:
            continue
        close, scale = float(bars.close.iloc[index]), float(atr.iloc[index])
        future = bars.iloc[index+1:index+1+request.horizon]
        up, down, trend = predictions[offset]
        points.append(dict(originTime=int((bars.index[index]+duration).timestamp()),
                           targetTime=int((bars.index[index+request.horizon]+duration).timestamp()),
                           originClose=close, predictedClose=float(close+trend*scale),
                           predictedHigh=float(close+up*scale), predictedLow=float(close-down*scale),
                           actualClose=float(future.close.iloc[-1]), actualHigh=float(future.high.max()),
                           actualLow=float(future.low.min())))
    predicted = np.array([p['predictedClose'] for p in points])
    actual = np.array([p['actualClose'] for p in points])
    baseline = np.array([p['originClose'] for p in points])
    metrics = dict(samples=len(points), closeMae=float(np.abs(predicted-actual).mean()),
                   closeRmse=float(np.sqrt(np.mean((predicted-actual)**2))),
                   baselineMae=float(np.abs(baseline-actual).mean()),
                   directionAccuracy=float((np.sign(predicted-baseline) == np.sign(actual-baseline)).mean()*100),
                   highMae=float(np.mean([abs(p['predictedHigh']-p['actualHigh']) for p in points])),
                   lowMae=float(np.mean([abs(p['predictedLow']-p['actualLow']) for p in points])))
    return dict(model=request.model, timeframe=request.timeframe, horizon=request.horizon,
                trainStart=bars.index[train_start].isoformat(),
                trainEnd=(bars.index[train_end-1]+duration).isoformat(),
                trainingRows=training_rows, epochsTrained=getattr(model, 'epochs_trained', None),
                metrics=metrics, predictions=points,
                dataQuality=dict(incompleteCandles=incomplete_rows, continuousSegments=int(segments.nunique()),
                                 skippedTestOrigins=int(len(bars)-first-len(points))),
                note='Incomplete candles and windows crossing gaps are excluded; indicators restart after each gap. Frozen historical holdout. Scaling and training use past data only. High/low forecasts are excursion estimates, not confidence bounds. Overlapping targets are not independent samples.')


def forecast_inputs(bars: pd.DataFrame, request, duration: pd.Timedelta) -> tuple:
    feature_parts, atr_parts, target_parts = [], [], []
    segments = bars.index.to_series().diff().ne(duration).cumsum()
    context = request.lookback if request.model != 'extra_trees' else 1
    eligible = pd.Series(False, index=bars.index)
    for _, segment in bars.groupby(segments):
        features_part = build_features(segment, ['returns', 'volatility', 'trend', 'volume', 'candles'])
        previous = segment.close.shift().replace(0., np.nan)
        for column in ('open', 'high', 'low', 'close'):
            features_part[f'candle_{column}_relative'] = segment[column]/previous-1
        if 'volume' in segment:
            features_part['candle_log_volume'] = np.log1p(segment.volume.clip(lower=0))
        segment_atr = _atr(segment, 14)
        ranges = excursions(segment, segment_atr, request.horizon)
        segment_targets = pd.DataFrame({'up': ranges.long_mfe, 'down': ranges.long_mae,
                                       'trend': (segment.close.shift(-request.horizon)-segment.close)/segment_atr})
        usable = ((np.arange(len(segment)) >= context-1)
                  & (np.arange(len(segment))+request.horizon < len(segment))
                  & np.isfinite(segment_atr.to_numpy()) & (segment_atr.to_numpy() > 0))
        eligible.loc[segment.index] = usable
        segment_targets.loc[~usable] = np.nan
        feature_parts.append(features_part)
        atr_parts.append(segment_atr)
        target_parts.append(segment_targets)
    features = pd.concat(feature_parts).reindex(bars.index)
    atr = pd.concat(atr_parts).reindex(bars.index)
    targets = pd.concat(target_parts).reindex(bars.index)
    return features, atr, targets, eligible

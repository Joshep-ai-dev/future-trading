"""Issue immutable forecasts before the outcome, then verify closed market candles."""
import time

import numpy as np
import pandas as pd
from pydantic import BaseModel, Field
from typing import Literal

from server.forecast_research import forecast_inputs
from server.market.data import TIMEFRAMES
from server.strategies.ml.forecast import ForecastModel
from server.strategies.ml.sequence_forecast import SequenceForecast


class ForwardForecastRequest(BaseModel):
    path_forecast: bool = False
    model_id: str | None = Field(default=None, pattern=r'^[0-9a-f]{32}$')
    model: Literal['extra_trees', 'rnn', 'lstm', 'gru'] = 'gru'
    timeframe: Literal['1m', '3m', '5m', '10m', '15m', '30m', '1h', '4h', '1d'] = '15m'
    train_bars: int = Field(default=6000, ge=500, le=50000)
    lookback: int = Field(default=100, ge=1, le=500)
    horizon: int = Field(default=12, ge=1, le=100)
    epochs: int = Field(default=30, ge=1, le=100)


def issue_forward_forecast(frame: pd.DataFrame, request: ForwardForecastRequest, clock=time.time, saved_model=None, metadata: dict | None = None) -> dict:
    seconds = TIMEFRAMES[request.timeframe]
    duration = pd.Timedelta(seconds=seconds)
    started = int(clock())
    now = pd.Timestamp(started, unit='s', tz='UTC')
    bars = frame.loc[frame.index+duration <= now].tail(request.train_bars+request.horizon+200).copy()
    bars = bars.loc[np.isfinite(bars[['open', 'high', 'low', 'close']].to_numpy()).all(axis=1)]
    if bars.empty or bars.index.has_duplicates or not bars.index.is_monotonic_increasing:
        raise ValueError('No chronological completed silver candles available')
    origin = int((bars.index[-1]+duration).timestamp())
    if started-origin > seconds+120:
        raise ValueError('Silver history is stale. Refresh market data and retry when completed candles are available.')
    features, atr, targets, _ = forecast_inputs(bars, request, duration)
    if metadata and list(features.columns) != metadata['featureNames']:
        raise ValueError('Market feature schema differs from the saved model; train a new model')
    context = request.lookback if request.model != 'extra_trees' else 1
    if len(bars) < context or not (bars.index[-1]-bars.index[-context] == duration*(context-1)) or not np.isfinite(atr.iloc[-1]):
        raise ValueError('Latest candles do not provide a complete observation window after a data gap')
    train_end = len(bars)-request.horizon
    rows = slice(max(0, train_end-request.train_bars), train_end)
    training_rows = int(np.isfinite(targets.iloc[rows].to_numpy()).all(axis=1).sum())
    if saved_model is None and training_rows < 300:
        raise ValueError('Need at least 300 complete past training targets; increase training history or reduce lookback')
    if saved_model is not None:
        model = saved_model
        training_rows = metadata['trainingRows']
    elif request.model == 'extra_trees':
        model = ForecastModel.fit(features, targets, rows)
    else:
        model = SequenceForecast.fit(features, targets, rows, kind=request.model, lookback=request.lookback,
                                     epochs=request.epochs, horizon=request.horizon)
    up, down, trend = model.forecast_rows(features, slice(len(bars)-1, len(bars)))[0]
    close, scale = float(bars.close.iloc[-1]), float(atr.iloc[-1])
    issued = int(clock())
    target = origin+seconds*request.horizon
    if issued >= target:
        raise ValueError('Training finished after the forecast target. Increase the horizon or reduce epochs and retry.')
    if not np.isfinite([up, down, trend, close, scale]).all():
        raise ValueError('Forecast produced invalid values')
    path = []
    if request.path_forecast and hasattr(model, 'forecast_path_rows'):
        moves = model.forecast_path_rows(features, slice(len(bars)-1, len(bars)))[0]
        if len(moves) != request.horizon or not np.isfinite(moves).all():
            raise ValueError('Saved model has no complete multi-step forecast; train a new model')
        path = [dict(time=origin+seconds*(step+1), close=float(close+move*scale)) for step, move in enumerate(moves)]
    return dict(**request.model_dump(), startedAt=started, issuedAt=issued, originTime=origin, targetTime=target,
                path=path, originClose=close, predictedClose=float(close+trend*scale), predictedHigh=float(close+up*scale),
                predictedLow=float(close-down*scale), modelId=metadata['id'] if metadata else None, trainingRows=training_rows,
                history=[dict(time=int((stamp+duration).timestamp()), close=float(row.close)) for stamp, row in bars.tail(100).iterrows()],
                epochsTrained=getattr(model, 'epochs_trained', None),
                note='Prediction saved before target close. Origin is the last completed candle, not a live tick. High/low cover the full horizon from origin; training may finish after the horizon starts.')


def observed_outcome(prediction: dict, frame: pd.DataFrame, now: int) -> dict | None:
    if now < prediction['targetTime']:
        return None
    seconds = TIMEFRAMES[prediction['timeframe']]
    index = pd.date_range(pd.Timestamp(prediction['originTime'], unit='s', tz='UTC'),
                          periods=prediction['horizon'], freq=pd.Timedelta(seconds=seconds))
    if frame.index.has_duplicates:
        return None
    future = frame.reindex(index)
    if not np.isfinite(future[['open', 'high', 'low', 'close']].to_numpy()).all():
        return None
    close, high, low = float(future.close.iloc[-1]), float(future.high.max()), float(future.low.min())
    return dict(verifiedAt=now, close=close, high=high, low=low,
                closeAbsoluteError=abs(prediction['predictedClose']-close),
                baselineAbsoluteError=abs(prediction['originClose']-close),
                directionCorrect=bool(np.sign(prediction['predictedClose']-prediction['originClose']) == np.sign(close-prediction['originClose'])))

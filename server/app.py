"""Local CSV price API."""
from typing import Literal
import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.gzip import GZipMiddleware
from pydantic import BaseModel, ConfigDict, Field
from .data import load_bars
from .strategy import BacktestRequest, run_backtest
from .mtf import active_stages, run_mtf_backtest

app = FastAPI(title='Silver Price Research')
app.add_middleware(GZipMiddleware, minimum_size=1000)

class Parameters(BaseModel):
    model_config = ConfigDict(extra='forbid')
    timeframe: Literal['1m', '3m', '5m', '10m', '15m', '30m', '1h', '4h', '1d'] = '1m'

@app.get('/api/health')
def health():
    return {'application': 'silver-price', 'version': 3}

@app.post('/api/analyze')
def run(parameters: Parameters):
    try:
        frame, quality = load_bars(parameters.timeframe)
        complete = frame.dropna(subset=['open', 'high', 'low', 'close'])
        if complete.empty:
            raise ValueError('No complete bars available for this timeframe.')
        page = candle_page(complete)
        return dict(params=parameters.model_dump(), quality=quality, candles=page['candles'],
                    history=dict(hasMore=page['hasMore'], nextBefore=page['nextBefore']),
                    asOf=int(complete.index[-1].timestamp()),
                    dataRange=dict(startDate=frame.index[0].strftime('%Y-%m-%d'),
                                   endDate=frame.index[-1].strftime('%Y-%m-%d')))
    except (ValueError, OSError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post('/api/backtest')
def backtest(parameters: BacktestRequest):
    try:
        if parameters.strategy == 'mtf':
            frames = {timeframe: load_bars(timeframe)[0] for timeframe in {tf for _, tf in active_stages(parameters)}}
            return run_mtf_backtest(frames, parameters)
        five, _ = load_bars('5m')
        fifteen, _ = load_bars('15m')
        return run_backtest(five, fifteen, parameters)
    except (ValueError, OSError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


class CandleRequest(Parameters):
    before: int | None = Field(default=None, ge=0, le=4102444800)
    limit: int = Field(default=5000, ge=1, le=5000)


def candle_page(frame, before=None, limit=5000):
    complete = frame.dropna(subset=['open', 'high', 'low', 'close'])
    if before is not None:
        complete = complete.loc[complete.index < pd.Timestamp(before, unit='s', tz='UTC')]
    selected = complete.tail(limit)
    candles = [dict(time=int(t.timestamp()), open=float(row.open), high=float(row.high),
                    low=float(row.low), close=float(row.close)) for t, row in selected.iterrows()]
    return dict(candles=candles, hasMore=len(complete) > len(selected),
                nextBefore=candles[0]['time'] if candles else None)


@app.post('/api/candles')
def history(parameters: CandleRequest):
    try:
        frame, _ = load_bars(parameters.timeframe)
        return candle_page(frame, parameters.before, parameters.limit)
    except (ValueError, OSError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

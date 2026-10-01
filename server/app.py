"""Local CSV price API."""
from typing import Literal
from fastapi import FastAPI, HTTPException
from fastapi.middleware.gzip import GZipMiddleware
from pydantic import BaseModel, ConfigDict
from .data import load_bars
from .strategy import BacktestRequest, run_backtest

app = FastAPI(title='Silver Price Research')
app.add_middleware(GZipMiddleware, minimum_size=1000)

class Parameters(BaseModel):
    model_config = ConfigDict(extra='forbid')
    timeframe: Literal['1m', '5m', '10m', '15m', '1h', '4h', '1d'] = '1m'

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
        candles = [dict(time=int(t.timestamp()), open=float(row.open),
                        high=float(row.high), low=float(row.low), close=float(row.close))
                   for t, row in complete.tail(5000).iterrows()]
        return dict(params=parameters.model_dump(), quality=quality, candles=candles,
                    asOf=int(complete.index[-1].timestamp()),
                    dataRange=dict(startDate=frame.index[0].strftime('%Y-%m-%d'),
                                   endDate=frame.index[-1].strftime('%Y-%m-%d')))
    except (ValueError, OSError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post('/api/backtest')
def backtest(parameters: BacktestRequest):
    try:
        five, _ = load_bars('5m')
        fifteen, _ = load_bars('15m')
        return run_backtest(five, fifteen, parameters)
    except (ValueError, OSError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

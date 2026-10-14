"""Local CSV price API."""
from typing import Literal
from contextlib import asynccontextmanager
import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.gzip import GZipMiddleware
from pydantic import BaseModel, ConfigDict, Field, model_validator
from .data import load_bars
from .strategy import BacktestRequest
from .bb_reversal_adapter import run_bb_reversal_backtest
from .market_refresh import refresh_service
from .paper_trading import paper_service

@asynccontextmanager
async def lifespan(app):
    refresh_service.start()
    paper_service.start()
    try:
        yield
    finally:
        paper_service.shutdown()
        refresh_service.shutdown()


app = FastAPI(title='Silver Price Research', lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=1000)

class Parameters(BaseModel):
    model_config = ConfigDict(extra='forbid')
    timeframe: Literal['1m', '3m', '5m', '10m', '15m', '30m', '1h', '4h', '1d'] = '1m'

@app.get('/api/health')
def health():
    return {'application': 'silver-price', 'version': 3}


@app.get('/api/market-status')
def market_status():
    return refresh_service.status()


@app.post('/api/market-refresh')
def market_refresh():
    return refresh_service.refresh()


@app.get('/api/paper')
def paper_status():
    return paper_service.status()


class BBBacktestRequest(BacktestRequest):
    strategy: Literal['bb_outer_reversal'] = 'bb_outer_reversal'


class PaperStartRequest(BBBacktestRequest):
    """Reuse strategy validation while excluding historical date restrictions."""
    paper_mode: Literal['live','replay'] = 'live'
    replay_start: str | None = None
    replay_end: str | None = None
    replay_speed: float = Field(default=300,ge=1,le=10000)

    @model_validator(mode='after')
    def replay_dates(self):
        if self.paper_mode == 'replay':
            from datetime import date
            try:
                start, end = date.fromisoformat(self.replay_start or ''), date.fromisoformat(self.replay_end or '')
            except ValueError as error:
                raise ValueError('Choose valid replay start and end dates') from error
            if end < start:
                raise ValueError('Replay end date must be on or after the start date')
        return self
    @model_validator(mode='before')
    @classmethod
    def ignore_historical_dates(cls, value):
        if isinstance(value, dict):
            return {**value, 'start_date':'2000-01-01',
                    'validation_date':'2000-01-02', 'end_date':'2000-01-02'}
        return value


@app.post('/api/paper/start')
def paper_start(parameters: PaperStartRequest):
    try:
        return paper_service.begin(parameters)
    except (ValueError, OSError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


class ReplaySpeed(BaseModel):
    speed: float = Field(ge=1,le=10000)


@app.post('/api/paper/speed')
def paper_speed(parameters: ReplaySpeed):
    try:
        return paper_service.set_speed(parameters.speed)
    except (ValueError, OSError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post('/api/paper/{action}')
def paper_action(action: Literal['pause', 'resume']):
    try:
        return paper_service.set_running(action == 'resume')
    except (ValueError, OSError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

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


@app.get('/api/data-range')
def data_range():
    try:
        frame, _ = load_bars('1m')
        complete = frame.dropna(subset=['open','high','low','close'])
        if complete.empty:
            raise ValueError('No complete market candles available')
        return dict(startDate=complete.index[0].strftime('%Y-%m-%d'),
                    endDate=complete.index[-1].strftime('%Y-%m-%d'))
    except (ValueError, OSError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post('/api/backtest')
def backtest(parameters: BBBacktestRequest):
    try:
        if parameters.strategy != 'bb_outer_reversal':
            raise ValueError('Only BB Outer Band Reversal + Trailing SL is supported')
        frame, _ = load_bars(parameters.entry_timeframe)
        return run_bb_reversal_backtest(frame, parameters)
    except (ValueError, OSError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


class CandleRequest(Parameters):
    before: int | None = Field(default=None, ge=0, le=4102444800)
    limit: int = Field(default=5000, ge=1, le=5000)


def candle_page(frame, before=None, limit=5000):
    complete = frame.dropna(subset=['open', 'high', 'low', 'close'])
    complete = complete.loc[complete.index.dayofweek < 5]
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

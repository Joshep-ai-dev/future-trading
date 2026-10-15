"""Local CSV price API."""
from typing import Literal
from contextlib import asynccontextmanager
from queue import Queue
from threading import Thread
import json
import logging
import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from .data import load_bars
from .strategy import BacktestRequest
from .bb_reversal_adapter import run_bb_reversal_backtest
from .market_refresh import refresh_service
from .paper_trading import paper_service
from .live_exchange import live_exchange, live_bot
from .profile_store import profile_store
from .fine_tuning import fine_tune

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
logger = logging.getLogger(__name__)

class Parameters(BaseModel):
    model_config = ConfigDict(extra='forbid')
    timeframe: Literal['1m', '3m', '5m', '10m', '15m', '30m', '1h', '4h', '1d'] = '1m'


class ChartViewRequest(Parameters):
    session_id: int
    clock: float = Field(ge=0,le=4102444800)


class BBBacktestRequest(BacktestRequest):
    strategy: Literal['bb_outer_reversal'] = 'bb_outer_reversal'


class ProfileSaveRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(min_length=1, max_length=48)
    settings: BBBacktestRequest

    @field_validator('name')
    @classmethod
    def clean_name(cls, value):
        value = value.strip()
        if not value:
            raise ValueError('Setup name cannot be blank')
        return value


class FineTuneRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    settings: BBBacktestRequest


class LiveBotStartRequest(BBBacktestRequest):
    venue: Literal['okx','htx','mexc','binance']
    confirmation: Literal['START LIVE STRATEGY']

    @model_validator(mode='after')
    def supported_exits(self):
        if self.bb_reversal.get('reward_risk', 0) > 0:
            raise ValueError('Fixed reward/risk target mode currently supports backtests and paper sessions only')
        return self



@app.post('/api/chart-view')
def session_chart(parameters: ChartViewRequest):
    from .chart_view import chart_view
    with paper_service.lock:
        state = paper_service.state
        if not state or state['startedAt'] != parameters.session_id:
            raise HTTPException(status_code=409, detail='The paper session has changed. Reload its chart.')
        replay = state.get('mode') == 'replay'
        clock = min(parameters.clock, state.get('virtualTime',0) if replay else paper_service.now())
        snapshots = list(state.get('minuteCandles',[]))
        settings = dict(state['settings']['bb_reversal'])
    try:
        frame, _ = load_bars('1m')
        return chart_view(frame,snapshots,parameters.timeframe,clock,settings,replay)
    except (ValueError,OSError) as error:
        raise HTTPException(status_code=400,detail=str(error)) from error

@app.get('/api/health')
def health():
    return {'application': 'silver-price', 'version': 3}


@app.get('/api/profiles')
def list_profiles():
    return profile_store.list()


@app.post('/api/profiles')
def save_profile(parameters: ProfileSaveRequest):
    return profile_store.save(parameters.name, parameters.settings.model_dump(mode='json'))


@app.delete('/api/profiles')
def delete_profile(name: str = Query(min_length=1, max_length=48)):
    if not profile_store.delete(name.strip()):
        raise HTTPException(status_code=404, detail='Saved setup not found')
    return {'deleted': name.strip()}


@app.get('/api/market-status')
def market_status():
    return refresh_service.status()


@app.post('/api/market-refresh')
def market_refresh():
    return refresh_service.refresh()


@app.get('/api/paper')
def paper_status():
    return paper_service.status()


class ExchangeConnectRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    venue: Literal['okx','htx','mexc','binance']
    api_key: str = Field(min_length=1,max_length=512)
    secret: str = Field(min_length=1,max_length=512)
    passphrase: str | None = Field(default=None,max_length=512)


class ExchangeOrderRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    venue: Literal['okx','htx','mexc','binance']
    direction: Literal['long','short']
    quantity: float = Field(gt=0,le=1e9)
    stop_price: float = Field(gt=0,le=1e9)
    leverage: int = Field(ge=1,le=100)
    confirmation: Literal['PLACE LIVE ORDER']


class ExchangeDisconnectRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    venue: Literal['okx','htx','mexc','binance']


class ExchangeCloseRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    venue: Literal['okx','htx','mexc','binance']
    confirmation: Literal['CLOSE LIVE POSITION']


@app.get('/api/exchange/status')
def exchange_status():
    return {'venues':live_exchange.status(),'bot':live_bot.status()}


@app.post('/api/exchange/connect')
def exchange_connect(parameters: ExchangeConnectRequest):
    try:
        return live_exchange.connect(parameters.venue,parameters.api_key,parameters.secret,parameters.passphrase)
    except ValueError as error:
        raise HTTPException(status_code=400,detail=str(error)) from error
    except Exception as error:
        # Exchange/library errors may echo request details. Never return credentials to the browser.
        raise HTTPException(status_code=502,detail=f'{parameters.venue.upper()} connection failed. Check API permissions, XAG contract access, account mode, and network availability.') from error


@app.post('/api/exchange/disconnect')
def exchange_disconnect(parameters: ExchangeDisconnectRequest):
    live_exchange.disconnect(parameters.venue)
    return {'venue':parameters.venue,'connected':False}


@app.post('/api/exchange/order')
def exchange_order(parameters: ExchangeOrderRequest):
    try:
        exchange,market=live_exchange._get(parameters.venue)
        exchange.set_margin_mode('isolated',market['symbol'])
        exchange.set_leverage(parameters.leverage,market['symbol'])
        return live_exchange.open_with_stop(parameters.venue,parameters.direction,parameters.quantity,parameters.stop_price)
    except ValueError as error:
        raise HTTPException(status_code=400,detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=502,detail='Live order failed. Check the exchange order and position status before retrying.') from error


@app.post('/api/exchange/close')
def exchange_close(parameters: ExchangeCloseRequest):
    try:
        return live_exchange.close_position(parameters.venue)
    except ValueError as error:
        raise HTTPException(status_code=400,detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=502,detail='Close request failed. Check the live position and open reduce-only orders at the exchange.') from error


@app.post('/api/exchange/auto/start')
def exchange_auto_start(parameters: LiveBotStartRequest):
    try:
        return live_bot.start(parameters.venue,parameters)
    except ValueError as error:
        raise HTTPException(status_code=400,detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=502,detail='Could not start the live strategy. Verify exchange account state and protective-order support.') from error


@app.post('/api/exchange/auto/stop')
def exchange_auto_stop():
    return live_bot.stop()


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


@app.post('/api/backtest/fine-tune')
def fine_tune_backtest(parameters: FineTuneRequest):
    updates = Queue()

    def work():
        try:
            frame, _ = load_bars(parameters.settings.entry_timeframe)
            result = fine_tune(frame, parameters.settings,
                               progress=lambda percent, message: updates.put(
                                   {'type': 'progress', 'percent': percent, 'message': message}))
            updates.put({'type': 'result', 'result': result})
        except (ValueError, OSError) as error:
            updates.put({'type': 'error', 'detail': str(error)})
        except Exception as error:
            logger.exception('Fine tuning failed')
            updates.put({'type': 'error', 'detail': str(error) or 'Fine tuning failed. Check the backend log.'})
        finally:
            updates.put(None)

    Thread(target=work, daemon=True).start()

    def events():
        while True:
            update = updates.get()
            if update is None:
                break
            try:
                encoded = json.dumps(update, allow_nan=False,
                                     default=lambda value: value.item() if hasattr(value, 'item') else str(value))
            except (TypeError, ValueError) as error:
                encoded = json.dumps({'type': 'error', 'detail': f'Could not encode tuning result: {error}'})
            yield encoded + '\n'

    return StreamingResponse(events(), media_type='application/x-ndjson',
                             headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


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

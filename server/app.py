"""Local CSV price API."""
from datetime import date
from typing import Literal
from contextlib import asynccontextmanager
from queue import Queue
import threading
from threading import Thread
import json
import logging
import os
import pandas as pd
from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from server.market.data import load_bars
from server.strategies.strategy import BacktestRequest
from server.strategies.bb_reversal_adapter import run_bb_reversal_backtest
from server.strategies.registry import get_strategy
from server.market.market_refresh import refresh_service
from server.market.history_backfill import history_backfill
from server.storage.user_data_store import user_data_store
from server.exchanges.live_exchange import OrderStepError, safe_exchange_error
from server.core.workspaces import WorkspaceRegistry
from server.storage.credential_store import credential_store
from server.core.serialization import optional_volume
from server.strategies.fine_tuning import fine_tune
from server.strategies.ml.tuning import ml_fine_tune
from server.storage.auth_store import SESSION_DAYS, auth_store

workspaces = WorkspaceRegistry(user_data_store)


def workspace(request: Request):
    """The signed-in user's isolated paper, exchange and live-bot services."""
    return workspaces.get(int(request.state.user['id']))

@asynccontextmanager
async def lifespan(app):
    auth_store.initialize()
    if auth_store.available():
        try:
            user_data_store.initialize()
            workspaces.restore_running()
        except Exception:
            logging.getLogger(__name__).exception('User data storage is unavailable')
    refresh_service.start()
    try:
        yield
    finally:
        await workspaces.shutdown()
        history_backfill.shutdown()
        refresh_service.shutdown()


app = FastAPI(title='Silver Price Research', lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=1000)
logger = logging.getLogger(__name__)
AUTH_COOKIE = 'silver_session'
TRADER_PATHS = ('/api/exchange/connect', '/api/exchange/disconnect', '/api/exchange/reconnect',
                '/api/exchange/forget', '/api/exchange/order', '/api/exchange/close',
                '/api/exchange/auto/', '/api/paper/start', '/api/paper/speed', '/api/paper/pause',
                '/api/paper/resume', '/api/profiles', '/api/market-refresh', '/api/market-backfill')


@app.middleware('http')
async def authenticated_api(request: Request, call_next):
    path = request.url.path
    public_auth = path in ('/api/auth/me', '/api/auth/sign-up', '/api/auth/sign-in', '/api/auth/sign-out')
    if not path.startswith('/api/') or path == '/api/health' or public_auth:
        return await call_next(request)
    if not auth_store.available():
        return JSONResponse({'detail': auth_store.startup_error or 'Configure MySQL in .env and restart the backend.'}, status_code=503)
    try:
        user = auth_store.user_for_token(request.cookies.get(AUTH_COOKIE))
    except Exception:
        return JSONResponse({'detail': 'The account database is unavailable.'}, status_code=503)
    if not user:
        return JSONResponse({'detail': 'Sign in to continue.'}, status_code=401)
    if request.method != 'GET' and any(path == prefix or path.startswith(prefix) for prefix in TRADER_PATHS) and user['level'] not in ('trader', 'admin'):
        return JSONResponse({'detail': 'Trader account level required.'}, status_code=403)
    request.state.user = user
    return await call_next(request)


class SignUpRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    email: str = Field(min_length=5, max_length=254, pattern=r'^[^\s@]+@[^\s@]+\.[^\s@]+$')
    display_name: str = Field(min_length=2, max_length=80)
    password: str = Field(min_length=10, max_length=128)


class SignInRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    email: str = Field(min_length=5, max_length=254)
    password: str = Field(min_length=1, max_length=128)


class AccountLevelRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    level: Literal['viewer','trader','admin']


def set_auth_cookie(response: Response, token: str) -> None:
    response.set_cookie(AUTH_COOKIE, token, max_age=SESSION_DAYS * 86400, httponly=True,
                        samesite='strict', secure=os.getenv('SILVER_HTTPS', '').lower() == 'true')

class Parameters(BaseModel):
    model_config = ConfigDict(extra='forbid')
    timeframe: Literal['1m', '3m', '5m', '10m', '15m', '30m', '1h', '4h', '1d'] = '1m'


class ChartViewRequest(Parameters):
    session_id: int
    clock: float = Field(ge=0,le=4102444800)


class BBBacktestRequest(BacktestRequest):
    """Any registered strategy; the name is kept for existing routes and tests."""


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
    search_method: Literal['grid','ml'] = 'grid'
    objective: Literal['profit','balanced'] = 'profit'
    validation_start: date | None = None
    forward_start: date | None = None
    model_config = ConfigDict(extra='forbid')
    settings: BBBacktestRequest


class LiveBotStartRequest(BBBacktestRequest):
    venue: Literal['okx','htx','mexc','binance']
    confirmation: Literal['START LIVE STRATEGY']

@app.post('/api/chart-view')
def session_chart(parameters: ChartViewRequest, request: Request):
    ws = workspace(request)
    from server.market.chart_view import chart_view
    with ws.paper.lock:
        state = ws.paper.state
        if not state or state['startedAt'] != parameters.session_id:
            raise HTTPException(status_code=409, detail='The paper session has changed. Reload its chart.')
        replay = state.get('mode') == 'replay'
        clock = min(parameters.clock, state.get('virtualTime',0) if replay else ws.paper.now())
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


@app.get('/api/auth/me')
def auth_me(request: Request):
    if not auth_store.configured():
        return {'configured': False, 'available': False, 'error': 'MySQL is not configured.', 'user': None}
    if not auth_store.available():
        return {'configured': True, 'available': False, 'error': auth_store.startup_error, 'user': None}
    return {'configured': True, 'available': True, 'error': None, 'user': auth_store.user_for_token(request.cookies.get(AUTH_COOKIE))}


@app.post('/api/auth/sign-up')
def auth_sign_up(parameters: SignUpRequest, response: Response):
    if not auth_store.available():
        raise HTTPException(status_code=503, detail=auth_store.startup_error or 'Configure MySQL in .env and restart the backend.')
    try:
        user, token = auth_store.sign_up(parameters.email, parameters.display_name, parameters.password)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    set_auth_cookie(response, token)
    return {'user': user}


@app.post('/api/auth/sign-in')
def auth_sign_in(parameters: SignInRequest, response: Response):
    if not auth_store.available():
        raise HTTPException(status_code=503, detail=auth_store.startup_error or 'Configure MySQL in .env and restart the backend.')
    try:
        user, token = auth_store.sign_in(parameters.email, parameters.password)
    except ValueError as error:
        raise HTTPException(status_code=401, detail=str(error)) from error
    set_auth_cookie(response, token)
    return {'user': user}


@app.post('/api/auth/sign-out')
def auth_sign_out(request: Request, response: Response):
    auth_store.sign_out(request.cookies.get(AUTH_COOKIE))
    response.delete_cookie(AUTH_COOKIE, samesite='strict')
    return {'signedOut': True}


@app.get('/api/auth/users')
def auth_users(request: Request):
    if request.state.user['level'] != 'admin':
        raise HTTPException(status_code=403, detail='Admin account level required.')
    return {'users': auth_store.list_users()}


@app.patch('/api/auth/users/{user_id}/level')
def auth_user_level(user_id: int, parameters: AccountLevelRequest, request: Request):
    if request.state.user['level'] != 'admin':
        raise HTTPException(status_code=403, detail='Admin account level required.')
    try:
        return {'user': auth_store.set_level(user_id, parameters.level)}
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@app.get('/api/profiles')
def list_profiles(request: Request):
    return user_data_store.list_profiles(int(request.state.user['id']))


@app.post('/api/profiles')
def save_profile(parameters: ProfileSaveRequest, request: Request):
    return user_data_store.save_profile(int(request.state.user['id']), parameters.name.strip(),
                                        parameters.settings.model_dump(mode='json'))


@app.delete('/api/profiles')
def delete_profile(request: Request, name: str = Query(min_length=1, max_length=48)):
    if not user_data_store.delete_profile(int(request.state.user['id']), name.strip()):
        raise HTTPException(status_code=404, detail='Saved setup not found')
    return {'deleted': name.strip()}


@app.get('/api/market-status')
def market_status():
    return refresh_service.status()


class BackfillRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    days: int = Field(ge=1, le=3650)


@app.get('/api/market-backfill')
def market_backfill_status():
    return history_backfill.status()


@app.post('/api/market-backfill')
def market_backfill(parameters: BackfillRequest):
    try:
        return history_backfill.start(parameters.days)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post('/api/market-backfill/stop')
def market_backfill_stop():
    return history_backfill.stop()


@app.post('/api/market-refresh')
def market_refresh():
    return refresh_service.refresh()


@app.get('/api/paper')
def paper_status(request: Request):
    ws = workspace(request)
    return ws.paper.status()


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
    stop_price: float | None = Field(default=None,gt=0,le=1e9)
    take_profit_price: float | None = Field(default=None,gt=0,le=1e9)
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
def exchange_status(request: Request):
    ws = workspace(request)
    return {'venues':ws.exchange.status(),'bot':ws.bot.status(),'savedVenues':credential_store.venues(request.state.user['id'])}


@app.post('/api/exchange/connect')
def exchange_connect(parameters: ExchangeConnectRequest, request: Request):
    ws = workspace(request)
    try:
        result = ws.exchange.connect(parameters.venue,parameters.api_key,parameters.secret,parameters.passphrase)
        credential_store.save(parameters.venue,parameters.api_key,parameters.secret,parameters.passphrase,request.state.user['id'])
        return result
    except ValueError as error:
        raise HTTPException(status_code=400,detail=str(error)) from error
    except Exception as error:
        # Exchange/library errors may echo request details. Never return credentials to the browser.
        raise HTTPException(status_code=502,detail=f'{parameters.venue.upper()} connection failed. Check API permissions, XAG contract access, account mode, and network availability.') from error


@app.get('/api/exchange/overview')
def exchange_overview(venue: Literal['okx','htx','mexc','binance'], request: Request):
    ws = workspace(request)
    try:
        return ws.exchange.overview(venue)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.get('/api/exchange/trade-history')
def exchange_trade_history(venue: Literal['okx','htx','mexc','binance'], request: Request):
    ws = workspace(request)
    try:
        return {'trades': ws.exchange.trade_history(venue)}
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=502, detail='Closed trade history is unavailable from the exchange.') from error


@app.get('/api/exchange/stream')
async def exchange_stream(venue: Literal['okx','htx','mexc','binance'], request: Request):
    ws = workspace(request)
    try:
        ws.exchange._get(venue)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return StreamingResponse(ws.streams.events(venue), media_type='text/event-stream',
                             headers={'Cache-Control':'no-cache', 'X-Accel-Buffering':'no'})


@app.get('/api/exchange/candles')
def exchange_candles(venue: Literal['okx','htx','mexc','binance'],
                     timeframe: Literal['1m','3m','5m','10m','15m','30m','1h','4h','1d'] = '1m',
                     before: int | None = None, *, request: Request):
    ws = workspace(request)
    try:
        exchange, market = ws.exchange._get(venue)
        durations = {'1m':60,'3m':180,'5m':300,'10m':600,'15m':900,'30m':1800,'1h':3600,'4h':14400,'1d':86400}
        supported = [key for key in durations if key in exchange.timeframes
                     and durations[key] <= durations[timeframe] and durations[timeframe] % durations[key] == 0]
        source = max(supported, key=lambda key: durations[key]) if supported else '1m'
        limit = 500
        since = None if before is None else max(0, before * 1000 - limit * durations[source] * 1000)
        if venue == 'htx' and before is not None:
            # HTX contract klines ignore `from`/`to` when `size` is present.
            # CCXT adds `size` whenever limit is supplied, so omit it for
            # backward pages and bound the request explicitly with `until`.
            candles = exchange.fetch_ohlcv(market['symbol'], source, since=since,
                                           params={'until': before * 1000 - 1})
        else:
            candles = exchange.fetch_ohlcv(market['symbol'], source, since=since, limit=limit)
        if before is not None:
            candles = [candle for candle in candles if candle[0] < before * 1000]
        # Exchanges apply different per-request caps (often 100-300 rows), so a
        # short page does not mean history ended. The client stops when a page
        # contains no candle older than its current boundary.
        return {'candles': candles, 'hasMore': bool(candles)}
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=502, detail='Exchange candle history is unavailable.') from error


@app.post('/api/exchange/disconnect')
def exchange_disconnect(parameters: ExchangeDisconnectRequest, request: Request):
    ws = workspace(request)
    try:
        return ws.exchange.disconnect(parameters.venue)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.post('/api/exchange/reconnect')
def exchange_reconnect(parameters: ExchangeDisconnectRequest, request: Request):
    ws = workspace(request)
    try:
        credentials = credential_store.load(parameters.venue,request.state.user['id'])
        return ws.exchange.connect(parameters.venue, **credentials)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=502, detail='Saved exchange connection failed. Check network and API access.') from error


@app.post('/api/exchange/forget')
def exchange_forget(parameters: ExchangeDisconnectRequest, request: Request):
    credential_store.delete(parameters.venue,request.state.user['id'])
    return {'message':'Saved API credentials deleted.'}


@app.post('/api/exchange/order')
def exchange_order(parameters: ExchangeOrderRequest, request: Request):
    ws = workspace(request)
    try:
        # Margin mode and leverage cannot change while a position is open: check that first.
        if any(float(position.get('contracts') or 0) != 0 for position in ws.exchange.positions(parameters.venue)):
            raise ValueError('An XAG/USDT position is already open. Close it (Close tab) before opening another.')
        ws.exchange.prepare_account(parameters.venue, parameters.leverage)
        return ws.exchange.open_with_stop(parameters.venue,parameters.direction,parameters.quantity,
                                            parameters.stop_price,parameters.take_profit_price)
    except ValueError as error:
        raise HTTPException(status_code=400,detail=str(error)) from error
    except (OrderStepError, RuntimeError) as error:
        logger.warning('Live order failed for user %s: %s', request.state.user['id'], error)
        raise HTTPException(status_code=502,detail=f'{error} Check the exchange order and position status before retrying.') from error
    except Exception as error:
        logger.exception('Live order failed')
        raise HTTPException(status_code=502,detail=f'Live order failed ({safe_exchange_error(error)}). Check the exchange order and position status before retrying.') from error


@app.post('/api/exchange/close')
def exchange_close(parameters: ExchangeCloseRequest, request: Request):
    ws = workspace(request)
    try:
        return ws.exchange.close_position(parameters.venue)
    except ValueError as error:
        raise HTTPException(status_code=400,detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=502,detail='Close request failed. Check the live position and open reduce-only orders at the exchange.') from error


@app.post('/api/exchange/auto/start')
def exchange_auto_start(parameters: LiveBotStartRequest, request: Request):
    ws = workspace(request)
    if not get_strategy(parameters.strategy).live_supported:
        raise HTTPException(status_code=400, detail=f'{get_strategy(parameters.strategy).label} runs in backtests and paper trading only. Validate it there before live use.')
    try:
        return ws.bot.start(parameters.venue,parameters)
    except ValueError as error:
        raise HTTPException(status_code=400,detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=502,detail='Could not start the live strategy. Verify exchange account state and protective-order support.') from error


@app.post('/api/exchange/auto/stop')
def exchange_auto_stop(request: Request):
    ws = workspace(request)
    return ws.bot.stop()


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
def paper_start(parameters: PaperStartRequest, request: Request):
    ws = workspace(request)
    try:
        return ws.paper.begin(parameters)
    except (ValueError, OSError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


class ReplaySpeed(BaseModel):
    speed: float = Field(ge=1,le=10000)


@app.post('/api/paper/speed')
def paper_speed(parameters: ReplaySpeed, request: Request):
    ws = workspace(request)
    try:
        return ws.paper.set_speed(parameters.speed)
    except (ValueError, OSError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post('/api/paper/{action}')
def paper_action(action: Literal['pause', 'resume'], request: Request):
    ws = workspace(request)
    try:
        return ws.paper.set_running(action == 'resume')
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


def _run_backtest(parameters: BBBacktestRequest):
    frame, _ = load_bars(parameters.entry_timeframe)
    return run_bb_reversal_backtest(frame, parameters)


@app.post('/api/backtest')
def backtest(parameters: BBBacktestRequest, request: Request):
    try:
        result = _run_backtest(parameters)
    except (ValueError, OSError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    try:
        result['runId'] = user_data_store.save_backtest(int(request.state.user['id']), result)
    except Exception:
        logger.exception('Could not save backtest result')
        result['runId'] = None
    return result


@app.get('/api/backtests')
def backtest_history(request: Request):
    return user_data_store.list_backtests(int(request.state.user['id']))


@app.get('/api/backtests/{run_id}')
def backtest_open(run_id: int, request: Request):
    """Reopen a saved run: stored summary and trades, chart rebuilt from its settings."""
    saved = user_data_store.get_backtest(int(request.state.user['id']), run_id)
    if not saved:
        raise HTTPException(status_code=404, detail='Saved backtest not found')
    try:
        result = _run_backtest(BBBacktestRequest(**saved['settings']))
    except (ValueError, OSError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    result['backtest']['summary'], result['backtest']['trades'] = saved['summary'], saved['trades']
    result['runId'] = run_id
    return result


class BacktestRename(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str | None = Field(default=None, max_length=80)


@app.patch('/api/backtests/{run_id}')
def backtest_rename(run_id: int, parameters: BacktestRename, request: Request):
    user_data_store.rename_backtest(int(request.state.user['id']), run_id, (parameters.name or '').strip() or None)
    return {'id': run_id, 'name': parameters.name}


@app.delete('/api/backtests/{run_id}')
def backtest_delete(run_id: int, request: Request):
    user_data_store.delete_backtest(int(request.state.user['id']), run_id)
    return {'deleted': run_id}


@app.get('/api/paper/history')
def paper_history(request: Request):
    return user_data_store.paper_history(int(request.state.user['id']))


@app.get('/api/paper/history/{session_started}/trades')
def paper_history_trades(session_started: int, request: Request):
    return user_data_store.paper_trades(int(request.state.user['id']), session_started)


@app.get('/api/exchange/bot-events')
def bot_events(request: Request):
    return user_data_store.bot_events(int(request.state.user['id']))


class SearchStopped(Exception):
    """Raised inside a tuner when its user asks to stop the search."""


# One cancel signal per user: a new search replaces it, the stop route sets it.
search_cancels: dict[int, threading.Event] = {}


@app.post('/api/backtest/fine-tune/stop')
def fine_tune_stop(request: Request):
    cancel = search_cancels.get(int(request.state.user['id']))
    if cancel:
        cancel.set()
    return {'stopping': cancel is not None}


@app.post('/api/backtest/fine-tune')
def fine_tune_backtest(parameters: FineTuneRequest, request: Request):
    updates = Queue()
    user_id = int(request.state.user['id'])
    previous = search_cancels.get(user_id)
    if previous:
        previous.set()  # Starting a new search stops the user's previous one.
    cancel = search_cancels[user_id] = threading.Event()

    def progress(percent, message):
        if cancel.is_set():
            raise SearchStopped()
        updates.put({'type': 'progress', 'percent': percent, 'message': message})

    def work():
        try:
            frame, _ = load_bars(parameters.settings.entry_timeframe)
            tuner = ml_fine_tune if parameters.settings.strategy == 'ml_ensemble' else fine_tune
            result = tuner(frame, parameters.settings, search_method=parameters.search_method, objective=parameters.objective,
                           validation_start=parameters.validation_start, forward_start=parameters.forward_start,
                           progress=progress)
            updates.put({'type': 'result', 'result': result})
        except SearchStopped:
            updates.put({'type': 'stopped', 'detail': 'Search stopped.'})
        except (ValueError, OSError) as error:
            updates.put({'type': 'error', 'detail': str(error)})
        except Exception as error:
            logger.exception('Fine tuning failed')
            updates.put({'type': 'error', 'detail': str(error) or 'Fine tuning failed. Check the backend log.'})
        finally:
            if search_cancels.get(user_id) is cancel:
                search_cancels.pop(user_id, None)
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
                    low=float(row.low), close=float(row.close),
                    **optional_volume(row.volume if 'volume' in selected.columns else None))
               for t, row in selected.iterrows()]
    return dict(candles=candles, hasMore=len(complete) > len(selected),
                nextBefore=candles[0]['time'] if candles else None)


@app.post('/api/candles')
def history(parameters: CandleRequest):
    try:
        frame, _ = load_bars(parameters.timeframe)
        return candle_page(frame, parameters.before, parameters.limit)
    except (ValueError, OSError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


class PatternRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    timeframe: Literal['1m', '3m', '5m', '10m', '15m', '30m', '1h', '4h', '1d'] = '15m'
    window: int = Field(default=48, ge=8, le=500)
    horizon: int = Field(default=24, ge=1, le=500)
    top_k: int = Field(default=20, ge=1, le=200)
    end: int | None = Field(default=None, ge=0, le=4102444800)


@app.post('/api/patterns')
def similar_patterns(parameters: PatternRequest):
    """Past windows most similar to the latest (or ``end``) window and their future high/low bands."""
    from server.market.patterns import find_similar
    try:
        bars, _ = load_bars(parameters.timeframe)
        end = pd.Timestamp(parameters.end, unit='s', tz='UTC') if parameters.end else None
        return find_similar(bars, window=parameters.window, horizon=parameters.horizon, top_k=parameters.top_k, end=end)
    except (ValueError, OSError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.get('/api/strategies')
def strategies():
    from server.strategies.ml.features import FEATURE_GROUPS
    from server.strategies.ml.models import available_models, compute_status
    from server.strategies.registry import STRATEGIES
    return dict(strategies=[dict(key=r.key, label=r.label, liveSupported=r.live_supported) for r in STRATEGIES.values()],
                featureGroups=[dict(key=g.key, label=g.label, description=g.description) for g in FEATURE_GROUPS.values()],
                models=available_models(), compute=compute_status())


@app.get('/api/costs/htx')
def htx_cost_snapshot():
    from server.exchanges.htx_costs import fetch_htx_costs
    try:
        return fetch_htx_costs()
    except Exception as error:
        raise HTTPException(status_code=502, detail='Could not fetch HTX XAG costs. Existing settings were preserved. '+str(error)) from error

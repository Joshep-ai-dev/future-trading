"""Local exchange clients and execution; credential persistence lives in credential_store."""
from __future__ import annotations

import threading
import time
import json
import math
from typing import Literal

import pandas as pd

from server.strategies.bb_outer_reversal import Settings, run_backtest
from server.strategies.readiness import strategy_readiness
from server.strategies.indicators import rsi
from server.market.data import TIMEFRAMES
from server.exchanges.htx_account import classic_balance, classic_positions, classic_orders, rejection_reason, normalize_htx_balance


VENUES = {
    'okx': 'okx',
    'htx': 'htx',
    'mexc': 'mexc',
    'binance': 'binanceusdm',
}


_UNCHANGED = ('no need', 'not modified', 'same', 'already', 'no change', 'unchanged', 'not changed')


def safe_exchange_error(error: Exception, limit: int = 240) -> str:
    """Exchange error text without request URLs, query strings or long tokens (keys, signatures)."""
    import re
    text = f'{type(error).__name__}: {error}'
    text = re.sub(r'https?://\S+', '[url]', text)
    text = re.sub(r'\?[^\s"\']*', '', text)
    text = re.sub(r'[A-Za-z0-9+/=_-]{24,}', '[hidden]', text)
    return ' '.join(text.split())[:limit]


# Exchanges whose ccxt adapter chooses the margin mode per request (and defaults to cross) instead of
# offering setMarginMode: every order and leverage call must say 'isolated' explicitly.
PER_ORDER_MARGIN = {'htx'}


def margin_params(venue: str) -> dict:
    return {'marginMode': 'isolated'} if venue in PER_ORDER_MARGIN else {}


def _position_side_error(error: Exception) -> bool:
    text = str(error).lower()
    return 'position_side' in text or '"code":1066' in text or '"code":1067' in text


class OrderStepError(RuntimeError):
    """A live order step failed; the message names the step and the (sanitised) exchange reason."""

    def __init__(self, step: str, error: Exception):
        super().__init__(f'{step} failed: {safe_exchange_error(error)}')
        self.step = step


class LiveExchange:
    def __init__(self):
        self.lock = threading.RLock()
        self.trade_lock = threading.RLock()
        self.clients = {}
        self.markets = {}
        self.protective_orders = {}
        self.take_profit_orders = {}
        self.auto_bot = None

    @staticmethod
    def _market(exchange):
        exchange.load_markets()
        candidates = [market for market in exchange.markets.values()
                      if market.get('swap') and market.get('linear')
                      and market.get('quote') == 'USDT'
                      and market.get('settle') == 'USDT'
                      and (market.get('base') == 'XAG'
                           or 'XAG' in str(market.get('baseId', '')).upper()
                           or 'XAG' in str(market.get('id', '')).upper())]
        candidates = [market for market in candidates if market.get('active') is not False]
        if not candidates:
            raise ValueError('This exchange account does not expose an active linear XAG/USDT perpetual contract through its API')
        return sorted(candidates, key=lambda market: (market.get('base') != 'XAG', market['symbol']))[0]

    def connect(self, venue: str, api_key: str, secret: str, passphrase: str | None = None):
        if venue not in VENUES:
            raise ValueError('Choose OKX, HTX, MEXC or Binance USDⓈ-M Futures')
        if not api_key.strip() or not secret.strip():
            raise ValueError('API key and secret are required')
        import ccxt
        exchange_type = getattr(ccxt, VENUES[venue])
        credentials = dict(apiKey=api_key.strip(), secret=secret.strip(), enableRateLimit=True)
        if passphrase:
            credentials['password'] = passphrase
        if venue == 'okx' and not passphrase:
            raise ValueError('OKX requires the API key passphrase')
        if venue == 'htx':
            credentials['options'] = {'defaultType': 'swap', 'defaultSubType': 'linear'}
        exchange = exchange_type(credentials)
        stage = 'loading XAG/USDT markets'
        try:
            market = self._market(exchange)
            if not exchange.has.get('fetchPositions'):
                raise ValueError(f'{venue.upper()} adapter does not support position checks required for safe live orders')
            stage = 'reading the futures account balance'
            balance = self.account_balance(exchange, venue)
        except Exception as error:
            try:
                exchange.close()
            except Exception:
                pass
            # Only fixed messages reach the browser: exchange errors can contain secrets.
            if isinstance(error, ccxt.PermissionDenied):
                raise ValueError(f'{venue.upper()} denied access while {stage}. Check API futures permissions and the key IP allowlist.') from error
            if isinstance(error, ccxt.AuthenticationError):
                raise ValueError(f'{venue.upper()} authentication failed while {stage}. Check the API key/secret, key IP allowlist, and computer clock.') from error
            if isinstance(error, ccxt.NetworkError):
                raise ValueError(f'{venue.upper()} network request failed while {stage}. Check that this computer can reach the exchange API, then retry.') from error
            if isinstance(error, ccxt.ExchangeError):
                raise ValueError(f'{venue.upper()} rejected the request while {stage}. Check that the USDT perpetual account is enabled and its account mode is supported by the API.') from error
            raise
        with self.lock:
            previous = self.clients.pop(venue, None)
            self.markets.pop(venue, None)
            self.clients[venue] = exchange
            self.markets[venue] = market
            if previous:
                previous.close()
        total = balance.get('total', {}).get('USDT')
        return dict(venue=venue, connected=True, symbol=market['symbol'],
                    contractSize=market.get('contractSize'), usdtBalance=total)

    def disconnect(self, venue: str):
        bot = self.auto_bot
        if bot and bot.venue == venue:
            bot.stop()
            thread = bot.thread
            if thread and thread.is_alive():
                thread.join(timeout=15)
                if thread.is_alive():
                    raise ValueError('The live bot is finishing an exchange request. No new cycles will start. Retry Disconnect after it finishes.')
        # Do not cancel exchange orders or close positions when ending a local connection.
        with self.trade_lock, self.lock:
            exchange = self.clients.pop(venue, None)
            self.markets.pop(venue, None)
        if exchange:
            exchange.close()
        return dict(venue=venue, connected=False,
                    message='Disconnected. Local automation stopped; exchange positions and orders remain active. Saved keys were kept.')

    def status(self):
        with self.lock:
            rows=[]
            for venue in self.clients:
                row=dict(venue=venue, connected=True, symbol=self.markets[venue]['symbol'],
                         contractSize=self.markets[venue].get('contractSize'),position=None,
                         executionError=self.execution_error(self.clients[venue]))
                try:
                    active=[p for p in self.positions(venue) if float(p.get('contracts') or 0)!=0]
                    if len(active)==1:
                        p=active[0]; market=self.markets[venue]
                        row['position']=dict(side=p.get('side'),quantity=abs(float(p.get('contracts') or 0))*float(market.get('contractSize') or 1),
                                             entryPrice=p.get('entryPrice'),markPrice=p.get('markPrice'),unrealizedPnl=p.get('unrealizedPnl'))
                    elif len(active)>1:
                        row['position']={'error':'Multiple XAG positions detected; reconcile at exchange'}
                except Exception as error:
                    row['position']={'error':f'Position query failed: {type(error).__name__}'}
                rows.append(row)
            return rows

    def _get(self, venue: str):
        with self.lock:
            exchange, market = self.clients.get(venue), self.markets.get(venue)
        if exchange is None or market is None:
            raise ValueError(f'Connect {venue.upper()} before placing orders')
        return exchange, market

    @staticmethod
    def execution_error(exchange) -> str | None:
        if exchange.options.get('localAccountApi') == 'classic':
            return 'HTX classic account detected. Account monitoring is available; manage orders on HTX until classic execution is supported.'
        return None

    def execution_client(self, venue: str):
        exchange, market = self._get(venue)
        error = self.execution_error(exchange)
        if error:
            raise ValueError(error)
        return exchange, market

    def overview(self, venue: str) -> dict:
        exchange, market = self._get(venue)
        result = dict(venue=venue, symbol=market['symbol'], market=None,
                      balance=None, positions=None, orders=None, errors={})
        contract_size = float(market.get('contractSize') or 1)
        # Isolate failures so a missing endpoint never looks like a flat account.
        for section in ('market', 'balance', 'positions', 'orders'):
            try:
                if section == 'market':
                    ticker = exchange.fetch_ticker(market['symbol'])
                    result[section] = {key: ticker.get(key) for key in
                                       ('last', 'bid', 'ask', 'high', 'low', 'percentage', 'quoteVolume', 'timestamp')}
                elif section == 'balance':
                    balance = self.account_balance(exchange, venue)
                    if balance.get('total', {}).get('USDT') is None:
                        raise ValueError('USDT balance unavailable')
                    result[section] = {key: balance.get(key, {}).get('USDT') for key in ('total', 'free', 'used')}
                elif section == 'positions':
                    result[section] = [dict(side=p.get('side'),
                        quantity=abs(float(p.get('contracts') or 0)) * contract_size,
                        **{key: p.get(key) for key in ('entryPrice', 'markPrice', 'unrealizedPnl', 'leverage', 'liquidationPrice', 'marginMode', 'initialMargin', 'percentage')})
                        for p in self.positions(venue) if float(p.get('contracts') or 0) != 0]
                else:
                    if not exchange.has.get('fetchOpenOrders'):
                        result['errors'][section] = 'Open orders are unavailable through this exchange adapter.'
                        continue
                    result[section] = [dict(id=o.get('id'), side=o.get('side'), type=o.get('type'),
                        price=o.get('price'), triggerPrice=o.get('triggerPrice') or o.get('stopPrice'),
                        quantity=None if o.get('amount') is None else float(o['amount']) * contract_size,
                        filled=None if o.get('filled') is None else float(o['filled']) * contract_size,
                        status=o.get('status')) for o in self.open_orders(venue)]
            except Exception:
                result['errors'][section] = f'{section.capitalize()} could not be refreshed. Check exchange API access and retry.'
        result['updatedAt'] = time.time() * 1000
        result['executionError'] = self.execution_error(exchange)
        return result

    def market_order(self, venue: str, side: Literal['buy', 'sell'], quantity: float,
                     *, reduce_only: bool = False):
        if side not in ('buy', 'sell') or not isinstance(quantity, (int, float)) or quantity <= 0:
            raise ValueError('Order side and XAG quantity must be valid and positive')
        exchange, market = self.execution_client(venue)
        size = float(quantity) / float(market.get('contractSize') or 1)
        amount = float(exchange.amount_to_precision(market['symbol'], size))
        if amount <= 0 or amount < float(market.get('limits', {}).get('amount', {}).get('min') or 0):
            raise ValueError('Quantity is below this contract’s minimum order size')
        params = {**margin_params(venue), **({'reduceOnly': True} if reduce_only else {})}
        order = exchange.create_order(market['symbol'], 'market', side, amount, None, params)
        return dict(id=order.get('id'), status=order.get('status'), side=side,
                    amount=order.get('amount'), filled=order.get('filled'), average=order.get('average'),
                    symbol=market['symbol'], reduceOnly=reduce_only)

    def prepare_account(self, venue: str, leverage: int) -> None:
        """Isolated margin and leverage, tolerating 'already set' answers. Call only when flat."""
        exchange, market = self.execution_client(venue)
        import ccxt
        def set_leverage() -> None:
            params = margin_params(venue)
            if venue != 'htx':
                exchange.set_leverage(int(leverage), market['symbol'], params)
                return
            # HTX's unified-account endpoint needs position_side: 'both' in one-way mode, each side in hedge mode.
            try:
                exchange.set_leverage(int(leverage), market['symbol'], {**params, 'position_side': 'both'})
            except Exception as error:
                if not _position_side_error(error):
                    raise
                for side in ('long', 'short'):
                    exchange.set_leverage(int(leverage), market['symbol'], {**params, 'position_side': side})

        steps = [(f'Setting {leverage}x leverage', set_leverage)]
        if venue not in PER_ORDER_MARGIN:  # HTX sets isolated margin on each order instead.
            steps.insert(0, ('Setting isolated margin', lambda: exchange.set_margin_mode('isolated', market['symbol'])))
        for step, call in steps:
            try:
                call()
            except ccxt.NotSupported:
                continue  # The adapter has no such call; margin mode is then sent with each order.
            except Exception as error:
                if any(word in str(error).lower() for word in _UNCHANGED):
                    continue  # The account already uses this setting.
                raise OrderStepError(step, error) from error

    def open_with_stop(self, venue: str, direction: Literal['long', 'short'],
                       quantity: float, stop_price: float | None, take_profit_price: float | None = None):
        with self.trade_lock:
            return self._open_with_stop_locked(venue,direction,quantity,stop_price,take_profit_price)

    def _open_with_stop_locked(self, venue: str, direction: Literal['long', 'short'],
                               quantity: float, stop_price: float, take_profit_price: float | None = None):
        exchange, market = self._get(venue)
        positions = self.positions(venue)
        if any(float(position.get('contracts') or 0) != 0 for position in positions):
            raise ValueError('Close the existing XAG/USDT position before opening another from this terminal')
        ticker = exchange.fetch_ticker(market['symbol'])
        last = float(ticker.get('last') or 0)
        if not last:
            raise ValueError('No current price from the exchange; try again')
        if stop_price is not None and ((direction == 'long' and stop_price >= last) or (direction == 'short' and stop_price <= last)):
            raise ValueError('Stop must be below the current price for a long, or above it for a short')
        if take_profit_price is not None and (direction == 'long' and take_profit_price <= last
                                              or direction == 'short' and take_profit_price >= last):
            raise ValueError('Take profit must be above the current price for a long, or below it for a short')
        side = 'buy' if direction == 'long' else 'sell'
        try:
            result = self.market_order(venue, side, quantity)
        except ValueError:
            raise
        except Exception as error:
            raise OrderStepError('Market entry order', error) from error
        contract_size = float(market.get('contractSize') or 1)
        stop_quantity = float(result.get('filled') or result.get('amount') or 0) * contract_size
        if stop_quantity <= 0:
            stop_quantity = quantity
        stop = None
        try:
            if stop_price is not None:
                stop = self.set_stop(venue, direction, stop_quantity, stop_price)
        except Exception as error:
            try:
                self.market_order(venue, 'sell' if direction == 'long' else 'buy', quantity, reduce_only=True)
            except Exception as close_error:
                raise RuntimeError('Entry was sent, the stop loss was rejected, and the emergency close also failed '
                                   f'({safe_exchange_error(close_error)}). Check the position at the exchange now.') from error
            raise RuntimeError('Entry was sent but the stop loss was rejected, so it was closed again with a reduce-only order '
                               f'({safe_exchange_error(error)}).') from error
        if stop is not None:
            with self.lock:
                self.protective_orders[venue] = stop.get('id')
        take_profit = None
        take_profit_error = None
        if take_profit_price is not None:
            try:
                take_profit = self.set_stop(venue, direction, stop_quantity, take_profit_price)
                with self.lock:
                    self.take_profit_orders[venue] = take_profit.get('id')
            except Exception:
                # The required stop is already active, so keep the protected position and
                # report that the optional take-profit must be added at the exchange.
                take_profit_error = 'The position and stop are active, but the exchange rejected the take-profit order.'
        return dict(order=result, protectiveStop=stop, takeProfit=take_profit,
                    takeProfitError=take_profit_error, direction=direction,
                    quantity=stop_quantity, entryPrice=result.get('average'))

    def close_position(self, venue: str):
        with self.trade_lock:
            return self._close_position_locked(venue)

    def _close_position_locked(self, venue: str):
        if self.auto_bot and self.auto_bot.running and self.auto_bot.venue == venue:
            raise ValueError('Stop the automated strategy before manually closing its position')
        exchange, market = self.execution_client(venue)
        positions = self.positions(venue)
        active = [position for position in positions if float(position.get('contracts') or 0) != 0]
        if not active:
            return dict(venue=venue, closed=False, message='No open XAG/USDT position')
        if len(active) != 1:
            raise ValueError('Multiple XAG/USDT positions detected. Reconcile the account position mode before closing here')
        position = active[0]
        contracts = float(position.get('contracts') or 0)
        side = 'sell' if position.get('side') == 'long' else 'buy'
        base_quantity = abs(contracts) * float(market.get('contractSize') or 1)
        result = self.market_order(venue, side, base_quantity, reduce_only=True)
        with self.lock:
            stop_id = self.protective_orders.pop(venue, None)
            take_profit_id = self.take_profit_orders.pop(venue, None)
        for stop_id in (stop_id, take_profit_id):
            if stop_id:
                try:
                    self.cancel_stop(venue, stop_id)
                except Exception:
                    # The remaining reduce-only stop cannot increase exposure.
                    pass
        return dict(venue=venue, closed=True, order=result)

    def set_stop(self, venue: str, direction: Literal['long', 'short'], quantity: float, trigger: float):
        if not isinstance(trigger, (int, float)) or trigger <= 0:
            raise ValueError('Protective stop price must be positive')
        exchange, market = self._get(venue)
        side = 'sell' if direction == 'long' else 'buy'
        contracts = float(quantity) / float(market.get('contractSize') or 1)
        amount = float(exchange.amount_to_precision(market['symbol'], contracts))
        price = float(exchange.price_to_precision(market['symbol'], trigger))
        params = {**margin_params(venue), 'triggerPrice': price, 'reduceOnly': True}
        if venue != 'htx':
            order = exchange.create_order(market['symbol'], 'market', side, amount, None, params)
        else:
            # HTX trigger orders need position_side: 'both' in one-way mode, the position's side in hedge mode.
            for attempt, position_side in enumerate(('both', direction)):
                try:
                    order = exchange.create_order(market['symbol'], 'market', side, amount, None,
                                                  {**params, 'position_side': position_side})
                    break
                except Exception as error:
                    if attempt or not _position_side_error(error):
                        raise
        if not order.get('id'):
            raise RuntimeError('Exchange did not confirm the protective stop order id')
        return dict(id=order.get('id'), amount=order.get('amount'), triggerPrice=price)

    def cancel_stop(self, venue: str, order_id: str):
        exchange, market = self._get(venue)
        return exchange.cancel_order(order_id, market['symbol'], {'trigger': True})

    @staticmethod
    def account_balance(exchange, venue: str) -> dict:
        if venue != 'htx':
            return exchange.fetch_balance()
        if exchange.options.get('localAccountApi') == 'classic':
            return classic_balance(exchange)
        import ccxt
        try:
            balance = exchange.fetch_balance({'type': 'swap', 'subType': 'linear'})
            info = balance.get('info')
            if isinstance(info, dict) and str(info.get('code')) in ('401', '403'):
                # Some adapter versions parse rejected V5 responses as empty balances.
                raise ccxt.AuthenticationError('htx ' + json.dumps({'code': info['code']}))
        except (ccxt.AuthenticationError, ccxt.NotSupported) as v5_error:
            # A classic-account key can be rejected by V5 before returning a balance.
            # Confirm access through the classic API before declaring the key invalid.
            try:
                balance = classic_balance(exchange)
            except Exception as classic_error:
                raise ValueError('HTX authentication failed while reading the futures account balance. '
                    f'V5: {rejection_reason(v5_error)}. Classic: {rejection_reason(classic_error)}. '
                    'These checks used the saved or submitted credentials. If the key and IP were changed, re-enter the current key and secret instead of connecting the saved account.') from classic_error
            exchange.options['localAccountApi'] = 'classic'
            return balance
        if balance.get('total', {}).get('USDT') is None:
            balance = classic_balance(exchange)
            exchange.options['localAccountApi'] = 'classic'
        return normalize_htx_balance(balance)

    def open_orders(self, venue: str) -> list[dict]:
        exchange, market = self._get(venue)
        if venue == 'htx' and exchange.options.get('localAccountApi') == 'classic':
            return classic_orders(exchange, market)
        return exchange.fetch_open_orders(market['symbol'])

    def trade_history(self, venue: str) -> list[dict]:
        exchange, market = self._get(venue)
        if not exchange.has.get('fetchClosedOrders'):
            return []
        orders = exchange.fetch_closed_orders(market['symbol'], limit=100)
        result = []
        for order in orders:
            info = order.get('info') if isinstance(order.get('info'), dict) else {}
            raw_pnl = next((info.get(key) for key in ('real_profit', 'realized_pnl', 'realizedPnl', 'profit')
                            if info.get(key) is not None), None)
            try:
                pnl = float(raw_pnl)
            except (TypeError, ValueError):
                continue
            if not math.isfinite(pnl):
                continue
            amount = float(order.get('filled') or order.get('amount') or 0)
            contract_size = float(market.get('contractSize') or 1)
            price = float(order.get('average') or order.get('price') or 0)
            timestamp = int((order.get('lastTradeTimestamp') or order.get('timestamp') or 0) / 1000)
            raw_leverage = next((info.get(key) for key in ('lever_rate', 'lever', 'leverage')
                                 if info.get(key) not in (None, '')), None)
            try:
                leverage = float(raw_leverage) if raw_leverage is not None else None
            except (TypeError, ValueError):
                leverage = None
            result.append(dict(id=str(order.get('id') or timestamp), side=order.get('side'),
                               pnl=pnl, price=price, quantity=amount * contract_size,
                               leverage=leverage if leverage and math.isfinite(leverage) else None,
                               timestamp=timestamp))
        return result

    def positions(self, venue: str):
        exchange, market = self._get(venue)
        if not exchange.has.get('fetchPositions'):
            raise ValueError(f'{venue.upper()} position query is not supported by the installed exchange adapter')
        if venue == 'htx' and exchange.options.get('localAccountApi') == 'classic':
            return classic_positions(exchange, market)
        return exchange.fetch_positions([market['symbol']])


class AutomaticLiveBot:
    """Runs the candle strategy against the connected venue and keeps an exchange stop."""
    def __init__(self, exchange_service: LiveExchange):
        self.service = exchange_service
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.thread = None
        self.running = False
        self.venue = None
        self.settings = None
        self.timeframe = None
        self.duration = None
        self.frame = None
        self.trading_from = None
        self.last_processed = None
        self.position = None
        self.error = None
        self.started_at = None
        self.strategy_state = None
        self.on_event = None

    def _event(self, kind, **detail):
        if self.on_event:
            try:self.on_event(self.venue or detail.get('venue') or '', kind, detail)
            except Exception:pass

    def status(self):
        with self.lock:
            return dict(running=self.running,venue=self.venue,timeframe=self.timeframe,
                        startedAt=self.started_at,lastProcessed=self.last_processed,
                        position=self.position,strategyState=self.strategy_state,error=self.error)

    def start(self, venue, request):
        exchange, market = self.service.execution_client(venue)
        if self.running:
            raise ValueError('Stop the current live strategy before starting another')
        active = [p for p in self.service.positions(venue) if float(p.get('contracts') or 0) != 0]
        if active:
            raise ValueError('Close the existing exchange position before starting the live strategy')
        available = self._available_usdt(exchange)
        request = request.model_copy(update={'capital': available})
        timeframe = request.entry_timeframe
        duration = TIMEFRAMES[timeframe]
        leverage=float(request.max_leverage)
        if leverage != int(leverage):
            raise ValueError('Live exchange leverage must be a whole number')
        try:
            self.service.prepare_account(venue,int(leverage))
        except OrderStepError as error:
            raise ValueError(f'{error}. Check account position mode, venue limits and API permissions.') from error
        frame = self._fetch_frame(exchange,market,timeframe,duration)
        if len(frame) < 100:
            raise ValueError('The exchange returned too few completed candles to warm up the strategy')
        self.venue,self.settings,self.timeframe,self.duration=venue,request, timeframe,duration
        self.frame=frame
        self.last_processed=int(frame.index[-1].timestamp())
        self.trading_from=self.last_processed+duration
        self.position=None
        self.strategy_state=dict(status='warming_up',close=None,longReadiness=0,shortReadiness=0,
                                 longChecks=[],shortChecks=[])
        self.error=None
        self.started_at=int(time.time())
        self.stop_event.clear()
        self.running=True
        self.thread=threading.Thread(target=self._run,name=f'live-strategy-{venue}',daemon=True)
        self.thread.start()
        self._event('start',timeframe=timeframe,leverage=request.max_leverage,capital=available)
        return self.status()

    @staticmethod
    def _fetch_frame(exchange,market,timeframe,duration):
        provider_timeframe=timeframe if timeframe in (exchange.timeframes or {}) else '1m'
        minutes=exchange.fetch_ohlcv(market['symbol'],provider_timeframe,limit=1000)
        if not minutes:
            raise ValueError('The exchange returned no market candles')
        source=pd.DataFrame(minutes,columns=['milliseconds','open','high','low','close','volume'])
        source['time']=pd.to_datetime(source.pop('milliseconds'),unit='ms',utc=True)
        source=source.set_index('time').sort_index()
        if provider_timeframe=='1m' and duration>60:
            rule=f'{duration}s'
            source=source.resample(rule,origin='epoch',label='left',closed='left').agg(
                {'open':'first','high':'max','low':'min','close':'last','volume':'sum'}).dropna(subset=['open','high','low','close'])
        now=pd.Timestamp.now(tz='UTC')
        source=source.loc[source.index+pd.Timedelta(seconds=duration)<=now]
        return source[['open','high','low','close']].tail(1000)

    def _run(self):
        while not self.stop_event.is_set():
            try:
                self._cycle()
            except Exception as error:
                with self.lock:
                    self.error='Live strategy paused after an exchange or data error. Check the exchange position and protective stop before resuming.'
                    self.running=False
                self._event('error',message=str(error)[:300])
                break
            self.stop_event.wait(1)

    def _cycle(self):
        with self.lock:
            if not self.running:return
            venue,request,timeframe,duration=self.venue,self.settings,self.timeframe,self.duration
            frame=self.frame.copy()
            last=self.last_processed
        exchange,market=self.service._get(venue)
        fresh=self._fetch_frame(exchange,market,timeframe,duration)
        fresh=fresh.loc[fresh.index>pd.Timestamp(last,unit='s',tz='UTC')]
        if fresh.empty:return
        active=[p for p in self.service.positions(venue) if float(p.get('contracts') or 0)!=0]
        if self.position is None and active:
            raise RuntimeError('An unmanaged XAG position appeared; live automation has paused')
        if self.position is not None:
            if len(active)>1:
                raise RuntimeError('Multiple XAG positions detected; live automation has paused')
            if not active:
                # The exchange stop may have filled. Stay flat until a fresh strategy entry signal.
                with self.lock:self.position=None
            else:
                exchange_position=active[0]
                expected=self.position['direction']
                actual_quantity=abs(float(exchange_position.get('contracts') or 0))*float(market.get('contractSize') or 1)
                if exchange_position.get('side')!=expected or abs(actual_quantity-self.position['quantity'])>max(.001,self.position['quantity']*.02):
                    raise RuntimeError('Exchange position differs from the bot position; live automation has paused')
        for stamp,row in fresh.iterrows():
            with self.lock:
                if not self.running:return
            frame=pd.concat([frame,pd.DataFrame([row],index=[stamp])]).tail(1000)
            config_fields=dict(request.bb_reversal)
            for key in ('initial_capital','leverage','trade_mode','min_tick','min_tick_unit'):
                config_fields.pop(key,None)
            config=Settings(**config_fields,initial_capital=request.capital,
                            leverage=request.max_leverage,trade_mode='Both',
                            min_tick=request.tick_size,min_tick_unit='price')
            result=run_backtest(frame,config,start=pd.Timestamp(self.trading_from,unit='s',tz='UTC'),bar_seconds=duration)
            signal=result['bars'].iloc[-1]
            simulated=result['open_position']
            self._apply_bar(exchange,market,venue,request,signal,simulated,float(row.close))
            with self.lock:
                self.frame=frame
                self.last_processed=int(stamp.timestamp())
                self.strategy_state=self._strategy_state(signal,request,simulated,float(row.close),int(stamp.timestamp()))

    def _strategy_state(self, signal, request, simulated, close, timestamp):
        live=self.position
        close_state=None
        if live:
            distance=(close-float(live['stop'])) if live['direction']=='long' else (float(live['stop'])-close)
            close_state=dict(direction=live['direction'],entryPrice=float(live['entryPrice']),stop=float(live['stop']),
                             stopDistance=max(0.,float(distance)),trailingActive=bool(simulated and simulated.get('trailing_active')))
        return dict(status='position_open' if live else 'scanning',timestamp=timestamp,close=float(close),
                    closeState=close_state,**strategy_readiness(signal,request.bb_reversal,
                    rsi(self.frame.tail(500),14)[-1] if self.frame is not None and len(self.frame) else None))

    def _apply_bar(self,exchange,market,venue,request,signal,simulated,close):
        signal_direction=1 if bool(signal.long_signal) else -1 if bool(signal.short_signal) else 0
        live=self.position
        if signal_direction:
            if live:
                self._close(exchange,market,venue,live)
                live=None
            self._open(exchange,market,venue,request,signal_direction,simulated,close)
            return
        if live and simulated is None:
            self._close(exchange,market,venue,live)
            return
        if live and simulated is not None:
            self._trail(exchange,market,venue,live,simulated,close)

    def _available_usdt(self,exchange):
        balance=self.service.account_balance(exchange, exchange.id)
        value=(balance.get('free') or {}).get('USDT')
        if value is None:
            raise ValueError('The exchange did not provide available USDT margin. Live sizing cannot use the total wallet balance.')
        available=float(value)
        if not math.isfinite(available) or available <= 0:
            raise ValueError('Available USDT margin must be positive before starting or opening a live trade')
        return available

    def _open(self,exchange,market,venue,request,direction,simulated,close):
        available=self._available_usdt(exchange)
        config=request.bb_reversal
        allocation=(available*config.get('amount_per_trade',100)/100 if config.get('amount_unit','percent')=='percent'
                    else min(float(config.get('amount_per_trade',available)),available))
        quantity=allocation*request.max_leverage/close
        side='long' if direction==1 else 'short'
        stop=close+(float(simulated['stop'])-float(simulated['entry_price']))
        result=self.service.open_with_stop(venue,side,quantity,stop)
        position=dict(direction=side,quantity=result['quantity'],entryPrice=result.get('entryPrice') or close,
                      stop=stop,stopOrderId=result['protectiveStop'].get('id'))
        with self.lock:self.position=position
        self._event('open',direction=side,quantity=position['quantity'],price=position['entryPrice'],stop=stop)

    def _close(self,exchange,market,venue,position):
        side='sell' if position['direction']=='long' else 'buy'
        self.service.market_order(venue,side,position['quantity'],reduce_only=True)
        stop_id=position.get('stopOrderId')
        if stop_id:
            try:self.service.cancel_stop(venue,stop_id)
            except Exception:pass
        with self.lock:self.position=None
        self._event('close',direction=position['direction'],quantity=position['quantity'],entryPrice=position.get('entryPrice'))

    def _trail(self,exchange,market,venue,position,simulated,close):
        offset=float(simulated['stop'])-float(simulated['entry_price'])
        desired=float(position['entryPrice'])+offset
        old=float(position['stop'])
        tighter=desired>old if position['direction']=='long' else desired<old
        if not tighter:return
        ticker=exchange.fetch_ticker(market['symbol'])
        last=float(ticker.get('last') or close)
        crossed=(desired>=last if position['direction']=='long' else desired<=last)
        if crossed:
            self._close(exchange,market,venue,position)
            return
        new_stop=self.service.set_stop(venue,position['direction'],position['quantity'],desired)
        old_id=position.get('stopOrderId')
        if old_id:
            try:self.service.cancel_stop(venue,old_id)
            except Exception:
                try:self.service.cancel_stop(venue,new_stop['id'])
                except Exception:pass
                raise RuntimeError('Could not replace the trailing stop; exchange state needs manual review')
        with self.lock:
            position['stop']=new_stop['triggerPrice']
            position['stopOrderId']=new_stop.get('id')
        self._event('trail',direction=position['direction'],stop=position['stop'])

    def stop(self):
        with self.lock:
            self.running=False
            self.stop_event.set()
        self._event('stop')
        result=self.status()
        result['message']='Automation stopped. Any open position and its exchange hosted stop remain active; manage them at the exchange or close from this terminal.'
        return result


live_exchange = LiveExchange()
live_bot = AutomaticLiveBot(live_exchange)
live_exchange.auto_bot = live_bot

"""Shared exchange WebSocket feeds, forwarded to local browsers as SSE."""
import asyncio
import base64
import gzip
import hashlib
import hmac
import json
import time
from datetime import datetime, timezone
from urllib.parse import urlencode

import aiohttp
import ccxt.pro as ccxtpro

from server.exchanges.live_exchange import LiveExchange, VENUES
from server.exchanges.htx_account import normalize_htx_balance


def classic_auth(api_key: str, secret: str, timestamp: str) -> dict:
    params = dict(AccessKeyId=api_key, SignatureMethod='HmacSHA256',
                  SignatureVersion='2', Timestamp=timestamp)
    payload = 'GET\napi.hbdm.com\n/linear-swap-notification\n' + urlencode(sorted(params.items()))
    signature = base64.b64encode(hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest()).decode()
    return dict(op='auth', type='api', **params, Signature=signature)


def position_view(position: dict, contract_size: float) -> dict:
    return dict(side=position.get('side'),
                quantity=abs(float(position.get('contracts') or 0)) * contract_size,
                **{key: position.get(key) for key in ('entryPrice', 'markPrice', 'unrealizedPnl',
                    'leverage', 'liquidationPrice', 'marginMode', 'initialMargin', 'percentage')})


def order_view(order: dict, contract_size: float) -> dict:
    return dict(id=order.get('id'), side=order.get('side'), type=order.get('type'),
                price=order.get('price'), triggerPrice=order.get('triggerPrice') or order.get('stopPrice'),
                quantity=None if order.get('amount') is None else float(order['amount']) * contract_size,
                filled=None if order.get('filled') is None else float(order['filled']) * contract_size,
                status=order.get('status'))


class ExchangeFeed:
    def __init__(self, service: LiveExchange, venue: str):
        self.service, self.venue = service, venue
        self.source, self.market = service._get(venue)
        self.state = dict(venue=venue, symbol=self.market['symbol'], market=None, balance=None,
                          positions=None, orders=None, candle=None, errors={},
                          streams={'market': 'connecting', 'account': 'connecting'}, sectionTimes={})
        self.changed = asyncio.Event()
        self.account_changed = asyncio.Event()
        self.queues: set[asyncio.Queue] = set()
        self.client = None
        self.tasks: list[asyncio.Task] = []
        self.runner = asyncio.create_task(self.run())

    def update(self, section: str, value) -> None:
        self.state[section] = value
        self.state['errors'].pop(section, None)
        self.state['sectionTimes'][section] = time.time() * 1000
        self.changed.set()

    def stream_status(self, section: str, status: str) -> None:
        self.state['streams'][section] = status
        self.changed.set()

    async def run(self) -> None:
        try:
            initial = await asyncio.to_thread(self.service.overview, self.venue)
            self.state['executionError'] = initial.get('executionError')
            for section in ('market', 'balance', 'positions', 'orders'):
                if section in initial['errors']:
                    self.state['errors'][section] = initial['errors'][section]
                else:
                    self.update(section, initial[section])
            self.client = getattr(ccxtpro, VENUES[self.venue])(dict(
                apiKey=self.source.apiKey, secret=self.source.secret, password=self.source.password,
                enableRateLimit=True, options=dict(self.source.options), newUpdates=True))
            # Share market metadata, never the synchronous client's network session.
            self.client.set_markets(self.source.markets, self.source.currencies)
            self.tasks = [asyncio.create_task(self.watch(section)) for section in ('market', 'candle')]
            if self.venue == 'htx' and self.source.options.get('localAccountApi') == 'classic':
                self.tasks.append(asyncio.create_task(self.classic_private()))
            else:
                self.tasks.extend(asyncio.create_task(self.watch(section)) for section in ('balance', 'positions', 'orders'))
            self.tasks.append(asyncio.create_task(self.reconcile()))
            await self.publish()
        except asyncio.CancelledError:
            raise
        except Exception:
            self.state['errors']['connection'] = 'Exchange stream could not start. Reconnect the account.'
            self.changed.set()
            await self.publish()
        finally:
            for task in self.tasks:
                task.cancel()
            await asyncio.gather(*self.tasks, return_exceptions=True)
            if self.client is not None:
                await self.client.close()

    async def watch(self, section: str) -> None:
        methods = dict(market='watchTicker', candle='watchOHLCV',
                       balance='watchBalance', positions='watchPositions', orders='watchOrders')
        # HTX implements watch_positions but omits its capability flag in some releases.
        supported = self.client.has.get(methods[section]) or (self.venue == 'htx' and section == 'positions')
        if not supported:
            self.state['errors'][section + 'Stream'] = f'{section.capitalize()} streaming is unavailable for this exchange.'
            self.changed.set()
            return
        size = float(self.market.get('contractSize') or 1)
        symbol = self.market['symbol']
        positions = {(p.get('side'), p.get('marginMode')): p for p in self.state.get('positions') or []}
        orders = {o['id']: o for o in self.state.get('orders') or []}
        delay = 1
        while True:
            try:
                if section == 'market':
                    ticker = await self.client.watch_ticker(symbol)
                    values = dict(self.state['market'] or {})
                    values.update({key: ticker[key] for key in ('last', 'bid', 'ask', 'high', 'low', 'percentage', 'quoteVolume', 'timestamp') if ticker.get(key) is not None})
                    self.update('market', values)
                    self.stream_status('market', 'live')
                elif section == 'candle':
                    candles = await self.client.watch_ohlcv(symbol, '1m')
                    if candles:
                        self.update('candle', candles[-1][:6])
                elif section == 'balance':
                    balance = await self.client.watch_balance({'type': 'swap', 'subType': 'linear'})
                    if self.venue == 'htx':
                        balance = normalize_htx_balance(balance)
                    value = {key: balance.get(key, {}).get('USDT') for key in ('total', 'free', 'used')}
                    if value['free'] is None:
                        self.account_changed.set()
                    previous = self.state.get('balance') or {}
                    value = {key: field if field is not None else previous.get(key) for key, field in value.items()}
                    if value['total'] is None:
                        self.account_changed.set()
                    else:
                        self.update(section, value)
                        self.stream_status('account', 'live')
                elif section == 'positions':
                    updates = await self.client.watch_positions([symbol])
                    positions = {(p.get('side'), p.get('marginMode')): p for p in self.state.get('positions') or []}
                    if not updates:
                        positions.clear()
                    for p in updates:
                        if p.get('symbol') == symbol:
                            key = (p.get('side'), p.get('marginMode'))
                            if float(p.get('contracts') or 0) == 0:
                                positions.pop(key, None)
                            else:
                                positions[key] = position_view(p, size)
                    self.update(section, list(positions.values()))
                    self.stream_status('account', 'live')
                else:
                    updates = await self.client.watch_orders(symbol)
                    orders = {o['id']: o for o in self.state.get('orders') or []}
                    for order in updates:
                        if order.get('symbol') == symbol:
                            if order.get('status') in ('closed', 'canceled', 'expired', 'rejected'):
                                orders.pop(order['id'], None)
                            else:
                                orders[order['id']] = order_view(order, size)
                    self.update(section, list(orders.values()))
                    self.stream_status('account', 'live')
                self.state['errors'].pop(section + 'Stream', None)
                delay = 1
            except asyncio.CancelledError:
                raise
            except Exception:
                self.state['errors'][section + 'Stream'] = f'{section.capitalize()} stream interrupted; reconnecting automatically.'
                self.stream_status('market' if section in ('market', 'candle') else 'account', 'reconnecting')
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30)

    async def classic_private(self) -> None:
        # Classic HTX pushes account changes on a different socket from V5.
        # Reconcile on notifications rather than assuming cached positions are complete.
        delay = 1
        topics = ('accounts.*', 'accounts_cross.*', 'positions.*', 'positions_cross.*',
                  'orders.' + self.market['id'], 'orders_cross.' + self.market['id'])
        while True:
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.ws_connect('wss://api.hbdm.com/linear-swap-notification',
                                                  receive_timeout=45) as socket:
                        timestamp = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S')
                        await socket.send_json(classic_auth(self.source.apiKey, self.source.secret, timestamp))
                        authenticated = False
                        subscribed = set()
                        async for packet in socket:
                            if packet.type == aiohttp.WSMsgType.BINARY:
                                message = json.loads(gzip.decompress(packet.data))
                            elif packet.type == aiohttp.WSMsgType.TEXT:
                                message = json.loads(packet.data)
                            else:
                                break
                            if message.get('op') == 'ping':
                                await socket.send_json({'op': 'pong', 'ts': message['ts']})
                            elif message.get('op') == 'auth':
                                if int(message.get('err-code', 0)) != 0:
                                    raise ValueError('Private WebSocket authentication failed')
                                authenticated = True
                                for topic in topics:
                                    await socket.send_json({'op': 'sub', 'topic': topic})
                            elif message.get('op') == 'sub':
                                if int(message.get('err-code', 0)) != 0:
                                    raise ValueError('Private WebSocket subscription failed')
                                subscribed.add(str(message.get('topic', '')).lower())
                                if subscribed.issuperset(topic.lower() for topic in topics):
                                    self.state['errors'].pop('accountStream', None)
                                    self.stream_status('account', 'live')
                                    delay = 1
                                    self.account_changed.set()
                            elif authenticated and message.get('op') == 'notify':
                                self.account_changed.set()
                            elif message.get('op') in ('error', 'close'):
                                raise ConnectionError('Private WebSocket reported an error')
                        raise ConnectionError('Private WebSocket closed')
            except asyncio.CancelledError:
                raise
            except Exception:
                self.state['errors']['accountStream'] = 'Account stream interrupted; reconnecting automatically. Account snapshots continue to reconcile.'
                self.stream_status('account', 'reconnecting')
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30)

    async def reconcile(self) -> None:
        while True:
            try:
                await asyncio.wait_for(self.account_changed.wait(), timeout=30)
            except asyncio.TimeoutError:
                pass
            self.account_changed.clear()
            await asyncio.sleep(0.3)
            # Keep positions/orders authoritative after reconnects and missed events.
            snapshot = await asyncio.to_thread(self.service.overview, self.venue)
            for section in ('balance', 'positions', 'orders'):
                if section in snapshot['errors']:
                    self.state['errors'][section] = snapshot['errors'][section]
                    self.changed.set()
                else:
                    self.update(section, snapshot[section])

    async def publish(self) -> None:
        while True:
            try:
                await asyncio.wait_for(self.changed.wait(), timeout=10)
            except asyncio.TimeoutError:
                pass
            self.changed.clear()
            disconnected = self.service.clients.get(self.venue) is not self.source
            if disconnected:
                self.state['errors']['connection'] = 'Exchange disconnected or credentials changed. Reconnect to continue.'
                self.state['streams'] = {'market': 'disconnected', 'account': 'disconnected'}
            payload = json.dumps(dict(self.state, updatedAt=time.time() * 1000), allow_nan=False)
            for queue in tuple(self.queues):
                if queue.full():
                    queue.get_nowait()
                queue.put_nowait(payload)
            if disconnected:
                return
            await asyncio.sleep(0.1)


class ExchangeStreams:
    def __init__(self, service: LiveExchange):
        self.service = service
        self.feeds: dict[str, ExchangeFeed] = {}

    async def events(self, venue: str):
        source, _ = self.service._get(venue)
        feed = self.feeds.get(venue)
        if feed is None or feed.source is not source:
            feed = ExchangeFeed(self.service, venue)
            self.feeds[venue] = feed
        queue = asyncio.Queue(maxsize=1)
        feed.queues.add(queue)
        feed.changed.set()
        try:
            yield 'retry: 2000\n\n'
            # Send metadata immediately: account REST initialization can take
            # several network requests and must not gate chart history loading.
            yield 'data: ' + json.dumps(dict(feed.state, updatedAt=time.time() * 1000), allow_nan=False) + '\n\n'
            while True:
                yield 'data: ' + await queue.get() + '\n\n'
                if self.service.clients.get(venue) is not source:
                    return
        finally:
            feed.queues.discard(queue)
            if not feed.queues:
                feed.runner.cancel()
                await asyncio.gather(feed.runner, return_exceptions=True)
                if self.feeds.get(venue) is feed:
                    self.feeds.pop(venue, None)

    async def close(self) -> None:
        tasks = [feed.runner for feed in self.feeds.values()]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.feeds.clear()

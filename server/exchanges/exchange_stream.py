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
                marginMode=order.get('marginMode') or (order.get('info') or {}).get('margin_mode'),
                price=order.get('price'), triggerPrice=order.get('triggerPrice') or order.get('stopPrice'),
                quantity=None if order.get('amount') is None else float(order['amount']) * contract_size,
                filled=None if order.get('filled') is None else float(order['filled']) * contract_size,
                status=order.get('status'))


BOOK_DEPTH = 50
TRADE_HISTORY = 40


def book_view(book: dict, contract_size: float, depth: int = BOOK_DEPTH) -> dict:
    """Top price levels per side as [price, base quantity]; contracts converted to base units."""
    def side(levels):
        return [[float(level[0]), float(level[1]) * contract_size]
                for level in (levels or [])[:depth]
                if level and level[0] is not None and level[1] is not None]
    return dict(bids=side(book.get('bids')), asks=side(book.get('asks')), timestamp=book.get('timestamp'))


def trade_view(trade: dict, contract_size: float) -> dict:
    return dict(id=trade.get('id'), side=trade.get('side'), price=trade.get('price'),
                quantity=None if trade.get('amount') is None else float(trade['amount']) * contract_size,
                timestamp=trade.get('timestamp'))


def fill_day_stats(values: dict, previous_close, day_range) -> dict:
    """Complete 24h change / high / low when the exchange ticker omits them (e.g. Hyperliquid)."""
    last = values.get('last')
    if last is None:
        return values
    if values.get('percentage') is None and previous_close:
        values['percentage'] = (float(last) / float(previous_close) - 1) * 100
    if day_range:
        high, low = day_range
        values['high'] = max(high, float(last)) if values.get('high') is None else values['high']
        values['low'] = min(low, float(last)) if values.get('low') is None else values['low']
    return values


DEPTH_SECTIONS = ('orderBook', 'trades')
def apply_bbo(view: dict, bid: list | None, ask: list | None, timestamp=None) -> dict:
    """Refresh the top of a slower full-book snapshot from a fast best bid/offer update."""
    bids, asks = list(view.get('bids') or []), list(view.get('asks') or [])
    if bid:
        bids = [bid] + [level for level in bids if level[0] < bid[0]]
    if ask:
        asks = [ask] + [level for level in asks if level[0] > ask[0]]
    return dict(bids=bids, asks=asks, timestamp=timestamp or view.get('timestamp'))


RECONCILE_SECONDS = 5
POSITION_RECONCILE_SECONDS = 2


class ExchangeFeed:
    def __init__(self, service: LiveExchange, venue: str):
        self.service, self.venue = service, venue
        self.source, self.market = service._get(venue)
        self.state = dict(venue=venue, symbol=self.market['symbol'], market=None, balance=None,
                          positions=None, orders=None, conditionalOrders=None, candle=None, errors={},
                          streams={'market': 'connecting', 'account': 'connecting'}, sectionTimes={})
        self.changed = asyncio.Event()
        self.account_changed = asyncio.Event()
        self.position_changed = asyncio.Event()
        self.position_burst_until = 0.0
        self.loop = asyncio.get_running_loop()
        self.queues: set[asyncio.Queue] = set()
        # Order book / trades are watched only while a browser panel shows them.
        self.depth: dict[str, object] = {}
        self.depth_queues: dict[str, set[asyncio.Queue]] = {'orderBook': set(), 'trades': set()}
        self.depth_tasks: dict[str, asyncio.Task] = {}
        self.ready = asyncio.Event()
        self.previous_close = None
        self.day_range: tuple[float, float] | None = None
        self.client = None
        self.tasks: list[asyncio.Task] = []
        self.runner = asyncio.create_task(self.run())

    def update(self, section: str, value) -> None:
        if section in DEPTH_SECTIONS:
            self.depth[section] = value
            payload = json.dumps(value, allow_nan=False)
            for queue in tuple(self.depth_queues[section]):
                if queue.full():
                    queue.get_nowait()
                queue.put_nowait(payload)
            return
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
            credentials = (dict(walletAddress=self.source.walletAddress, privateKey=self.source.privateKey)
                           if self.venue == 'hyperliquid' else
                           dict(apiKey=self.source.apiKey, secret=self.source.secret, password=self.source.password))
            self.client = getattr(ccxtpro, VENUES[self.venue])(dict(
                **credentials, enableRateLimit=True, options=dict(self.source.options), newUpdates=True))
            # Share market metadata, never the synchronous client's network session.
            self.client.set_markets(self.source.markets, self.source.currencies)
            self.tasks = [asyncio.create_task(self.watch(section)) for section in ('market', 'candle', 'lastTrade')]
            self.tasks.append(asyncio.create_task(self.track_day_range()))
            if self.venue == 'htx' and self.source.options.get('localAccountApi') == 'classic':
                self.tasks.append(asyncio.create_task(self.classic_private()))
            else:
                self.tasks.extend(asyncio.create_task(self.watch(section)) for section in ('balance', 'positions', 'orders'))
            self.tasks.append(asyncio.create_task(self.reconcile()))
            self.tasks.append(asyncio.create_task(self.reconcile_positions()))
            self.account_changed.set()
            self.ready.set()
            for section, queues in self.depth_queues.items():
                if queues:
                    self.start_depth(section)
            await self.publish()
        except asyncio.CancelledError:
            raise
        except Exception:
            self.state['errors']['connection'] = 'Exchange stream could not start. Reconnect the account.'
            self.changed.set()
            await self.publish()
        finally:
            depth = list(self.depth_tasks.values())
            self.depth_tasks.clear()
            for task in self.tasks + depth:
                task.cancel()
            await asyncio.gather(*self.tasks, *depth, return_exceptions=True)
            if self.client is not None:
                await self.client.close()

    async def track_day_range(self) -> None:
        """24h high/low from hourly candles for exchanges whose ticker omits them; refreshed each minute."""
        symbol = self.market['symbol']
        while True:
            try:
                market = self.state.get('market') or {}
                if market.get('high') is None or self.day_range is not None:
                    since = int((time.time() - 24 * 3600) * 1000)
                    candles = await self.client.fetch_ohlcv(symbol, '1h', since=since, limit=25)
                    rows = [row for row in candles if row[0] >= since - 3600 * 1000]
                    if rows:
                        self.day_range = (max(float(row[2]) for row in rows), min(float(row[3]) for row in rows))
                        values = dict(self.state.get('market') or {})
                        if values.get('last') is not None:
                            values.pop('high', None)
                            values.pop('low', None)
                            self.update('market', fill_day_stats(values, self.previous_close, self.day_range))
                await asyncio.sleep(60)
            except asyncio.CancelledError:
                raise
            except Exception:
                await asyncio.sleep(60)

    def start_depth(self, section: str) -> None:
        if self.ready.is_set() and section not in self.depth_tasks:
            self.depth_tasks[section] = asyncio.create_task(self.watch(section))
            # Hyperliquid pushes full books only every few seconds but best bid/offer on every change.
            if section == 'orderBook' and self.venue == 'hyperliquid':
                self.depth_tasks['orderBookBbo'] = asyncio.create_task(self.hyperliquid_bbo())

    async def hyperliquid_bbo(self) -> None:
        url = self.client.urls['api']['ws']['public']
        coin = self.market.get('baseName') or self.market.get('base')
        size = float(self.market.get('contractSize') or 1)
        delay = 1
        while True:
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.ws_connect(url, heartbeat=30, receive_timeout=60) as socket:
                        await socket.send_json({'method': 'subscribe', 'subscription': {'type': 'bbo', 'coin': coin}})
                        async for packet in socket:
                            if packet.type != aiohttp.WSMsgType.TEXT:
                                break
                            message = json.loads(packet.data)
                            if message.get('channel') != 'bbo':
                                continue
                            delay = 1
                            data = message.get('data') or {}
                            levels = data.get('bbo') or [None, None]
                            bid, ask = ([float(level['px']), float(level['sz']) * size] if level else None
                                        for level in (levels + [None, None])[:2])
                            current = self.depth.get('orderBook')
                            if current:
                                self.update('orderBook', apply_bbo(current, bid, ask, data.get('time')))
                        raise ConnectionError('Hyperliquid bbo stream closed')
            except asyncio.CancelledError:
                raise
            except Exception:
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30)

    def add_depth(self, section: str, queue: asyncio.Queue) -> None:
        self.depth_queues[section].add(queue)
        self.start_depth(section)

    def remove_depth(self, section: str, queue: asyncio.Queue) -> None:
        self.depth_queues[section].discard(queue)
        if not self.depth_queues[section]:
            for key in (section, section + 'Bbo'):
                task = self.depth_tasks.pop(key, None)
                if task:
                    task.cancel()
            self.depth.pop(section, None)

    async def watch(self, section: str) -> None:
        methods = dict(market='watchTicker', candle='watchOHLCV', orderBook='watchOrderBook', trades='watchTrades', lastTrade='watchTrades',
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
                    fields = {key: ticker[key] for key in ('last', 'bid', 'ask', 'high', 'low', 'percentage', 'quoteVolume', 'timestamp') if ticker.get(key) is not None}
                    if (fields.get('timestamp') or 0) < (values.get('timestamp') or 0):
                        # A newer trade already set the last price; keep it.
                        fields.pop('last', None)
                        fields.pop('timestamp', None)
                    values.update(fields)
                    if ticker.get('previousClose'):
                        self.previous_close = ticker['previousClose']
                    if ticker.get('high') is None:
                        values.pop('high', None)
                        values.pop('low', None)
                    self.update('market', fill_day_stats(values, self.previous_close, self.day_range))
                    self.stream_status('market', 'live')
                elif section == 'candle':
                    candles = await self.client.watch_ohlcv(symbol, '1m')
                    if candles:
                        self.update('candle', candles[-1][:6])
                elif section == 'lastTrade':
                    # Every trade moves the chart's last price immediately; tickers can lag (HTX ~1/10 s).
                    updates = await self.client.watch_trades(symbol)
                    latest = max((t for t in updates if t.get('price') is not None),
                                 key=lambda t: t.get('timestamp') or 0, default=None)
                    if latest is not None:
                        values = dict(self.state['market'] or {})
                        if latest.get('timestamp') and latest['timestamp'] >= (values.get('timestamp') or 0):
                            values.update(last=float(latest['price']), timestamp=latest['timestamp'])
                            if self.day_range:
                                values.pop('high', None)
                                values.pop('low', None)
                            values.pop('percentage', None) if self.previous_close else None
                            self.update('market', fill_day_stats(values, self.previous_close, self.day_range))
                            self.stream_status('market', 'live')
                elif section == 'orderBook':
                    book = await self.client.watch_order_book(symbol)
                    self.update('orderBook', book_view(book, size))
                elif section == 'trades':
                    updates = await self.client.watch_trades(symbol)
                    fresh = [trade_view(trade, size) for trade in sorted(updates, key=lambda t: t.get('timestamp') or 0, reverse=True)]
                    self.update('trades', (fresh + list(self.depth.get('trades') or []))[:TRADE_HISTORY])
                elif section == 'balance':
                    balance = await self.client.watch_balance({'type': 'swap', 'subType': 'linear'})
                    if self.venue == 'htx':
                        balance = normalize_htx_balance(balance)
                    collateral = self.market.get('settle') or self.market.get('quote') or 'USDT'
                    value = {key: balance.get(key, {}).get(collateral) for key in ('total', 'free', 'used')}
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
                self.stream_status('market' if section in ('market', 'candle', 'orderBook', 'trades', 'lastTrade') else 'account', 'reconnecting')
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
                                self.position_changed.set()
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

    async def refresh_section(self, section: str) -> None:
        snapshot = await asyncio.to_thread(self.service.overview, self.venue, sections=(section,))
        if section in snapshot['errors']:
            self.state['errors'][section] = snapshot['errors'][section]
            self.changed.set()
        else:
            self.update(section, snapshot[section])

    async def reconcile_positions(self) -> None:
        # One worker prevents overlapping polls; balance/orders never block it.
        while True:
            interval = 0.5 if self.loop.time() < self.position_burst_until else POSITION_RECONCILE_SECONDS
            try:
                await asyncio.wait_for(self.position_changed.wait(), timeout=interval)
            except asyncio.TimeoutError:
                pass
            self.position_changed.clear()
            await self.refresh_section('positions')

    async def reconcile(self) -> None:
        while True:
            try:
                await asyncio.wait_for(self.account_changed.wait(), timeout=RECONCILE_SECONDS)
            except asyncio.TimeoutError:
                pass
            self.account_changed.clear()
            for section in ('orders', 'balance', 'conditionalOrders'):
                await self.refresh_section(section)

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
        self.service.on_execution = self.refresh

    def _feed(self, venue: str) -> ExchangeFeed:
        source, _ = self.service._get(venue)
        feed = self.feeds.get(venue)
        if feed is None or feed.source is not source:
            feed = ExchangeFeed(self.service, venue)
            self.feeds[venue] = feed
        return feed

    async def _release(self, venue: str, feed: ExchangeFeed) -> None:
        if not feed.queues and not any(feed.depth_queues.values()):
            feed.runner.cancel()
            await asyncio.gather(feed.runner, return_exceptions=True)
            if self.feeds.get(venue) is feed:
                self.feeds.pop(venue, None)

    async def depth_events(self, venue: str, section: str):
        """Order book or trades only, and only while this subscriber is connected."""
        feed = self._feed(venue)
        source = feed.source
        queue = asyncio.Queue(maxsize=1)
        feed.add_depth(section, queue)
        try:
            yield 'retry: 2000\n\n'
            if section in feed.depth:
                yield 'data: ' + json.dumps(feed.depth[section], allow_nan=False) + '\n\n'
            while True:
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ': keep-alive\n\n'
                else:
                    yield 'data: ' + payload + '\n\n'
                if self.service.clients.get(venue) is not source:
                    return
        finally:
            feed.remove_depth(section, queue)
            await self._release(venue, feed)

    async def events(self, venue: str):
        feed = self._feed(venue)
        source = feed.source
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
            await self._release(venue, feed)

    def refresh(self, venue: str) -> None:
        """Wake account refresh and briefly accelerate position polling after execution."""
        feed = self.feeds.get(venue)
        if feed is None:
            return
        def wake() -> None:
            feed.position_burst_until = feed.loop.time() + 5
            feed.position_changed.set()
            feed.account_changed.set()
        try:
            feed.loop.call_soon_threadsafe(wake)
        except RuntimeError:
            # A completed order must still succeed if the stream is shutting down.
            pass

    async def close(self) -> None:
        tasks = [feed.runner for feed in self.feeds.values()]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.feeds.clear()

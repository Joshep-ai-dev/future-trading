"""Public (no credentials) real-time market data for paper trading, shared by every user.

`BroadcastStream` holds the subscriber plumbing: one upstream connection per market, opened only
while a browser listens and limited to the kinds currently wanted, fanned out as server-sent events.
`VenueMarketStream` reads any downloaded exchange market (HTX, Hyperliquid, ...) through ccxt.pro;
`server.market.okx_public_stream` reads OKX XAG directly. Sizes are published in base units.
"""
import asyncio
import json
import math
import threading
import time

from server.exchanges.exchange_stream import TRADE_HISTORY, book_view, trade_view

KINDS = ('ticker', 'orderBook', 'trades')


class BroadcastStream:
    """Fan-out of the latest ticker / order book / trades to SSE subscribers; subclasses implement `run`."""

    def __init__(self):
        self.queues: dict[str, set[asyncio.Queue]] = {kind: set() for kind in KINDS}
        self.latest: dict[str, object] = {}
        self.task: asyncio.Task | None = None
        # Cancelled upstream tasks still closing their connection; awaited on shutdown.
        self.stopping: set[asyncio.Task] = set()
        self.subscribed: frozenset[str] = frozenset()

    def wanted(self) -> frozenset[str]:
        return frozenset(kind for kind, queues in self.queues.items() if queues)

    def publish(self, kind: str, value) -> None:
        self.latest[kind] = value
        payload = json.dumps(value, allow_nan=False)
        for queue in tuple(self.queues[kind]):
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(payload)

    def refresh(self) -> None:
        """(Re)connect with exactly the wanted kinds, or stop when nothing is wanted."""
        wanted = self.wanted()
        if wanted == self.subscribed and self.task and not self.task.done():
            return
        if self.task:
            self.task.cancel()
            self.stopping.add(self.task)
            self.task.add_done_callback(self.stopping.discard)
        self.task = None
        self.subscribed = wanted
        for kind in set(self.latest) - wanted:
            self.latest.pop(kind, None)
        if wanted:
            self.task = asyncio.create_task(self.run(wanted))

    async def run(self, kinds: frozenset[str]) -> None:
        raise NotImplementedError

    async def events(self, kind: str):
        queue: asyncio.Queue = asyncio.Queue(maxsize=1)
        self.queues[kind].add(queue)
        self.refresh()
        try:
            yield 'retry: 2000\n\n'
            if kind in self.latest:
                yield 'data: ' + json.dumps(self.latest[kind], allow_nan=False) + '\n\n'
            while True:
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ': keep-alive\n\n'
                else:
                    yield 'data: ' + payload + '\n\n'
        finally:
            self.queues[kind].discard(queue)
            self.refresh()

    async def close(self) -> None:
        for queues in self.queues.values():
            queues.clear()
        if self.task:
            self.task.cancel()
            self.stopping.add(self.task)
        await asyncio.gather(*self.stopping, return_exceptions=True)
        self.stopping.clear()
        self.task = None


class VenueMarketStream(BroadcastStream):
    """Public ccxt.pro WebSocket streams for one downloaded exchange market."""

    def __init__(self, venue: str, symbol: str):
        super().__init__()
        self.venue, self.symbol = venue, symbol

    def client(self):
        import ccxt.pro as ccxtpro
        from server.exchanges.live_exchange import VENUES
        from server.market.dataset_sync import public_exchange
        source = public_exchange(self.venue)  # Cached market metadata, no network session shared.
        client = getattr(ccxtpro, VENUES[self.venue])(dict(enableRateLimit=True, newUpdates=True, options=dict(source.options)))
        client.set_markets(source.markets, source.currencies)
        return client

    async def run(self, kinds: frozenset[str]) -> None:
        client = await asyncio.to_thread(self.client)
        size = float(client.market(self.symbol).get('contractSize') or 1)
        try:
            await asyncio.gather(*(self.watch(client, kind, size) for kind in kinds))
        finally:
            await client.close()

    async def watch(self, client, kind: str, size: float) -> None:
        if kind == 'trades' and 'trades' not in self.latest:
            # Trade streams only push new trades: start from recent history.
            try:
                recent = await client.fetch_trades(self.symbol, limit=TRADE_HISTORY)
                self.publish('trades', [trade_view(trade, size) for trade in sorted(recent, key=lambda t: t.get('timestamp') or 0, reverse=True)])
            except Exception:
                pass
        delay = 1
        while True:
            try:
                if kind == 'orderBook':
                    self.publish('orderBook', book_view(await client.watch_order_book(self.symbol), size))
                elif kind == 'trades':
                    updates = await client.watch_trades(self.symbol)
                    fresh = [trade_view(trade, size) for trade in sorted(updates, key=lambda t: t.get('timestamp') or 0, reverse=True)]
                    self.publish('trades', (fresh + list(self.latest.get('trades') or []))[:TRADE_HISTORY])
                else:
                    ticker = await client.watch_ticker(self.symbol)
                    if ticker.get('last') is not None:
                        # Some venues (e.g. Hyperliquid mids) omit the timestamp; the chart buckets ticks by it.
                        fields = ('last', 'percentage', 'high', 'low', 'baseVolume', 'quoteVolume')
                        values = {key: ticker[key] for key in fields
                                  if isinstance(ticker.get(key), (int, float)) and math.isfinite(ticker[key])}
                        self.publish('ticker', dict(symbol=self.symbol,
                                                   timestamp=ticker.get('timestamp') or int(time.time()*1000),
                                                   **values))
                delay = 1
            except asyncio.CancelledError:
                raise
            except Exception:
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30)


class PublicStreams:
    """Shared streams for downloaded markets and public OKX perpetuals."""

    def __init__(self):
        self.streams: dict[str, VenueMarketStream] = {}
        self.lock = threading.Lock()

    def get(self, market: str) -> VenueMarketStream:
        from server.market.datasets import list_datasets
        with self.lock:
            stream = self.streams.get(market)
            if stream is None:
                dataset = next((row for row in list_datasets() if row['id'] == market), None)
                if dataset is None:
                    raise ValueError('Download this market from its exchange first')
                stream = self.streams[market] = VenueMarketStream(dataset['venue'], dataset['symbol'])
            return stream

    def get_okx(self, symbol: str) -> VenueMarketStream:
        from server.exchanges.market_catalog import market_catalog
        key = f'okx:{symbol}'
        with self.lock:
            stream = self.streams.get(key)
            if stream is None:
                if not any(market['id'] == symbol for market in market_catalog('okx')):
                    raise ValueError('Choose an active OKX linear perpetual market.')
                stream = self.streams[key] = VenueMarketStream('okx', symbol)
            return stream

    async def close(self) -> None:
        await asyncio.gather(*(stream.close() for stream in list(self.streams.values())), return_exceptions=True)
        self.streams.clear()


public_streams = PublicStreams()

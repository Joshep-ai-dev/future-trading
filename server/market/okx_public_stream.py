"""Real-time public OKX XAG-USDT-SWAP data (ticker, order book, trades) for paper trading.

One shared WebSocket, opened only while a browser subscribes and subscribed only
to the channels currently wanted. No credentials. Sizes are converted from
contracts to XAG with the instrument's contract value.
"""
import asyncio
import json
import time

import aiohttp

from server.exchanges.exchange_stream import BOOK_DEPTH, TRADE_HISTORY, trade_view
from server.market.public_book import INSTRUMENT, SYMBOL, contract_value, public_order_book

URL = 'wss://ws.okx.com/ws/v5/public'
CHANNELS = {'ticker': 'tickers', 'orderBook': 'books', 'trades': 'trades'}


class LocalBook:
    """OKX ``books`` channel: a snapshot followed by incremental updates (size 0 removes a level)."""

    def __init__(self):
        self.bids: dict[float, float] = {}
        self.asks: dict[float, float] = {}
        self.seq: int | None = None
        self.timestamp: int | None = None

    def apply(self, action: str, item: dict) -> bool:
        """Returns False when a sequence gap means the book must be resubscribed."""
        if action == 'snapshot':
            self.bids, self.asks = {}, {}
        elif self.seq is None or int(item.get('prevSeqId', -1)) != self.seq:
            return False
        for side, levels in ((self.bids, item.get('bids', [])), (self.asks, item.get('asks', []))):
            for level in levels:
                price, size = float(level[0]), float(level[1])
                if size == 0:
                    side.pop(price, None)
                else:
                    side[price] = size
        self.seq = int(item['seqId']) if item.get('seqId') is not None else None
        self.timestamp = int(item['ts']) if item.get('ts') else self.timestamp
        return True

    def view(self, contract_size: float, depth: int = BOOK_DEPTH) -> dict:
        bids = sorted(self.bids.items(), reverse=True)[:depth]
        asks = sorted(self.asks.items())[:depth]
        return dict(bids=[[price, size * contract_size] for price, size in bids],
                    asks=[[price, size * contract_size] for price, size in asks],
                    timestamp=self.timestamp)


class OkxPublicStream:
    def __init__(self):
        self.queues: dict[str, set[asyncio.Queue]] = {kind: set() for kind in CHANNELS}
        self.latest: dict[str, object] = {}
        self.task: asyncio.Task | None = None
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
        """(Re)connect with exactly the wanted channels, or stop when nothing is wanted."""
        wanted = self.wanted()
        if wanted == self.subscribed and self.task and not self.task.done():
            return
        if self.task:
            self.task.cancel()
        self.task = None
        self.subscribed = wanted
        for kind in set(self.latest) - wanted:
            self.latest.pop(kind, None)
        if wanted:
            self.task = asyncio.create_task(self.run(wanted))

    async def run(self, kinds: frozenset[str]) -> None:
        size = await asyncio.to_thread(contract_value)
        if 'trades' in kinds and 'trades' not in self.latest:
            # The trades channel only pushes new trades: start from the recent history.
            try:
                recent = await asyncio.to_thread(public_order_book, 'trades')
                self.publish('trades', recent['trades'])
            except Exception:
                pass
        delay = 1
        while True:
            book = LocalBook()
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.ws_connect(URL, heartbeat=None, receive_timeout=30) as socket:
                        args = [dict(channel=CHANNELS[kind], instId=INSTRUMENT) for kind in sorted(kinds)]
                        await socket.send_json(dict(op='subscribe', args=args))
                        last_ping = time.monotonic()
                        while True:
                            if time.monotonic() - last_ping > 20:
                                await socket.send_str('ping')
                                last_ping = time.monotonic()
                            message = await socket.receive(timeout=25)
                            if message.type != aiohttp.WSMsgType.TEXT:
                                raise ConnectionError('OKX public stream closed')
                            if message.data == 'pong':
                                continue
                            packet = json.loads(message.data)
                            if packet.get('event') == 'error':
                                raise ConnectionError(packet.get('msg', 'OKX subscription error'))
                            channel = (packet.get('arg') or {}).get('channel')
                            data = packet.get('data') or []
                            if not data:
                                continue
                            delay = 1
                            if channel == 'tickers':
                                item = data[-1]
                                self.publish('ticker', dict(symbol=SYMBOL, last=float(item['last']), timestamp=int(item['ts'])))
                            elif channel == 'books':
                                for item in data:
                                    if not book.apply(packet.get('action', 'snapshot'), item):
                                        raise ConnectionError('Order book sequence gap; resubscribing')
                                self.publish('orderBook', book.view(size))
                            elif channel == 'trades':
                                fresh = [trade_view(dict(id=item.get('tradeId'), side=item.get('side'), price=float(item['px']),
                                                         amount=float(item['sz']), timestamp=int(item['ts'])), size)
                                         for item in sorted(data, key=lambda row: int(row['ts']), reverse=True)]
                                self.publish('trades', (fresh + list(self.latest.get('trades') or []))[:TRADE_HISTORY])
            except asyncio.CancelledError:
                raise
            except Exception:
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30)

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
            await asyncio.gather(self.task, return_exceptions=True)
        self.task = None


okx_public_stream = OkxPublicStream()

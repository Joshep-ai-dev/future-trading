"""Record OKX XAG perpetual order-book and trade flow as one row per UTC minute.

Public websocket only (no credentials). Subscribes to ``books5`` (top five
levels), ``trades``, ``open-interest`` and ``funding-rate`` and appends
aggregated minute rows to ``data/OKX_XAG-USDT-SWAP_orderflow_1m.csv``. Candles
cannot provide this information, so history only exists from the moment
recording starts; minutes while the recorder is offline are simply absent.

Runs inside the backend (``orderflow_service`` in the app lifespan; disable with
``SILVER_ORDERFLOW=0``) or standalone: ``python -m server.market.orderflow_recorder``.
"""
from __future__ import annotations

import asyncio
import csv
import json
import logging
import os
import threading
import time
from pathlib import Path

import aiohttp

from server.market.data import CSV

INSTRUMENT = 'XAG-USDT-SWAP'
URL = 'wss://ws.okx.com:8443/ws/v5/public'
OUTPUT = CSV.with_name('OKX_XAG-USDT-SWAP_orderflow_1m.csv')
COLUMNS = ['timestamp_ms', 'buy_volume', 'sell_volume', 'buy_trades', 'sell_trades', 'largest_trade', 'vwap',
           'book_samples', 'imbalance_top1', 'imbalance_top5', 'imbalance_top5_last', 'spread_mean', 'spread_max',
           'bid_depth5', 'ask_depth5', 'mid_last', 'open_interest', 'funding_rate']
log = logging.getLogger(__name__)


class MinuteAggregator:
    """Accumulates websocket messages and emits one finished row per UTC minute."""

    def __init__(self):
        self.minute = None
        self.partial = True  # The first minute after (re)connecting started mid-minute.
        self.open_interest = None
        self.funding_rate = None
        self._reset()

    def _reset(self):
        self.buy_volume = self.sell_volume = 0.
        self.buy_trades = self.sell_trades = 0
        self.largest = 0.
        self.notional = 0.
        self.samples = 0
        self.sum_top1 = self.sum_top5 = self.sum_spread = 0.
        self.max_spread = 0.
        self.last_book = None

    def _roll(self, stamp_ms: int) -> list[dict]:
        minute = stamp_ms//60000*60000
        if self.minute is None:
            self.minute = minute
            return []
        if minute <= self.minute:
            return []
        row = None if self.partial else self.row()
        self.partial = False
        self.minute = minute
        self._reset()
        return [row] if row else []

    def row(self) -> dict | None:
        if self.minute is None or not (self.samples or self.buy_trades or self.sell_trades):
            return None
        volume = self.buy_volume+self.sell_volume
        book = self.last_book or {}
        return dict(timestamp_ms=self.minute, buy_volume=self.buy_volume, sell_volume=self.sell_volume,
                    buy_trades=self.buy_trades, sell_trades=self.sell_trades, largest_trade=self.largest,
                    vwap=self.notional/volume if volume else '', book_samples=self.samples,
                    imbalance_top1=self.sum_top1/self.samples if self.samples else '',
                    imbalance_top5=self.sum_top5/self.samples if self.samples else '',
                    imbalance_top5_last=book.get('imbalance5', ''),
                    spread_mean=self.sum_spread/self.samples if self.samples else '',
                    spread_max=self.max_spread if self.samples else '',
                    bid_depth5=book.get('bid5', ''), ask_depth5=book.get('ask5', ''), mid_last=book.get('mid', ''),
                    open_interest=self.open_interest if self.open_interest is not None else '',
                    funding_rate=self.funding_rate if self.funding_rate is not None else '')

    def trade(self, item: dict) -> list[dict]:
        rows = self._roll(int(item['ts']))
        size, price = float(item['sz']), float(item['px'])
        if item['side'] == 'buy':
            self.buy_volume += size; self.buy_trades += 1
        else:
            self.sell_volume += size; self.sell_trades += 1
        self.largest = max(self.largest, size)
        self.notional += size*price
        return rows

    def book(self, item: dict) -> list[dict]:
        rows = self._roll(int(item['ts']))
        bids, asks = item.get('bids') or [], item.get('asks') or []
        if not bids or not asks:
            return rows
        bid1, ask1 = float(bids[0][1]), float(asks[0][1])
        bid5, ask5 = sum(float(level[1]) for level in bids[:5]), sum(float(level[1]) for level in asks[:5])
        best_bid, best_ask = float(bids[0][0]), float(asks[0][0])
        spread = best_ask-best_bid
        imbalance5 = (bid5-ask5)/(bid5+ask5) if bid5+ask5 else 0.
        self.samples += 1
        self.sum_top1 += (bid1-ask1)/(bid1+ask1) if bid1+ask1 else 0.
        self.sum_top5 += imbalance5
        self.sum_spread += spread
        self.max_spread = max(self.max_spread, spread)
        self.last_book = dict(imbalance5=imbalance5, bid5=bid5, ask5=ask5, mid=(best_bid+best_ask)/2)
        return rows

    def flush(self) -> list[dict]:
        row = self.row()
        self.minute = None
        self._reset()
        return [row] if row else []


def append_rows(rows: list[dict], path: Path = OUTPUT) -> None:
    if not rows:
        return
    new = not path.exists()
    with path.open('a', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=COLUMNS)
        if new:
            writer.writeheader()
        writer.writerows(rows)


class OrderflowRecorder:
    def __init__(self, path: Path = OUTPUT):
        self.path = path
        self.stop = threading.Event()
        self.thread = None
        self.state = dict(connected=False, rows=0, lastRow=None, error=None)

    def status(self) -> dict:
        return dict(self.state, path=str(self.path))

    def handle(self, aggregator: MinuteAggregator, message: dict) -> list[dict]:
        channel = message.get('arg', {}).get('channel')
        rows = []
        for item in message.get('data') or []:
            if channel == 'trades':
                rows += aggregator.trade(item)
            elif channel == 'books5':
                rows += aggregator.book(item)
            elif channel == 'open-interest':
                aggregator.open_interest = float(item['oi'])
            elif channel == 'funding-rate':
                aggregator.funding_rate = float(item['fundingRate'])
        return rows

    def _write(self, rows):
        append_rows(rows, self.path)
        if rows:
            self.state.update(rows=self.state['rows']+len(rows), lastRow=rows[-1]['timestamp_ms'])

    async def _session(self):
        args = [dict(channel=channel, instId=INSTRUMENT) for channel in ('books5', 'trades', 'open-interest', 'funding-rate')]
        aggregator = MinuteAggregator()
        async with aiohttp.ClientSession() as session:
            async with session.ws_connect(URL, heartbeat=None, timeout=aiohttp.ClientWSTimeout(ws_close=10)) as socket:
                await socket.send_str(json.dumps(dict(op='subscribe', args=args)))
                self.state.update(connected=True, error=None)
                last_ping = time.monotonic()
                try:
                    while not self.stop.is_set():
                        if time.monotonic()-last_ping > 20:
                            await socket.send_str('ping'); last_ping = time.monotonic()
                        try:
                            message = await socket.receive(timeout=5)
                        except asyncio.TimeoutError:
                            continue
                        if message.type != aiohttp.WSMsgType.TEXT:
                            if message.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                                break
                            continue
                        if message.data == 'pong':
                            continue
                        payload = json.loads(message.data)
                        if payload.get('event') == 'error':
                            raise ValueError(f"OKX websocket: {payload.get('msg')}")
                        self._write(self.handle(aggregator, payload))
                finally:
                    # The minute in progress is incomplete after a disconnect; drop it rather than write a partial row.
                    self.state['connected'] = False

    async def _run(self):
        delay = 1
        while not self.stop.is_set():
            try:
                await self._session()
                delay = 1
            except Exception as error:  # Network failures: reconnect with backoff.
                self.state.update(connected=False, error=str(error))
                log.warning('Order-flow recorder disconnected: %s', error)
            if not self.stop.is_set():
                await asyncio.sleep(delay)
                delay = min(60, delay*2)

    def start(self):
        if os.environ.get('SILVER_ORDERFLOW', '1') == '0' or (self.thread and self.thread.is_alive()):
            return
        self.stop.clear()
        self.thread = threading.Thread(target=lambda: asyncio.run(self._run()), name='okx-orderflow-recorder', daemon=True)
        self.thread.start()

    def shutdown(self):
        self.stop.set()
        if self.thread:
            self.thread.join(timeout=6)


orderflow_service = OrderflowRecorder()


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    print(f'Recording {INSTRUMENT} order flow to {OUTPUT} (Ctrl+C to stop)')
    orderflow_service.start()
    try:
        while True:
            time.sleep(60)
            print(json.dumps(orderflow_service.status()))
    except KeyboardInterrupt:
        orderflow_service.shutdown()

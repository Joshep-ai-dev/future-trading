import asyncio
import json
import unittest
from unittest.mock import patch

from server.market.public_stream import PublicStreams, VenueMarketStream


class FakeClient:
    """ccxt.pro stand-in: each watch_* call returns one update, then waits like an idle socket."""

    def __init__(self):
        self.closed = False
        self.calls: dict[str, int] = {}

    def market(self, symbol):
        return {'symbol': symbol, 'contractSize': 10}

    async def once(self, name, value):
        self.calls[name] = self.calls.get(name, 0) + 1
        if self.calls[name] > 1:
            await asyncio.Event().wait()
        return value

    async def watch_order_book(self, symbol):
        return await self.once('book', {'bids': [[41.9, 2]], 'asks': [[42.1, 3]], 'timestamp': 1})

    async def watch_trades(self, symbol):
        return await self.once('trades', [{'id': 'b', 'side': 'sell', 'price': 42, 'amount': 1, 'timestamp': 2}])

    async def fetch_trades(self, symbol, limit=None):
        return [{'id': 'a', 'side': 'buy', 'price': 41, 'amount': 2, 'timestamp': 1}]

    async def watch_ticker(self, symbol):
        return await self.once('ticker', {'last': 42.05, 'timestamp': 3})

    async def close(self):
        self.closed = True


class VenueMarketStreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_publishes_book_trades_and_ticker_in_base_units_then_closes_client(self) -> None:
        client = FakeClient()
        stream = VenueMarketStream('hyperliquid', 'XYZ-SILVER/USDC:USDC')
        with patch.object(stream, 'client', return_value=client):
            book_events = stream.events('orderBook')
            trade_events = stream.events('trades')
            ticker_events = stream.events('ticker')
            for events in (book_events, trade_events, ticker_events):
                self.assertEqual(await anext(events), 'retry: 2000\n\n')
            book = json.loads((await anext(book_events))[6:])
            self.assertEqual(book['bids'], [[41.9, 20]])
            self.assertEqual(book['asks'], [[42.1, 30]])
            trades = json.loads((await anext(trade_events))[6:])
            if len(trades) == 1:  # History arrives first, then the streamed trade on top of it.
                trades = json.loads((await anext(trade_events))[6:])
            self.assertEqual([trade['id'] for trade in trades], ['b', 'a'])
            self.assertEqual(trades[0]['quantity'], 10)
            ticker = json.loads((await anext(ticker_events))[6:])
            self.assertEqual(ticker['last'], 42.05)
            for events in (book_events, trade_events, ticker_events):
                await events.aclose()
            # The last subscriber leaving cancels the upstream task; let its cleanup run.
            for _ in range(5):
                await asyncio.sleep(0)
        self.assertIsNone(stream.task)
        self.assertTrue(client.closed)

    async def test_registry_shares_one_stream_per_dataset_and_rejects_unknown(self) -> None:
        datasets = [{'id': 'dataset:abc', 'venue': 'htx', 'symbol': 'XAG/USDT:USDT'}]
        registry = PublicStreams()
        with patch('server.market.datasets.list_datasets', return_value=datasets):
            self.assertIs(registry.get('dataset:abc'), registry.get('dataset:abc'))
            self.assertEqual(registry.get('dataset:abc').venue, 'htx')
            with self.assertRaises(ValueError):
                registry.get('dataset:missing')


if __name__ == '__main__':
    unittest.main()

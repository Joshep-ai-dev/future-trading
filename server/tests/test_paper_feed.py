import unittest
from unittest.mock import MagicMock, patch

from server.market import paper_feed


class PaperFeedTests(unittest.TestCase):
    def setUp(self) -> None:
        paper_feed._cache.clear()

    def test_htx_and_hyperliquid_use_exact_symbols_without_credentials(self) -> None:
        datasets = [dict(id='dataset:'+'a'*64, venue='htx', symbol='BTC/USDT:USDT'),
                    dict(id='dataset:'+'b'*64, venue='hyperliquid', symbol='xyz:SILVER/USDC:USDC')]
        first, second = MagicMock(), MagicMock()
        first.fetch_ohlcv.return_value = [[960000,100,102,99,101,2]]
        second.fetch_ohlcv.return_value = [[960000,40,42,39,41,3]]
        with patch.object(paper_feed, 'list_datasets', return_value=datasets), \
             patch.object(paper_feed, 'public_exchange', side_effect=[first,second]) as create, \
             patch.object(paper_feed.time, 'time', return_value=1000):
            htx = paper_feed.dataset_minutes(datasets[0]['id'])
            hyperliquid = paper_feed.dataset_minutes(datasets[1]['id'])
            self.assertEqual(paper_feed.dataset_minutes(datasets[0]['id']), htx)
        first.fetch_ohlcv.assert_called_once_with('BTC/USDT:USDT','1m',limit=300)
        second.fetch_ohlcv.assert_called_once_with('xyz:SILVER/USDC:USDC','1m',limit=300)
        self.assertEqual([call.args[0] for call in create.call_args_list], ['htx','hyperliquid'])
        self.assertEqual(htx[-1]['close'],101)
        self.assertEqual(hyperliquid[-1]['close'],41)

    def test_stale_prices_are_not_cached_as_fresh(self) -> None:
        dataset = dict(id='dataset:'+'a'*64, venue='htx', symbol='BTC/USDT:USDT')
        exchange = MagicMock()
        exchange.fetch_ohlcv.return_value = [[60000,100,102,99,101,2]]
        with patch.object(paper_feed, 'list_datasets', return_value=[dataset]), \
             patch.object(paper_feed, 'public_exchange', return_value=exchange), \
             patch.object(paper_feed.time, 'time', return_value=1000):
            with self.assertRaises(ValueError):
                paper_feed.dataset_minutes(dataset['id'])
        self.assertNotIn(dataset['id'],paper_feed._cache)
        exchange.close.assert_called_once()

    def test_prepare_market_validates_exact_exchange_symbol(self) -> None:
        from server.market.dataset_sync import prepare_dataset
        with patch('server.market.dataset_sync.market_catalog', return_value=[{'id':'XYZ-SILVER/USDC:USDC'}]), \
             patch('server.market.dataset_sync.public_exchange') as exchange, \
             patch('server.market.dataset_sync.download_minutes', return_value={'id':'saved'}) as download:
            self.assertEqual(prepare_dataset('hyperliquid','XYZ-SILVER/USDC:USDC'), {'id':'saved'})
            download.assert_called_once_with(exchange.return_value, {'symbol':'XYZ-SILVER/USDC:USDC'}, 'hyperliquid', days=1)
            with self.assertRaises(ValueError):
                prepare_dataset('hyperliquid','SILVER')

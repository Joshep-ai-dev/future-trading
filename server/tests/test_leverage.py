import unittest
from unittest.mock import MagicMock

from server.exchanges.leverage import leverage_profile
from server.exchanges.live_exchange import LiveExchange


class LeverageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.exchange = MagicMock()
        self.exchange.options = {}
        self.exchange.has = {}
        self.market = {'symbol': 'ZEC/USDC:USDC', 'limits': {'leverage': {'min': 1, 'max': 10}}}
        self.service = LiveExchange()
        self.service.clients['hyperliquid'] = self.exchange
        self.service.markets['hyperliquid'] = self.market
        self.service.positions = MagicMock(return_value=[])

    def test_reports_symbol_limits_and_current_isolated_leverage_without_writing(self) -> None:
        self.service.positions.return_value = [dict(symbol=self.market['symbol'], marginMode='isolated', leverage=3)]
        profile = leverage_profile(self.service, 'hyperliquid')
        self.assertEqual((profile['minimum'], profile['maximum'], profile['current']), (1, 10, 3))
        self.exchange.set_leverage.assert_not_called()
        self.exchange.set_margin_mode.assert_not_called()

    def test_does_not_import_other_symbols_or_cross_leverage(self) -> None:
        self.service.positions.return_value = [
            dict(symbol='BTC/USDC:USDC', marginMode='isolated', leverage=20),
            dict(symbol=self.market['symbol'], marginMode='cross', leverage=5)]
        self.assertIsNone(leverage_profile(self.service, 'hyperliquid')['current'])

    def test_differing_long_short_settings_are_not_guessed(self) -> None:
        self.exchange.has = {'fetchLeverage': True}
        self.exchange.fetch_leverage.return_value = dict(marginMode='isolated', longLeverage=3, shortLeverage=5)
        profile = leverage_profile(self.service, 'hyperliquid')
        self.assertTrue(profile['differentSides'])
        self.assertIsNone(profile['current'])

    def test_tiers_fill_missing_market_maximum(self) -> None:
        self.market['limits'] = {}
        self.exchange.has = {'fetchLeverageTiers': True}
        self.exchange.fetch_leverage_tiers.return_value = {self.market['symbol']: [dict(maxLeverage=20), dict(maxLeverage=5)]}
        self.assertEqual(leverage_profile(self.service, 'hyperliquid')['maximum'], 20)

    def test_read_failure_leaves_current_unknown(self) -> None:
        self.service.positions.side_effect = RuntimeError('private exchange failure')
        profile = leverage_profile(self.service, 'hyperliquid')
        self.assertIsNone(profile['current'])
        self.assertNotIn('private', str(profile))

    def test_rejects_excessive_leverage_before_account_mutation(self) -> None:
        with self.assertRaisesRegex(ValueError, 'supported range'):
            self.service.prepare_account('hyperliquid', 11)
        self.exchange.set_margin_mode.assert_not_called()
        self.exchange.set_leverage.assert_not_called()

    def test_hyperliquid_margin_and_leverage_both_use_isolated_mode(self) -> None:
        self.service.prepare_account('hyperliquid', 5)
        self.exchange.set_margin_mode.assert_called_once_with('isolated', self.market['symbol'], {'leverage': 5})
        self.exchange.set_leverage.assert_called_once_with(5, self.market['symbol'], {'marginMode': 'isolated'})

    def test_hyperliquid_reads_flat_hip3_asset_leverage(self) -> None:
        self.exchange.walletAddress = '0xtestwallet'
        self.market['info'] = {'name': 'xyz:ZEC'}
        self.exchange.publicPostInfo.return_value = {'leverage': {'type': 'isolated', 'value': 4}}
        self.assertEqual(leverage_profile(self.service, 'hyperliquid')['current'], 4)
        self.exchange.publicPostInfo.assert_called_once_with({'type': 'activeAssetData', 'user': '0xtestwallet', 'coin': 'xyz:ZEC'})

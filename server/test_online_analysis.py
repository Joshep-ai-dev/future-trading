import json
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

from fastapi import HTTPException
from server.market import online_analysis as analysis


def source_html(symbol: str = 'XAG_USD', **changes) -> str:
    full = dict(symbol=symbol, timeframe='1D', computed_at=datetime.now(timezone.utc).isoformat(),
                pivot_bar_date='2026-11-18', price=45.5, data_freshness='live',
                pivots=[dict(method='Classic', s3=40, s2=42, s1=44, pivot=46, r1=48, r2=50, r3=52)],
                expectedWeeklyRange=dict(low=41, high=51, source='atr'))
    full.update(changes)
    data = dict(symbol=symbol, timeframes=[dict(timeframe='1D', status='ready', rating='SELL', full=full)])
    payload = dict(props=dict(pageProps=dict(dehydratedState=dict(queries=[dict(state=dict(data=dict(data=data)))]))))
    return '<script id="__NEXT_DATA__" type="application/json">'+json.dumps(payload)+'</script>'


def forecast_html(**changes) -> str:
    full = dict(symbol='XAG_USD', timeframe='1D', computed_at=datetime.now(timezone.utc).isoformat(),
                pivot_bar_date='2026-11-18', data_freshness='live', summary=dict(rating='SELL'),
                pivots=dict(s3=40, s2=42, s1=44, pivot=46, r1=48, r2=50, r3=52),
                expectedWeeklyRange=dict(low=41, high=51, source='atr'))
    full.update(changes)
    payload = dict(props=dict(pageProps=dict(dehydratedState=dict(queries=[
        dict(queryKey='%2Fforecasts%2Fta-snapshot%2Fsilver', state=dict(data=full)),
        dict(queryKey='%2Fcommodities%2Frates%3Finstruments%3Dsilver', state=dict(data=dict(
            data=dict(prices=dict(silver=dict(last=45, percentChange=-2, lastUpdate=full['computed_at']))))))]))))
    return '<script id="__NEXT_DATA__">'+json.dumps(payload)+'</script>'


class OnlineAnalysisTests(unittest.TestCase):
    def setUp(self) -> None:
        analysis._CACHE.clear()

    def test_symbol_aliases_and_unknown_symbols(self) -> None:
        for symbol in ('XYZ-SILVER/USDC', 'xyz:SILVER/USDC', 'XAG/USDT:USDT', 'XAGUSDT'):
            self.assertEqual(analysis.resolve_asset(symbol)[2], 'XAG_USD')
        self.assertIsNone(analysis.resolve_asset('STABLE/USDC'))
        self.assertIsNone(analysis.resolve_asset('https://example.com'))
        with patch.object(analysis, 'urlopen') as fetch:
            self.assertFalse(analysis.online_analysis('STABLE/USDC')['supported'])
            fetch.assert_not_called()

    def test_published_levels_and_range_are_preserved(self) -> None:
        result = analysis.parse_analysis(source_html(), 'XAG_USD')
        self.assertEqual(result['levels']['s1'], 44)
        self.assertEqual(result['levels']['r1'], 48)
        self.assertEqual((result['rangeLow'], result['rangeHigh']), (41, 51))
        self.assertEqual(result['signals'][0]['rating'], 'SELL')

    def test_fxempire_full_names_resolve_to_forecast_slugs(self) -> None:
        for name, ticker, slug in (('Bitcoin', 'BTC', 'bitcoin'), ('Ethereum', 'ETH', 'ethereum'),
                                   ('Solana', 'SOL', 'solana')):
            for symbol in (name, name.lower(), name+'/USDT', 'xyz:'+name+'/USDC'):
                self.assertEqual(analysis.resolve_asset(symbol), analysis.resolve_asset(ticker))
                self.assertEqual(analysis.resolve_asset(symbol)[1], slug)

    def test_wrong_market_missing_data_and_invalid_levels_are_rejected(self) -> None:
        for html in (source_html('XAU_USD'), '<html>Unavailable</html>',
                     source_html(computed_at=None), source_html(pivots=[])):
            with self.assertRaises(ValueError):
                analysis.parse_analysis(html, 'XAG_USD')

    def test_missing_forecast_range_is_not_fabricated(self) -> None:
        result = analysis.parse_analysis(source_html(expectedWeeklyRange=None), 'XAG_USD')
        self.assertIsNone(result['rangeLow'])
        self.assertIsNone(result['rangeHigh'])

    def test_cache_and_source_delay(self) -> None:
        with patch.object(analysis, 'urlopen') as fetch:
            fetch.return_value.__enter__.return_value.read.return_value = forecast_html().encode()
            first = analysis.online_analysis('SILVER/USDC')
            second = analysis.online_analysis('XAG/USDT')
            self.assertFalse(first['stale'])
            self.assertEqual(first['updatedAt'], second['updatedAt'])
            self.assertEqual(fetch.call_count, 1)
        analysis._CACHE.clear()
        with patch.object(analysis, 'urlopen') as fetch:
            fetch.return_value.__enter__.return_value.read.return_value = forecast_html(computed_at='2024-01-01T00:00:00Z').encode()
            self.assertTrue(analysis.online_analysis('SILVER/USDC')['stale'])

    def test_cache_refreshes_after_five_seconds(self) -> None:
        with patch.object(analysis, 'urlopen') as fetch, patch.object(analysis.time, 'time', return_value=1000) as clock:
            fetch.return_value.__enter__.return_value.read.return_value = forecast_html().encode()
            analysis.online_analysis('SILVER/USDC')
            clock.return_value = 1004.9
            analysis.online_analysis('SILVER/USDC')
            self.assertEqual(fetch.call_count, 1)
            clock.return_value = 1005
            analysis.online_analysis('SILVER/USDC')
            self.assertEqual(fetch.call_count, 2)

    def test_forecast_is_daily_and_shared_across_chart_timeframes(self) -> None:
        with patch.object(analysis, 'urlopen') as fetch:
            fetch.return_value.__enter__.return_value.read.return_value = forecast_html().encode()
            intraday = analysis.online_analysis('SILVER/USDC', '5m')
            daily = analysis.online_analysis('SILVER/USDC', '1d')
        self.assertEqual(intraday['timeframe'], '1d')
        self.assertEqual(intraday['levels']['s1'], 44)
        self.assertEqual(intraday['levels'], daily['levels'])
        self.assertEqual(intraday['sourceUrl'], 'https://www.fxempire.com/forecasts/silver')
        self.assertEqual(intraday['signals'][0]['rating'], 'SELL')
        self.assertEqual(intraday['referencePrice'], 45)
        self.assertEqual(intraday['nearestSupport'], 44)
        self.assertEqual(intraday['nextResistance'], 46)
        self.assertEqual(fetch.call_count, 1)

    def test_forecast_rejects_wrong_market(self) -> None:
        with patch.object(analysis, 'urlopen') as fetch:
            fetch.return_value.__enter__.return_value.read.return_value = forecast_html(symbol='XAU_USD').encode()
            with self.assertRaises(ValueError):
                analysis.online_analysis('SILVER/USDC')

    def test_unsupported_timeframe_does_not_fall_back_to_daily(self) -> None:
        with patch.object(analysis, 'urlopen') as fetch:
            result = analysis.online_analysis('SILVER/USDC', '3m')
        self.assertFalse(result['supported'])
        fetch.assert_not_called()

    def test_fetch_failure_returns_retryable_error(self) -> None:
        with patch.object(analysis, 'urlopen', side_effect=OSError('offline')):
            with self.assertRaises(HTTPException) as caught:
                analysis.get_online_analysis('SILVER/USDC')
            self.assertEqual(caught.exception.status_code, 502)


if __name__ == '__main__':
    unittest.main()

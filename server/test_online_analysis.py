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
            fetch.return_value.__enter__.return_value.read.return_value = source_html().encode()
            first = analysis.online_analysis('SILVER/USDC')
            second = analysis.online_analysis('XAG/USDT')
            self.assertFalse(first['stale'])
            self.assertEqual(first['updatedAt'], second['updatedAt'])
            self.assertEqual(fetch.call_count, 1)
        analysis._CACHE.clear()
        with patch.object(analysis, 'urlopen') as fetch:
            fetch.return_value.__enter__.return_value.read.return_value = source_html(computed_at='2024-01-01T00:00:00Z').encode()
            self.assertTrue(analysis.online_analysis('SILVER/USDC')['stale'])

    def test_fetch_failure_returns_retryable_error(self) -> None:
        with patch.object(analysis, 'urlopen', side_effect=OSError('offline')):
            with self.assertRaises(HTTPException) as caught:
                analysis.get_online_analysis('SILVER/USDC')
            self.assertEqual(caught.exception.status_code, 502)


if __name__ == '__main__':
    unittest.main()

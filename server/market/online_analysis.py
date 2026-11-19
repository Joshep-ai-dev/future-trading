"""Read published FXEmpire analysis. Never substitute locally calculated levels."""
import json
import math
import re
import threading
import time
from datetime import datetime
from http.client import HTTPException as HTTPReadError
from urllib.request import Request, urlopen

from fastapi import APIRouter, HTTPException, Query

router = APIRouter(prefix='/api/market')
_CACHE: dict[str, tuple[float, dict]] = {}
_LOCK = threading.Lock()
_ASSETS = {
    'XAG': ('commodities', 'silver', 'XAG_USD', 'Silver spot · XAG/USD'),
    'SILVER': ('commodities', 'silver', 'XAG_USD', 'Silver spot · XAG/USD'),
    'XAU': ('commodities', 'gold', 'XAU_USD', 'Gold spot · XAU/USD'),
    'GOLD': ('commodities', 'gold', 'XAU_USD', 'Gold spot · XAU/USD'),
    'BTC': ('crypto', 'bitcoin', 'BTC_USD', 'Bitcoin · BTC/USD'),
    'ETH': ('crypto', 'ethereum', 'ETH_USD', 'Ethereum · ETH/USD'),
    'SOL': ('crypto', 'solana', 'SOL_USD', 'Solana · SOL/USD'),
    'XRP': ('crypto', 'ripple', 'XRP_USD', 'XRP · XRP/USD'),
}
_FRAMES = {'1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min', '1h': '1H', '4h': '4H', '1d': '1D', '1w': '1W'}
_RATINGS = {'BUY', 'STRONG_BUY', 'SELL', 'STRONG_SELL', 'NEUTRAL'}
_ASSET_NAMES = {'BITCOIN': 'BTC', 'ETHEREUM': 'ETH', 'SOLANA': 'SOL'}


def resolve_asset(symbol: str) -> tuple[str, str, str, str] | None:
    # Hyperliquid builder prefixes: xyz:SILVER/USDC or XYZ-SILVER/USDC.
    base = symbol.upper().strip().split('/')[0]
    if base.startswith(('XYZ:', 'XYZ-')):
        base = base[4:]
    if '/' not in symbol:
        for quote in ('USDT', 'USDC', 'USD'):
            if base.endswith(quote):
                base = base[:-len(quote)].rstrip('-_')
                break
    return _ASSETS.get(_ASSET_NAMES.get(base, base))


def positive(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) and value > 0 else None


def parse_analysis(html: str, expected_symbol: str, timeframe: str = '1D') -> dict:
    match = re.search(r'<script\b[^>]*\bid=["\']__NEXT_DATA__["\'][^>]*>(.*?)</script>', html, re.S)
    if not match:
        raise ValueError('Published analysis data is unavailable')
    payload = json.loads(match[1])
    queries = payload.get('props', {}).get('pageProps', {}).get('dehydratedState', {}).get('queries', [])
    for query in queries:
        envelope = query.get('state', {}).get('data', {})
        if not isinstance(envelope, dict):
            continue
        data = envelope.get('data', {})
        if not isinstance(data, dict) or data.get('symbol') != expected_symbol:
            continue
        frames = data.get('timeframes', [])
        daily = next((row for row in frames if row.get('timeframe', '').upper() == timeframe.upper() and row.get('status') == 'ready'), {})
        full = daily.get('full', {})
        if full.get('symbol') != expected_symbol or str(full.get('timeframe', '')).upper() != timeframe.upper():
            continue
        stamp = full.get('computed_at')
        updated = datetime.fromisoformat(stamp.replace('Z', '+00:00')) if isinstance(stamp, str) else None
        if updated is None or updated.tzinfo is None:
            raise ValueError('Source did not publish an analysis timestamp')
        pivots = next((row for row in full.get('pivots', []) if row.get('method') == 'Classic'), {})
        levels = {key: positive(pivots.get(key)) for key in ('s1', 's2', 's3', 'pivot', 'r1', 'r2', 'r3')}
        if not all(value is not None for value in levels.values()):
            raise ValueError('Source did not publish complete support and resistance levels')
        if not levels['s3'] <= levels['s2'] <= levels['s1'] <= levels['pivot'] <= levels['r1'] <= levels['r2'] <= levels['r3']:
            raise ValueError('Source published inconsistent pivot levels')
        weekly = full.get('expectedWeeklyRange') or {}
        low, high = positive(weekly.get('low')), positive(weekly.get('high'))
        signals = [{
            'timeframe': row['timeframe'], 'rating': row['rating'],
            'asOf': row.get('as_of'), 'computedAt': row.get('computed_at'),
        } for row in frames if row.get('status') == 'ready' and row.get('rating') in _RATINGS]
        return dict(levels=levels, signals=signals, updatedAt=updated.isoformat(),
                    pivotDate=full.get('pivot_bar_date'), referencePrice=positive(full.get('price')),
                    rangeLow=low if low and high and low <= high else None,
                    rangeHigh=high if low and high and low <= high else None,
                    rangeMethod=weekly.get('source'), freshness=full.get('data_freshness'))
    raise ValueError('No matching timeframe analysis published for this symbol')


def online_analysis(symbol: str, timeframe: str = '1d') -> dict:
    if timeframe not in _FRAMES:
        return dict(supported=False, message=f'Source analysis is unavailable for {timeframe}.')
    asset = resolve_asset(symbol)
    if asset is None:
        return dict(supported=False, message='Online analysis is not available for this symbol.')
    group, slug, provider_symbol, label = asset
    url = f'https://www.fxempire.com/forecasts/{slug}'
    cache_key = url
    with _LOCK:
        now = time.time()
        cached = _CACHE.get(cache_key)
        if cached and now-cached[0] < 5:
            result = dict(cached[1])
        else:
            request = Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html'})
            with urlopen(request, timeout=10) as response:
                raw = response.read(3_000_001)
                if len(raw) > 3_000_000:
                    raise ValueError('Online analysis response is too large')
                html = raw.decode('utf-8')
            match = re.search(r'<script\b[^>]*\bid=["\']__NEXT_DATA__["\'][^>]*>(.*?)</script>', html, re.S)
            if not match:
                raise ValueError('Published forecast data is unavailable')
            queries = json.loads(match[1]).get('props', {}).get('pageProps', {}).get('dehydratedState', {}).get('queries', [])
            snapshot = next((query.get('state', {}).get('data') for query in queries
                             if 'forecasts%2Fta-snapshot%2F' in str(query.get('queryKey', ''))), None)
            if not isinstance(snapshot, dict) or snapshot.get('symbol') != provider_symbol:
                raise ValueError('No matching forecast snapshot published for this symbol')
            full = {**snapshot, 'pivots': [{'method': 'Classic', **snapshot.get('pivots', {})}]}
            payload = {'props': {'pageProps': {'dehydratedState': {'queries': [
                {'state': {'data': {'data': {'symbol': provider_symbol, 'timeframes': [
                    {'timeframe': '1D', 'status': 'ready', 'rating': snapshot.get('summary', {}).get('rating'),
                     'computed_at': snapshot.get('computed_at'), 'full': full}
                ]}}}}
            ]}}}}
            result = parse_analysis('<script id="__NEXT_DATA__">'+json.dumps(payload)+'</script>', provider_symbol)
            result['timeframe'] = '1d'
            rates = next((query.get('state', {}).get('data') for query in queries
                          if '%2Frates%3F' in str(query.get('queryKey', ''))), None)
            quote = (rates or {}).get('data', {}).get('prices', {}).get(slug, {})
            current_price = positive(quote.get('last'))
            result['referencePrice'] = current_price
            result['quoteUpdatedAt'] = quote.get('lastUpdate')
            result['priceChangePct'] = quote.get('percentChange')
            result['summary'] = snapshot.get('summary', {})
            result['signalChange'] = snapshot.get('signalChange')
            levels = list(result['levels'].values())
            result['nearestSupport'] = max((level for level in levels if current_price and level < current_price), default=None)
            result['nextResistance'] = min((level for level in levels if current_price and level > current_price), default=None)
            result.update(supported=True, source='FXEmpire', sourceUrl=url, market=label, fetchedAt=time.time())
            _CACHE[cache_key] = (time.time(), dict(result))
        age = time.time()-datetime.fromisoformat(result['updatedAt']).timestamp()
        result['stale'] = age > 3600 or age < -300 or result['freshness'] not in ('live', 'fresh')
        return result


@router.get('/online-analysis')
def get_online_analysis(symbol: str = Query(..., min_length=1, max_length=80), timeframe: str = '1d') -> dict:
    try:
        return online_analysis(symbol, timeframe)
    except (OSError, ValueError, KeyError, TypeError, HTTPReadError) as error:
        raise HTTPException(status_code=502, detail='Online analysis could not be loaded from FXEmpire. Please retry.') from error

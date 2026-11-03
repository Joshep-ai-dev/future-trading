"""Public silver ticker snapshots for display; never used as training candles."""
import json
import math
import threading
import time
from urllib.request import Request, urlopen

_LOCK = threading.Lock()
_CACHE = None
_FETCHED = 0.


def fetch_silver_quote() -> dict:
    request = Request('https://www.okx.com/api/v5/market/ticker?instId=XAG-USDT-SWAP',
                      headers={'User-Agent': 'SilverResearch/1.0'})
    with urlopen(request, timeout=4) as response:
        payload = json.load(response)
    return parse_quote(payload, time.time())


def parse_quote(payload: dict, now: float) -> dict:
    if str(payload.get('code')) != '0' or not payload.get('data'):
        raise ValueError('Live silver quote unavailable from OKX')
    item = payload['data'][0]
    if item.get('instId') != 'XAG-USDT-SWAP':
        raise ValueError('Unexpected quote instrument')
    price, milliseconds = float(item['last']), float(item['ts'])
    if not math.isfinite(price) or price <= 0 or not math.isfinite(milliseconds) or milliseconds <= 0:
        raise ValueError('Invalid live silver quote')
    timestamp = milliseconds/1000
    if timestamp > now+30:
        raise ValueError('Live quote timestamp is in the future')
    return dict(price=price, time=timestamp, source='OKX XAG-USDT-SWAP',
                checkedAt=now, stale=now-timestamp > 60)


def silver_quote() -> dict:
    global _CACHE, _FETCHED
    with _LOCK:
        now = time.time()
        if _CACHE is None or now-_FETCHED >= 2:
            _CACHE = fetch_silver_quote()
            _FETCHED = now
        return {**_CACHE, 'stale': now-_CACHE['time'] > 60}

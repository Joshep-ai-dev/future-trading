"""Public HTX XAG perpetual cost snapshot; no account credentials."""
import json
import math
from urllib.request import urlopen


def fetch_htx_costs():
    def get(path):
        with urlopen('https://api.hbdm.com/'+path+'?contract_code=XAG-USDT', timeout=10) as response:
            data = json.load(response)
        if data.get('status') != 'ok':
            raise ValueError('HTX did not return XAG-USDT market data')
        return data
    funding = get('linear-swap-api/v1/swap_funding_rate')['data']
    tick = get('linear-swap-ex/market/detail/merged')['tick']
    rate = float(funding['funding_rate'])
    interval = (int(funding['next_funding_time'])-int(funding['funding_time']))/3600000
    bid, ask = float(tick['bid'][0]), float(tick['ask'][0])
    if not all(math.isfinite(v) for v in (rate, interval, bid, ask)) or interval <= 0 or bid <= 0 or ask < bid:
        raise ValueError('HTX returned invalid funding interval or spread')
    return dict(fee_bps=6., funding_bps=rate*10000*8/interval, spread=ask-bid,
                actualFundingPct=rate*100, intervalHours=interval,
                feeNote='6 bps (0.06%) per side is an editable public USDT-perpetual taker estimate, not your authenticated account fee.',
                fundingTime=funding['funding_time'])

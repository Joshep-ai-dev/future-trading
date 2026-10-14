"""Display-only candles assembled from minute bars; no strategy inputs here."""
from bisect import bisect_left
import json
from urllib.request import Request, urlopen

import numpy as np


def interpolate_minute(row, seconds):
    """Synthetic O -> nearest extreme -> other extreme -> C at 0/20/40/60s."""
    o,h,l,c = (row[k] for k in ('open','high','low','close'))
    path = [o,h,l,c] if abs(h-o) < abs(o-l) else [o,l,h,c]
    elapsed = min(60.,max(0.,seconds))
    segment = min(2,int(elapsed//20))
    price = path[segment]+(path[segment+1]-path[segment])*(elapsed-segment*20)/20
    visited = path[:segment+1]+[price]
    return dict(time=row['time'],open=o,high=max(visited),low=min(visited),close=price)


def forming_candle(minutes, clock, duration, synthetic=False):
    bucket = int(clock)//duration*duration
    stamps = [r['time'] for r in minutes]
    start = bisect_left(stamps,bucket)
    selected=[]
    for row in minutes[start:]:
        if row['time'] > clock or row['time'] >= bucket+duration:
            break
        if row['time'] != bucket+len(selected)*60:
            return None  # Do not invent candles across missing minutes.
        if synthetic and row['time']+60 > clock:
            row = interpolate_minute(row,clock-row['time'])
        selected.append(row)
    if not selected or selected[-1]['time']+60 < clock:
        return None
    return dict(time=bucket,open=selected[0]['open'],high=max(r['high'] for r in selected),
                low=min(r['low'] for r in selected),close=selected[-1]['close'])


def fetch_live_minutes(limit=2):
    request = Request(f'https://www.okx.com/api/v5/market/candles?instId=XAG-USDT-SWAP&bar=1m&limit={limit}',
                      headers={'User-Agent':'SilverResearch/1.0'})
    with urlopen(request,timeout=3) as response:
        payload=json.load(response)
    if str(payload.get('code')) != '0':
        raise ValueError('OKX live candle error: '+str(payload.get('msg')))
    rows=[]
    for raw in payload['data']:
        row=dict(zip(('time','open','high','low','close'),[int(raw[0])//1000,*map(float,raw[1:5])]))
        if (row['time']%60 or not np.isfinite(list(row.values())).all() or
                min(row['open'],row['high'],row['low'],row['close'])<=0 or
                row['high']<max(row['open'],row['close'],row['low']) or
                row['low']>min(row['open'],row['close'],row['high'])):
            raise ValueError('Invalid live minute candle')
        rows.append(row)
    return sorted(rows,key=lambda r:r['time'])

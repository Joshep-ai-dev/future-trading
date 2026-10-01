"""Read the specified OKX CSV; preserve gaps and never rewrite source data."""
from pathlib import Path
import numpy as np
import pandas as pd

CSV = Path(__file__).resolve().parents[1] / 'data' / 'OKX_XAG-USDT-SWAP_1m.csv'
TIMEFRAMES = {'1m': 60, '5m': 300, '10m': 600, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400}


def load_bars(timeframe='1m', path=CSV):
    if timeframe not in TIMEFRAMES:
        raise ValueError('Unsupported timeframe.')
    df = pd.read_csv(path)
    cols = ['timestamp_ms', 'open', 'high', 'low', 'close', 'volume_contracts']
    if not set(cols).issubset(df.columns) or df.empty:
        raise ValueError('CSV is empty or missing required OHLCV columns.')
    df = df[cols].apply(pd.to_numeric, errors='raise')
    if not np.isfinite(df.to_numpy()).all():
        raise ValueError('CSV contains non-finite values.')
    if df.timestamp_ms.duplicated().any() or (df.timestamp_ms % 60000 != 0).any():
        raise ValueError('CSV timestamps must be unique minute boundaries.')
    invalid = ((df[['open', 'high', 'low', 'close']] <= 0).any(axis=1)
               | (df.high < df[['open', 'close', 'low']].max(axis=1))
               | (df.low > df[['open', 'close', 'high']].min(axis=1))
               | (df.volume_contracts < 0))
    if invalid.any():
        raise ValueError(f'CSV contains {int(invalid.sum())} invalid OHLCV rows.')
    df.index = pd.to_datetime(df.timestamp_ms, unit='ms', utc=True)
    df = df.sort_index()
    seconds = TIMEFRAMES[timeframe]
    bars = df.resample(f'{seconds}s').agg(open=('open', 'first'), high=('high', 'max'),
        low=('low', 'min'), close=('close', 'last'), volume=('volume_contracts', 'sum'), minutes=('close', 'count'))
    complete = (bars.minutes == seconds // 60) & (bars.index + pd.Timedelta(seconds=seconds) <= pd.Timestamp.now(tz='UTC'))
    quality = dict(minuteBars=len(df), missingMinutes=int((df.index[-1]-df.index[0]).total_seconds()/60+1-len(df)),
                   excludedBars=int((~complete).sum()), completeBars=int(complete.sum()))
    bars.loc[~complete, ['open', 'high', 'low', 'close', 'volume']] = np.nan
    return bars, quality

"""Read the specified OKX CSV; preserve gaps and never rewrite source data."""
from pathlib import Path
import numpy as np
import pandas as pd

CSV = Path(__file__).resolve().parents[2] / 'data' / 'OKX_XAG-USDT-SWAP_1m.csv'
STABLE_CSV = CSV.with_name('HYPERLIQUID_STABLE-USDC-PERP_1m.csv')
TIMEFRAMES = {'1m': 60, '3m': 180, '5m': 300, '10m': 600, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400}


def load_bars(timeframe='1m', path=None, instrument='xag'):
    if timeframe not in TIMEFRAMES:
        raise ValueError('Unsupported timeframe.')
    if instrument not in ('xag', 'stable'):
        raise ValueError('Unsupported backtest market.')
    path = Path(path) if path is not None else (CSV if instrument == 'xag' else STABLE_CSV)
    df = pd.read_csv(path)
    # Only the default instrument includes the downloaded overlay. Test/custom
    # CSVs stay independent. Atomic replacement lets readers see a whole cache.
    if Path(path).resolve() == CSV.resolve():
        # Older backfilled history first, then the source, then newer updates (later wins on overlap).
        history = CSV.with_name('OKX_XAG-USDT-SWAP_1m_history.csv')
        cache = CSV.with_name('OKX_XAG-USDT-SWAP_1m_updates.csv')
        parts = [pd.read_csv(history)] if history.exists() else []
        parts += [df] + ([pd.read_csv(cache)] if cache.exists() else [])
        if len(parts) > 1:
            df = pd.concat(parts, ignore_index=True).drop_duplicates('timestamp_ms', keep='last')
    if 'volume_contracts' not in df.columns and 'volume' in df.columns:
        df = df.rename(columns={'volume': 'volume_contracts'})
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

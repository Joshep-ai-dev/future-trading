"""Display-only timeframe aggregation, bounded by the session clock."""
import pandas as pd
from .data import TIMEFRAMES
from .forming_candle import forming_candle
from .serialization import optional_volume


def chart_view(frame, snapshots, timeframe, clock, settings, synthetic):
    duration = TIMEFRAMES[timeframe]
    value_columns = ['open', 'high', 'low', 'close'] + (['volume'] if 'volume' in frame.columns else [])
    source = frame[value_columns].dropna(subset=['open', 'high', 'low', 'close']).copy()
    if snapshots:
        saved = pd.DataFrame(snapshots).set_index('time')
        saved.index = pd.to_datetime(saved.index, unit='s', utc=True)
        snapshot_columns = ['open', 'high', 'low', 'close'] + (['volume'] if 'volume' in saved.columns else [])
        source = pd.concat([source, saved[snapshot_columns]])
        source = source.loc[~source.index.duplicated(keep='last')].sort_index()
    source = source.loc[source.index <= pd.Timestamp(clock, unit='s', tz='UTC')]
    complete = source.loc[source.index + pd.Timedelta(seconds=60) <= pd.Timestamp(clock, unit='s', tz='UTC')]
    aggregation = dict(open=('open','first'), high=('high','max'), low=('low','min'),
                       close=('close','last'), count=('close','count'))
    if 'volume' in complete.columns:
        aggregation['volume'] = ('volume','sum')
    bars = complete.resample(f'{duration}s').agg(**aggregation)
    bars = bars.loc[(bars['count'] == duration//60) &
                    (bars.index + pd.Timedelta(seconds=duration) <= pd.Timestamp(clock, unit='s', tz='UTC'))]
    basis = bars.close.rolling(settings['bb_length']).mean()
    deviation = bars.close.rolling(settings['bb_length']).std(ddof=0)*settings['bb_mult']
    bars['bbBasis'], bars['bbUpper'], bars['bbLower'] = basis, basis+deviation, basis-deviation
    bars['trendSma'] = bars.close.rolling(settings['sma_length']).mean() if settings.get('use_sma_trend_adjustment', True) else float('nan')
    candles, indicators = [], []
    for stamp, row in bars.tail(1000).iterrows():
        t = int(stamp.timestamp())
        candles.append(dict(time=t, **{k:float(row[k]) for k in ('open','high','low','close')},
                            **optional_volume(row['volume'] if 'volume' in bars.columns else None)))
        indicators.append(dict(time=t, **{k:float(row[k]) if pd.notna(row[k]) else None
                            for k in ('bbBasis','bbUpper','bbLower','trendSma')}))
    left = int(max(0,clock-max(duration*2,30000)))//duration*duration
    minutes = [dict(time=int(t.timestamp()), **{k:float(row[k]) for k in ('open','high','low','close')},
                    **optional_volume(row['volume'] if 'volume' in source.columns else None))
               for t,row in source.loc[source.index >= pd.Timestamp(left,unit='s',tz='UTC')].iterrows()]
    return dict(candles=candles, indicators=indicators, minutes=minutes,
                forming=forming_candle(minutes,clock,duration,synthetic=synthetic))

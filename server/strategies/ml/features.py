"""Vectorised indicator features for the ML strategy.

Every group is a pure function ``frame -> DataFrame`` that uses only the
current and past candles, so features never look ahead. Groups are registered
in ``FEATURE_GROUPS``; add a new group by writing one function and listing it.
Values are scale-free (returns, ratios, z-scores) so models transfer across
price levels.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import numpy as np
import pandas as pd

EPS = 1e-12


def _wilder(series: pd.Series, length: int) -> pd.Series:
    return series.ewm(alpha=1/length, adjust=False, min_periods=length).mean()


def _true_range(frame: pd.DataFrame) -> pd.Series:
    previous = frame.close.shift()
    return pd.concat([frame.high-frame.low, (frame.high-previous).abs(), (frame.low-previous).abs()], axis=1).max(axis=1)


def _rsi(close: pd.Series, length: int) -> pd.Series:
    change = close.diff()
    gain, loss = _wilder(change.clip(lower=0), length), _wilder(-change.clip(upper=0), length)
    return 100-100/(1+gain/(loss+EPS))


def _zscore(series: pd.Series, length: int) -> pd.Series:
    mean, std = series.rolling(length).mean(), series.rolling(length).std()
    return (series-mean)/(std+EPS)


def returns(frame: pd.DataFrame) -> pd.DataFrame:
    log_close = np.log(frame.close)
    return pd.DataFrame({f'ret_{n}': log_close.diff(n) for n in (1, 2, 3, 6, 12, 24, 48, 96)}, index=frame.index)


def volatility(frame: pd.DataFrame) -> pd.DataFrame:
    log_return = np.log(frame.close).diff()
    tr = _true_range(frame)
    atr14 = _wilder(tr, 14)
    parkinson = np.sqrt((np.log(frame.high/frame.low)**2).rolling(20).mean()/(4*np.log(2)))
    return pd.DataFrame({
        'atr_pct_14': atr14/frame.close,
        'atr_ratio_14_56': atr14/(_wilder(tr, 56)+EPS),
        'realized_vol_12': log_return.rolling(12).std(),
        'realized_vol_48': log_return.rolling(48).std(),
        'vol_ratio_12_48': log_return.rolling(12).std()/(log_return.rolling(48).std()+EPS),
        'parkinson_20': parkinson,
        'range_pct': (frame.high-frame.low)/frame.close,
    }, index=frame.index)


def bollinger(frame: pd.DataFrame) -> pd.DataFrame:
    output = {}
    for length, mult in ((20, 2.), (50, 2.)):
        basis, std = frame.close.rolling(length).mean(), frame.close.rolling(length).std()
        upper, lower = basis+mult*std, basis-mult*std
        output[f'bb_pos_{length}'] = (frame.close-lower)/(upper-lower+EPS)
        output[f'bb_width_{length}'] = (upper-lower)/(basis+EPS)
        output[f'bb_z_{length}'] = (frame.close-basis)/(std+EPS)
    output['bb_width_change'] = output['bb_width_20'].pct_change(12)
    return pd.DataFrame(output, index=frame.index)


def trend(frame: pd.DataFrame) -> pd.DataFrame:
    close = frame.close
    ema = {n: close.ewm(span=n, adjust=False, min_periods=n).mean() for n in (9, 21, 50, 100)}
    macd = ema[9]-ema[21]
    signal = macd.ewm(span=9, adjust=False).mean()
    up, down = frame.high.diff(), -frame.low.diff()
    plus_dm = pd.Series(np.where((up > down) & (up > 0), up, 0.), index=frame.index)
    minus_dm = pd.Series(np.where((down > up) & (down > 0), down, 0.), index=frame.index)
    atr14 = _wilder(_true_range(frame), 14)
    plus_di, minus_di = 100*_wilder(plus_dm, 14)/(atr14+EPS), 100*_wilder(minus_dm, 14)/(atr14+EPS)
    adx = _wilder(100*(plus_di-minus_di).abs()/(plus_di+minus_di+EPS), 14)
    return pd.DataFrame({
        **{f'ema_dist_{n}': close/ema[n]-1 for n in ema},
        **{f'ema_slope_{n}': ema[n].pct_change(6) for n in (21, 50)},
        'ema_9_21': ema[9]/ema[21]-1, 'ema_21_100': ema[21]/ema[100]-1,
        'macd_pct': macd/close, 'macd_hist_pct': (macd-signal)/close,
        'adx_14': adx, 'di_spread': plus_di-minus_di,
        'efficiency_24': (close-close.shift(24)).abs()/(close.diff().abs().rolling(24).sum()+EPS),
    }, index=frame.index)


def oscillators(frame: pd.DataFrame) -> pd.DataFrame:
    close, high, low = frame.close, frame.high, frame.low
    highest, lowest = high.rolling(14).max(), low.rolling(14).min()
    stoch_k = 100*(close-lowest)/(highest-lowest+EPS)
    typical = (high+low+close)/3
    mean = typical.rolling(20).mean()
    mean_dev = (typical-mean).abs().rolling(20).mean()  # vectorised approximation of mean deviation
    return pd.DataFrame({
        'rsi_7': _rsi(close, 7), 'rsi_14': _rsi(close, 14), 'rsi_28': _rsi(close, 28),
        'stoch_k': stoch_k, 'stoch_d': stoch_k.rolling(3).mean(),
        'williams_r': -100*(highest-close)/(highest-lowest+EPS),
        'cci_20': (typical-mean)/(0.015*mean_dev+EPS),
        'roc_12': close.pct_change(12),
    }, index=frame.index)


def volume(frame: pd.DataFrame) -> pd.DataFrame:
    if 'volume' not in frame.columns or frame.volume.isna().all():
        return pd.DataFrame(index=frame.index)
    vol = frame.volume.fillna(0)
    direction = np.sign(frame.close.diff()).fillna(0)
    obv = (direction*vol).cumsum()
    typical = (frame.high+frame.low+frame.close)/3
    flow = typical*vol
    positive = flow.where(typical.diff() > 0, 0).rolling(14).sum()
    negative = flow.where(typical.diff() < 0, 0).rolling(14).sum()
    vwap = (typical*vol).rolling(48).sum()/(vol.rolling(48).sum()+EPS)
    return pd.DataFrame({
        'volume_z_48': _zscore(np.log1p(vol), 48),
        'volume_ratio_12': vol.rolling(12).mean()/(vol.rolling(96).mean()+EPS),
        'obv_slope_24': obv.diff(24)/(vol.rolling(24).sum()+EPS),
        'mfi_14': 100-100/(1+positive/(negative+EPS)),
        'vwap_dist_48': frame.close/(vwap+EPS)-1,
    }, index=frame.index)


def candles(frame: pd.DataFrame) -> pd.DataFrame:
    span = (frame.high-frame.low).replace(0, np.nan)
    body = frame.close-frame.open
    return pd.DataFrame({
        'body_ratio': body/span,
        'upper_wick': (frame.high-frame[['open', 'close']].max(axis=1))/span,
        'lower_wick': (frame[['open', 'close']].min(axis=1)-frame.low)/span,
        'close_position': (frame.close-frame.low)/span,
        'up_count_6': (body > 0).astype(float).rolling(6).sum(),
        'gap_pct': frame.open/frame.close.shift()-1,
    }, index=frame.index).fillna(0.)


def calendar(frame: pd.DataFrame) -> pd.DataFrame:
    hours = frame.index.hour+frame.index.minute/60
    return pd.DataFrame({
        'hour_sin': np.sin(2*np.pi*hours/24), 'hour_cos': np.cos(2*np.pi*hours/24),
        'weekday_sin': np.sin(2*np.pi*frame.index.dayofweek/7), 'weekday_cos': np.cos(2*np.pi*frame.index.dayofweek/7),
    }, index=frame.index)


def higher_timeframe(frame: pd.DataFrame) -> pd.DataFrame:
    """Trend of a 4x-longer timeframe, built only from bars that are already closed."""
    close = frame.close
    slow = close.rolling(4*21).mean()
    return pd.DataFrame({
        'htf_ret_4x6': np.log(close).diff(24),
        'htf_dist_sma': close/slow-1,
        'htf_slope': slow.pct_change(24),
        'htf_rsi': _rsi(close, 56),
    }, index=frame.index)


@dataclass(frozen=True)
class FeatureGroup:
    key: str
    label: str
    description: str
    build: Callable[[pd.DataFrame], pd.DataFrame]


FEATURE_GROUPS: dict[str, FeatureGroup] = {group.key: group for group in (
    FeatureGroup('returns', 'Returns', 'Log returns over 1 to 96 candles', returns),
    FeatureGroup('volatility', 'Volatility', 'ATR, realized and Parkinson volatility', volatility),
    FeatureGroup('bollinger', 'Bollinger bands', 'Band position, width and z-score (20, 50)', bollinger),
    FeatureGroup('trend', 'Trend', 'EMA distances and slopes, MACD, ADX/DI, efficiency', trend),
    FeatureGroup('oscillators', 'Oscillators', 'RSI 7/14/28, stochastic, Williams %R, CCI, ROC', oscillators),
    FeatureGroup('volume', 'Volume', 'Volume z-score, OBV slope, MFI, VWAP distance', volume),
    FeatureGroup('candles', 'Candle shape', 'Body and wick ratios, close position, gaps', candles),
    FeatureGroup('calendar', 'Time of day', 'Hour and weekday cycles', calendar),
    FeatureGroup('higher_timeframe', 'Higher timeframe', 'Slower trend and momentum context', higher_timeframe),
)}
DEFAULT_GROUPS = tuple(FEATURE_GROUPS)


def build_features(frame: pd.DataFrame, groups: tuple[str, ...] | list[str] = DEFAULT_GROUPS) -> pd.DataFrame:
    unknown = [key for key in groups if key not in FEATURE_GROUPS]
    if unknown:
        raise ValueError(f'Unknown feature groups: {", ".join(unknown)}')
    if not groups:
        raise ValueError('Choose at least one feature group')
    parts = [FEATURE_GROUPS[key].build(frame) for key in groups]
    features = pd.concat(parts, axis=1).replace([np.inf, -np.inf], np.nan)
    return features.astype(np.float32)

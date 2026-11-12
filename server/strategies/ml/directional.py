"""ML Directional: walk-forward LightGBM long/short models on triple-barrier labels.

For every completed candle two calibrated classifiers estimate the probability
that a long (or short) entry at the next open reaches its take-profit before its
stop-loss within ``max_hold_bars``. A trade is taken only when that probability,
converted to expected value in R after fees, spread and slippage, clears the
thresholds. Exits mirror the labels exactly (ATR take-profit, ATR stop, time
exit), so the predicted probability keeps its meaning.

Walk-forward folds are aligned to fixed UTC calendar blocks of ``trade_days``,
so a backtest, a paper replay and a live paper session trade any given candle
with the same trained model. Each fold trains on the preceding ``train_days``,
minus a purge gap of ``max_hold_bars + 1`` candles whose labels would look into
the traded block. Trained folds are cached by their exact training window.

``run_directional`` returns the shared engine contract (bars, trades,
open_position, cash) plus a ``report`` with fold, calibration and feature
diagnostics.
"""
from __future__ import annotations

import hashlib
import threading
from collections import OrderedDict
from dataclasses import asdict, dataclass

import numpy as np
import pandas as pd

from server.strategies.execution import ExecutionSettings, run_signal_backtest
from server.strategies.indicators import atr as wilder_atr

FEATURE_VERSION = 1
DAY = 86400
FEATURE_WARMUP_BARS = 3000  # Long EMAs and 4h context converge well within this.
TRADE_MODES = ('Both', 'Long Only', 'Short Only')
CANDIDATES_PER_TRADE = 3  # Rank mode: a candle qualifies when its score is the best of the last day/(trades_per_day x this), e.g. 8 h for 1/day.


@dataclass(frozen=True)
class DirectionalSettings:
    # Barriers: these define both the labels and the live exits.
    take_profit_atr: float = 4.5
    stop_atr: float = 3.0
    max_hold_bars: int = 48
    atr_length: int = 14
    # Walk-forward.
    train_days: int = 90
    trade_days: int = 30
    calibration_fraction: float = .15
    # Entry filters.
    min_probability: float = .5
    min_ev_r: float = .1
    min_gap: float = .1
    vol_low_pct: float = 10.
    vol_high_pct: float = 98.
    trade_mode: str = 'Both'
    # > 0: rank mode. A candle qualifies when its best-side probability is the highest of a trailing window
    # sized for this many trades per day, with the same number as a hard daily cap per UTC day;
    # min_probability, min_ev_r and min_gap are then not used.
    trades_per_day: float = 0.
    # Risk.
    risk_per_trade_pct: float = .5
    max_drawdown_pct: float = 0.
    # Model.
    trees: int = 300
    learning_rate: float = .03
    max_depth: int = 4
    min_leaf: int = 100
    seed: int = 7

    def __post_init__(self) -> None:
        def check(name, low, high, *, integer=False, low_open=False):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not np.isfinite(value):
                raise ValueError(f'{name} must be a finite number')
            if integer and int(value) != value:
                raise ValueError(f'{name} must be a whole number')
            if value > high or value < low or (low_open and value == low):
                raise ValueError(f'{name} must be between {low} and {high}')
        check('take_profit_atr', 0, 50, low_open=True)
        check('stop_atr', 0, 50, low_open=True)
        check('max_hold_bars', 1, 2000, integer=True)
        check('atr_length', 1, 500, integer=True)
        check('train_days', 7, 3650, integer=True)
        check('trade_days', 1, 365, integer=True)
        check('calibration_fraction', 0, .5)
        check('min_probability', 0, 1)
        check('min_ev_r', -10, 10)
        check('min_gap', -1, 1)
        check('vol_low_pct', 0, 100)
        check('vol_high_pct', 0, 100)
        check('trades_per_day', 0, 20)
        check('risk_per_trade_pct', 0, 10, low_open=True)
        check('max_drawdown_pct', 0, 99)
        check('trees', 10, 5000, integer=True)
        check('learning_rate', 0, 1, low_open=True)
        check('max_depth', 1, 16, integer=True)
        check('min_leaf', 5, 100000, integer=True)
        check('seed', 0, 2**31-1, integer=True)
        if self.vol_low_pct >= self.vol_high_pct:
            raise ValueError('vol_low_pct must be below vol_high_pct')
        if self.trade_mode not in TRADE_MODES:
            raise ValueError(f'trade_mode must be one of {", ".join(TRADE_MODES)}')

    def model_key(self, bar_seconds: int) -> str:
        """Fields that change a trained fold; entry thresholds do not."""
        parts = (FEATURE_VERSION, bar_seconds, self.take_profit_atr, self.stop_atr, self.max_hold_bars, self.atr_length,
                 self.train_days, self.trade_days, self.calibration_fraction, self.trees, self.learning_rate,
                 self.max_depth, self.min_leaf, self.seed)
        return repr(parts)


# --------------------------------------------------------------------------- features

def _ema(series: pd.Series, span: int) -> pd.Series:
    return series.ewm(span=span, adjust=False, min_periods=span).mean()


def _wilder(series: pd.Series, length: int) -> pd.Series:
    return series.ewm(alpha=1/length, adjust=False, min_periods=length).mean()


def _rsi(close: pd.Series, length: int = 14) -> pd.Series:
    delta = close.diff()
    gain, loss = _wilder(delta.clip(lower=0), length), _wilder(-delta.clip(upper=0), length)
    value = 100-100/(1+gain/loss.replace(0, np.nan))
    return value.where(loss != 0, 100.)  # No losses in the window: RSI 100.


def _adx(high: pd.Series, low: pd.Series, close: pd.Series, length: int = 14) -> pd.Series:
    up, down = high.diff(), -low.diff()
    plus = pd.Series(np.where((up > down) & (up > 0), up, 0.), index=close.index)
    minus = pd.Series(np.where((down > up) & (down > 0), down, 0.), index=close.index)
    previous = close.shift()
    tr = pd.concat([high-low, (high-previous).abs(), (low-previous).abs()], axis=1).max(axis=1)
    average = _wilder(tr, length).replace(0, np.nan)
    plus_di, minus_di = 100*_wilder(plus, length)/average, 100*_wilder(minus, length)/average
    dx = 100*(plus_di-minus_di).abs()/(plus_di+minus_di).replace(0, np.nan)
    return _wilder(dx, length)


def _higher_timeframe(frame: pd.DataFrame, rule: str, bar_seconds: int) -> pd.DataFrame:
    """Context from the last *completed* higher-timeframe candle at each bar's close."""
    name = f'htf_{rule}'
    columns = [f'{name}_trend', f'{name}_slope', f'{name}_rsi']
    candles = frame[['close']].resample(rule, label='left', closed='left').last().dropna()
    if candles.empty:
        return pd.DataFrame(np.nan, index=frame.index, columns=columns)
    close = candles.close
    ema = _ema(close, 20)
    context = pd.DataFrame({columns[0]: close/ema-1, columns[1]: ema.pct_change(3, fill_method=None),
                            columns[2]: _rsi(close)/100})
    context['close_time'] = candles.index+pd.Timedelta(rule)
    left = pd.DataFrame({'close_time': frame.index+pd.Timedelta(seconds=bar_seconds)})
    merged = pd.merge_asof(left, context.sort_values('close_time'), on='close_time', direction='backward')
    return merged[columns].set_axis(frame.index)


def build_features(frame: pd.DataFrame, bar_seconds: int, atr: pd.Series) -> pd.DataFrame:
    """Scale-free, causal features: row ``t`` uses candles up to and including ``t`` only."""
    o, h, l, c = (frame[k].astype(float) for k in ('open', 'high', 'low', 'close'))
    volume = frame['volume'].astype(float) if 'volume' in frame.columns else pd.Series(np.nan, index=frame.index)
    log_close = np.log(c)
    returns = log_close.diff()
    out = {f'ret_{k}': log_close-log_close.shift(k) for k in (1, 3, 6, 12, 24, 48)}
    atr_safe = atr.replace(0, np.nan)
    rv20, rv60 = returns.rolling(20).std(), returns.rolling(60).std()
    out.update(atr_pct=atr/c, rv_20=rv20, rv_60=rv60, vol_ratio=rv20/rv60.replace(0, np.nan))
    ema20 = _ema(c, 20)
    for span in (20, 50, 200):
        out[f'ema_{span}_dist'] = (c-_ema(c, span))/atr_safe
    out['ema_20_slope'] = (ema20-ema20.shift(5))/atr_safe
    out['adx'] = _adx(h, l, c)/100
    basis, std = c.rolling(20).mean(), c.rolling(20).std()
    width = 4*std/basis
    out.update(bb_pctb=(c-(basis-2*std))/(4*std).replace(0, np.nan), bb_width=width,
               bb_width_rank=width.rolling(500, min_periods=100).rank(pct=True),
               rsi=_rsi(c)/100, zscore_50=(c-c.rolling(50).mean())/c.rolling(50).std().replace(0, np.nan))
    span = (h-l).replace(0, np.nan)
    out.update(body=(c-o)/span, upper_wick=(h-np.maximum(o, c))/span, lower_wick=(np.minimum(o, c)-l)/span)
    mean_volume, std_volume = volume.rolling(20).mean(), volume.rolling(20).std()
    out.update(volume_ratio=volume/mean_volume.replace(0, np.nan), volume_z=(volume-mean_volume)/std_volume.replace(0, np.nan))
    features = pd.DataFrame(out, index=frame.index)
    for rule in ('1h', '4h'):
        features = features.join(_higher_timeframe(frame, rule, bar_seconds))
    hour = frame.index.hour+frame.index.minute/60
    features['hour_sin'], features['hour_cos'] = np.sin(2*np.pi*hour/24), np.cos(2*np.pi*hour/24)
    features['day_of_week'] = frame.index.dayofweek.astype(float)
    return features.replace([np.inf, -np.inf], np.nan)


# --------------------------------------------------------------------------- labels

def barrier_labels(frame: pd.DataFrame, atr: np.ndarray, settings: DirectionalSettings,
                   bar_seconds: int) -> tuple[np.ndarray, np.ndarray]:
    """1 when an entry at the next open hits take-profit before stop-loss within the hold window.

    A candle touching both barriers counts as a loss (stop first, like execution).
    Labels are NaN when the window is incomplete or spans a data gap.
    """
    o, h, l = (frame[k].to_numpy(float) for k in ('open', 'high', 'low'))
    n, hold = len(o), settings.max_hold_bars
    entry = np.r_[o[1:], np.nan]
    tp, sl = settings.take_profit_atr*atr, settings.stop_atr*atr
    results = []
    for direction in (1, -1):
        target, stop = entry+direction*tp, entry-direction*sl
        label, done = np.full(n, np.nan), np.zeros(n, bool)
        for k in range(1, hold+1):
            high, low = np.r_[h[k:], np.full(k, np.nan)], np.r_[l[k:], np.full(k, np.nan)]
            with np.errstate(invalid='ignore'):
                stop_hit = low <= stop if direction == 1 else high >= stop
                target_hit = high >= target if direction == 1 else low <= target
            new = ~done & (stop_hit | target_hit)
            label[new] = np.where(stop_hit[new], 0., 1.)
            done |= new
        complete = np.arange(n)+hold < n
        label[~done & complete] = 0.
        results.append(label)
    times = frame.index.asi8//10**9
    span = np.full(n, np.inf)
    span[:max(0, n-hold)] = times[hold:]-times[:max(0, n-hold)]
    invalid = ~np.isfinite(entry) | ~np.isfinite(atr) | (atr <= 0) | (span > hold*bar_seconds)
    for label in results:
        label[invalid] = np.nan
    return results[0], results[1]


# --------------------------------------------------------------------------- models

def _classifier(settings: DirectionalSettings):
    try:
        from lightgbm import LGBMClassifier
        return LGBMClassifier(n_estimators=settings.trees, learning_rate=settings.learning_rate,
                              max_depth=settings.max_depth, num_leaves=max(2, 2**settings.max_depth-1),
                              min_child_samples=settings.min_leaf, subsample=.7, subsample_freq=1,
                              colsample_bytree=.7, reg_lambda=1., random_state=settings.seed, verbose=-1)
    except ImportError:
        from sklearn.ensemble import HistGradientBoostingClassifier
        return HistGradientBoostingClassifier(max_iter=settings.trees, learning_rate=settings.learning_rate,
                                              max_depth=settings.max_depth, min_samples_leaf=settings.min_leaf,
                                              random_state=settings.seed)


@dataclass
class SideModel:
    model: object
    calibrator: object | None
    base_rate: float

    def predict(self, features: np.ndarray) -> np.ndarray:
        raw = self.model.predict_proba(features)[:, 1]
        return self.calibrator.predict(raw) if self.calibrator is not None else raw


@dataclass
class Fold:
    start: int
    end: int
    train_start: int
    train_end: int
    rows: int
    long: SideModel
    short: SideModel
    vol_low: float
    vol_high: float
    importance: dict


def _fit_side(features: np.ndarray, labels: np.ndarray, settings: DirectionalSettings) -> SideModel:
    n = len(labels)
    calibration = int(n*settings.calibration_fraction)
    fit_end = n-calibration-settings.max_hold_bars-1  # purge between fit and calibration rows
    use_calibration = calibration >= 200 and fit_end >= 500 and len(np.unique(labels[n-calibration:])) == 2 \
        and len(np.unique(labels[:fit_end])) == 2
    fit_rows = slice(0, fit_end) if use_calibration else slice(0, n)
    model = _classifier(settings)
    model.fit(features[fit_rows], labels[fit_rows])
    calibrator = None
    if use_calibration:
        # Platt scaling on the raw log-odds. Isotonic overfits the sparse high-probability
        # tail, which is exactly where entries happen.
        raw = model.predict_proba(features[n-calibration:])[:, 1]
        calibrator = PlattCalibrator().fit(raw, labels[n-calibration:])
    return SideModel(model, calibrator, float(np.mean(labels)))


class PlattCalibrator:
    def fit(self, raw: np.ndarray, labels: np.ndarray):
        from sklearn.linear_model import LogisticRegression
        self.model = LogisticRegression(C=1.).fit(self._logit(raw), labels)
        return self

    @staticmethod
    def _logit(raw: np.ndarray) -> np.ndarray:
        clipped = np.clip(raw, 1e-4, 1-1e-4)
        return np.log(clipped/(1-clipped)).reshape(-1, 1)

    def predict(self, raw: np.ndarray) -> np.ndarray:
        return self.model.predict_proba(self._logit(raw))[:, 1]


def _importance(model, names: list[str]) -> dict:
    booster = getattr(model, 'booster_', None)
    if booster is None:
        return {}
    gain = booster.feature_importance(importance_type='gain')
    total = float(gain.sum()) or 1.
    return {name: float(value/total) for name, value in zip(names, gain)}


class _FoldCache:
    def __init__(self, size: int = 64):
        self.size, self.items, self.lock = size, OrderedDict(), threading.Lock()

    def get(self, key):
        with self.lock:
            if key in self.items:
                self.items.move_to_end(key)
                return self.items[key]
        return None

    def put(self, key, value):
        with self.lock:
            self.items[key] = value
            self.items.move_to_end(key)
            while len(self.items) > self.size:
                self.items.popitem(last=False)

    def clear(self):
        with self.lock:
            self.items.clear()


FOLD_CACHE = _FoldCache()


def fold_bounds(first_time: int, last_time: int, settings: DirectionalSettings) -> list[int]:
    """Start times (UTC seconds) of calendar-aligned trade blocks covering ``[first_time, last_time]``."""
    period = settings.trade_days*DAY
    return [k*period for k in range(first_time//period, last_time//period+1)]


def required_history_start(first_time: int, settings: DirectionalSettings, bar_seconds: int) -> int:
    """Earliest candle time needed to train the fold that trades ``first_time``."""
    return fold_bounds(first_time, first_time, settings)[0]-settings.train_days*DAY-FEATURE_WARMUP_BARS*bar_seconds


def _train_fold(fold_start: int, times: np.ndarray, features: pd.DataFrame, labels: tuple[np.ndarray, np.ndarray],
                atr_pct: np.ndarray, closes: np.ndarray, settings: DirectionalSettings, bar_seconds: int):
    period = settings.trade_days*DAY
    first = int(np.searchsorted(times, fold_start-settings.train_days*DAY))
    last = int(np.searchsorted(times, fold_start))-settings.max_hold_bars-1  # purge: labels must end before the block
    if last-first < .5*settings.train_days*DAY/bar_seconds:
        return None, 'not enough training candles'
    rows = np.arange(first, last)
    long_y, short_y = labels[0][rows], labels[1][rows]
    usable = np.isfinite(long_y) & np.isfinite(short_y)
    rows = rows[usable]
    if len(rows) < .4*settings.train_days*DAY/bar_seconds:
        return None, 'not enough labelled candles'
    long_y, short_y = labels[0][rows], labels[1][rows]
    if min(long_y.sum(), short_y.sum(), (1-long_y).sum(), (1-short_y).sum()) < 50:
        return None, 'too few wins or losses to learn from'
    digest = hashlib.sha1(np.ascontiguousarray(closes[first:last]).tobytes()).hexdigest()
    key = (settings.model_key(bar_seconds), fold_start, int(times[first]), int(times[last-1]), len(rows), digest)
    cached = FOLD_CACHE.get(key)
    if cached is not None:
        return cached, 'cached'
    matrix = features.to_numpy(float)[rows]
    long_model = _fit_side(matrix, long_y, settings)
    short_model = _fit_side(matrix, short_y, settings)
    names = list(features.columns)
    long_importance, short_importance = _importance(long_model.model, names), _importance(short_model.model, names)
    importance = {name: (long_importance.get(name, 0.)+short_importance.get(name, 0.))/2 for name in names}
    vol = atr_pct[first:last]
    vol = vol[np.isfinite(vol)]
    vol_low, vol_high = float(np.percentile(vol, settings.vol_low_pct)), float(np.percentile(vol, settings.vol_high_pct))
    fold = Fold(start=fold_start, end=fold_start+period, train_start=int(times[first]), train_end=int(times[last-1]),
                rows=len(rows), long=long_model, short=short_model, vol_low=vol_low, vol_high=vol_high,
                importance=importance)
    FOLD_CACHE.put(key, fold)
    return fold, None


# --------------------------------------------------------------------------- signals and backtest

@dataclass
class Prepared:
    frame: pd.DataFrame          # Input candles plus model columns.
    labels: tuple[np.ndarray, np.ndarray]
    folds: list[Fold]
    skipped: list[dict]
    first: int                   # Position of the first predicted candle.
    reused: int = 0              # Folds served from the trained-model cache.


def prepare(frame: pd.DataFrame, settings: DirectionalSettings, *, start=None, bar_seconds: int = 300,
            fee_bps=0., slippage=0., spread=0.) -> Prepared:
    frame = frame.dropna(subset=['open', 'high', 'low', 'close']).copy()
    n = len(frame)
    atr = wilder_atr(frame, settings.atr_length)
    features = build_features(frame, bar_seconds, pd.Series(atr, index=frame.index))
    labels = barrier_labels(frame, atr, settings, bar_seconds)
    times = frame.index.asi8//10**9
    closes = frame.close.to_numpy(float)
    atr_pct = atr/closes
    first = int(np.searchsorted(times, int(pd.Timestamp(start).timestamp()))) if start is not None else 0
    p_long, p_short = np.full(n, np.nan), np.full(n, np.nan)
    vol_ok, fold_id = np.zeros(n, bool), np.full(n, -1)
    folds, skipped, reused = [], [], 0
    if first < n:
        for fold_start in fold_bounds(int(times[first]), int(times[-1]), settings):
            left = max(first, int(np.searchsorted(times, fold_start)))
            right = int(np.searchsorted(times, fold_start+settings.trade_days*DAY))
            if left >= right:
                continue
            fold, reason = _train_fold(fold_start, times, features, labels, atr_pct, closes, settings, bar_seconds)
            if fold is None:
                skipped.append(dict(start=fold_start, end=fold_start+settings.trade_days*DAY, reason=reason))
                continue
            reused += reason == 'cached'
            rows = slice(left, right)
            matrix = features.iloc[rows].to_numpy(float)
            p_long[rows], p_short[rows] = fold.long.predict(matrix), fold.short.predict(matrix)
            with np.errstate(invalid='ignore'):
                vol_ok[rows] = (atr_pct[rows] >= fold.vol_low) & (atr_pct[rows] <= fold.vol_high)
            fold_id[rows] = len(folds)
            folds.append(fold)
    rank_threshold = np.full(n, np.nan)
    if settings.trades_per_day:
        # Highest best-side score of the preceding window (volatility-eligible candles only), so qualifying
        # candles occur at a steady rate whatever the model's current probability level.
        window = max(2, int(round(DAY/bar_seconds/(settings.trades_per_day*CANDIDATES_PER_TRADE))))
        best = pd.Series(np.where(vol_ok, np.fmax(p_long, p_short), np.nan))
        rank_threshold = best.shift(1).rolling(window, min_periods=window//2).max().to_numpy()
    reward = settings.take_profit_atr/settings.stop_atr
    with np.errstate(invalid='ignore', divide='ignore'):
        cost_r = (2*fee_bps/10000*closes+2*slippage+spread)/(settings.stop_atr*atr)
        ev_long, ev_short = p_long*reward-(1-p_long)-cost_r, p_short*reward-(1-p_short)-cost_r
    frame = frame.assign(atr=atr, atr_pct=atr_pct, p_long=p_long, p_short=p_short, ev_long=ev_long, ev_short=ev_short,
                         cost_r=cost_r, vol_ok=vol_ok, fold=fold_id, rank_threshold=rank_threshold)
    frame['ml_signal'] = signals_from(frame, settings)
    return Prepared(frame, labels, folds, skipped, first, reused)


def side_checks(p, p_other, ev, vol_ok, allowed, settings: DirectionalSettings,
                rank_threshold=np.nan) -> list[tuple[str, bool, float | None, float | None]]:
    """Entry conditions for one side: shared by signal generation and readiness."""
    trained = bool(np.isfinite(p))
    if settings.trades_per_day:
        bar = float(rank_threshold) if np.isfinite(rank_threshold) else None
        return [('Model trained', trained, None, None),
                (f'Best of recent candles (~{settings.trades_per_day:g}/day)', trained and bar is not None and p > bar,
                 float(p) if trained else None, bar),
                ('Higher than other side', trained and bool(np.isfinite(p_other)) and p > p_other,
                 float(p-p_other) if trained and np.isfinite(p_other) else None, 0.),
                ('Volatility in range', bool(vol_ok), None, None),
                ('Direction allowed', bool(allowed), None, None)]
    return [('Model trained', trained, None, None),
            ('Win probability', trained and p >= settings.min_probability, float(p) if trained else None, settings.min_probability),
            ('Expected value (R)', bool(np.isfinite(ev) and ev >= settings.min_ev_r), float(ev) if np.isfinite(ev) else None, settings.min_ev_r),
            ('Lead over other side', trained and bool(np.isfinite(p_other)) and p-p_other >= settings.min_gap,
             float(p-p_other) if trained and np.isfinite(p_other) else None, settings.min_gap),
            ('Volatility in range', bool(vol_ok), None, None),
            ('Direction allowed', bool(allowed), None, None)]


def signals_from(frame: pd.DataFrame, settings: DirectionalSettings) -> np.ndarray:
    p_long, p_short = frame.p_long.to_numpy(), frame.p_short.to_numpy()
    if settings.trades_per_day:
        bar, vol = frame.rank_threshold.to_numpy(), frame.vol_ok.to_numpy()
        with np.errstate(invalid='ignore'):
            long = (p_long > bar) & (p_long > p_short) & vol & (settings.trade_mode != 'Short Only')
            short = (p_short > bar) & (p_short > p_long) & vol & (settings.trade_mode != 'Long Only')
        return np.where(long, 1., np.where(short, -1., 0.))
    with np.errstate(invalid='ignore'):
        long = (p_long >= settings.min_probability) & (frame.ev_long.to_numpy() >= settings.min_ev_r) \
            & (p_long-p_short >= settings.min_gap) & frame.vol_ok.to_numpy() & (settings.trade_mode != 'Short Only')
        short = (p_short >= settings.min_probability) & (frame.ev_short.to_numpy() >= settings.min_ev_r) \
            & (p_short-p_long >= settings.min_gap) & frame.vol_ok.to_numpy() & (settings.trade_mode != 'Long Only')
    return np.where(long & ~short, 1., np.where(short & ~long, -1., 0.))


def _auc(labels: np.ndarray, scores: np.ndarray) -> float | None:
    mask = np.isfinite(labels) & np.isfinite(scores)
    if mask.sum() < 50 or len(np.unique(labels[mask])) < 2:
        return None
    from sklearn.metrics import roc_auc_score
    return float(roc_auc_score(labels[mask], scores[mask]))


def build_report(prepared: Prepared, trades: pd.DataFrame, settings: DirectionalSettings) -> dict:
    frame, (long_y, short_y), first = prepared.frame, prepared.labels, prepared.first
    p_long, p_short = frame.p_long.to_numpy(), frame.p_short.to_numpy()
    times = frame.index.asi8//10**9
    entries = (trades.entry_time.map(lambda t: int(t.timestamp())).to_numpy() if len(trades) else np.array([], int))
    pnl = trades.pnl.to_numpy(float) if len(trades) else np.array([])
    folds = []
    for i, fold in enumerate(prepared.folds):
        rows = frame.fold.to_numpy() == i
        in_fold = (entries >= fold.start) & (entries < fold.end)
        folds.append(dict(start=fold.start, end=min(fold.end, int(times[-1])), trainStart=fold.train_start,
                          trainEnd=fold.train_end, trainRows=fold.rows,
                          baseRateLong=fold.long.base_rate, baseRateShort=fold.short.base_rate,
                          aucLong=_auc(long_y[rows], p_long[rows]), aucShort=_auc(short_y[rows], p_short[rows]),
                          signals=int(np.abs(frame.ml_signal.to_numpy()[rows]).sum()),
                          trades=int(in_fold.sum()), netPnl=float(pnl[in_fold].sum()),
                          calibrated=fold.long.calibrator is not None))
    # Calibration: predicted probability buckets against realised barrier outcomes, both sides pooled.
    predicted = np.r_[p_long[first:], p_short[first:]]
    actual = np.r_[long_y[first:], short_y[first:]]
    mask = np.isfinite(predicted) & np.isfinite(actual)
    edges = np.arange(0., 1.0001, .05)
    calibration = []
    for low, high in zip(edges[:-1], edges[1:]):
        bucket = mask & (predicted >= low) & ((predicted < high) if high < 1 else (predicted <= high))
        if bucket.sum() >= 20:
            calibration.append(dict(low=float(low), high=float(high), count=int(bucket.sum()),
                                    predicted=float(predicted[bucket].mean()), actual=float(actual[bucket].mean())))
    importance = {}
    for fold in prepared.folds:
        for name, value in fold.importance.items():
            importance[name] = importance.get(name, 0.)+value/len(prepared.folds)
    top = sorted(importance.items(), key=lambda item: -item[1])[:15]
    reward = settings.take_profit_atr/settings.stop_atr
    message = (f'{len(prepared.folds)} walk-forward fold(s) traded'
               + (f', {len(prepared.skipped)} skipped' if prepared.skipped else '')
               + f'. Break-even win rate before costs: {100/(1+reward):.1f}%.')
    cost = frame.cost_r.to_numpy()[first:]
    return dict(kind='ml_directional', message=message, folds=folds, skippedFolds=prepared.skipped,
                predictionVsActual=prediction_vs_actual(trades, settings),
                calibration=calibration, featureImportance=[dict(name=k, value=v) for k, v in top],
                averageCostR=float(np.nanmedian(cost)) if np.isfinite(cost).any() else None,
                breakEvenWinRate=1/(1+reward))


def train_blocks(frame: pd.DataFrame, settings: DirectionalSettings, *, start, bar_seconds: int) -> dict:
    """Train (or reuse) every walk-forward block covering ``start`` onwards and summarise model quality.

    Backtests and paper sessions with the same training settings reuse these models from the cache.
    """
    import time
    began = time.perf_counter()
    prepared = prepare(frame, settings, start=start, bar_seconds=bar_seconds)
    long_y, short_y = prepared.labels
    p_long, p_short = prepared.frame.p_long.to_numpy(), prepared.frame.p_short.to_numpy()
    fold_ids = prepared.frame.fold.to_numpy()
    blocks = []
    for i, fold in enumerate(prepared.folds):
        rows = fold_ids == i
        blocks.append(dict(start=fold.start, end=fold.end, trainStart=fold.train_start, trainEnd=fold.train_end,
                           trainRows=fold.rows, aucLong=_auc(long_y[rows], p_long[rows]),
                           aucShort=_auc(short_y[rows], p_short[rows]), calibrated=fold.long.calibrator is not None))
    aucs = [value for block in blocks for value in (block['aucLong'], block['aucShort']) if value is not None]
    return dict(blocks=blocks, skipped=prepared.skipped, trained=len(prepared.folds)-prepared.reused,
                reused=prepared.reused, meanAuc=float(np.mean(aucs)) if aucs else None,
                seconds=round(time.perf_counter()-began, 1))


def run_directional(frame: pd.DataFrame, settings: DirectionalSettings, *, initial_capital: float, leverage: float,
                    start=None, close_at_end=False, bar_seconds=None, min_tick=.01,
                    fee_bps=0., slippage=0., spread=0., funding_bps=0.) -> dict:
    bar_seconds = int(bar_seconds or 300)
    prepared = prepare(frame, settings, start=start, bar_seconds=bar_seconds, fee_bps=fee_bps, slippage=slippage, spread=spread)
    bars = prepared.frame
    atr = bars.atr.to_numpy()
    signals = bars.ml_signal.to_numpy().copy()
    signals[:prepared.first] = 0.
    execution = ExecutionSettings(initial_capital=initial_capital, leverage=leverage, amount_per_trade=100.,
                                  amount_unit='percent', max_hold_bars=settings.max_hold_bars, reverse_on_signal=False,
                                  min_tick=min_tick, next_open=True, risk_per_trade_pct=settings.risk_per_trade_pct,
                                  max_drawdown_pct=settings.max_drawdown_pct,
                                  max_entries_per_day=int(np.ceil(settings.trades_per_day)))
    result = run_signal_backtest(bars, signals, settings.stop_atr*atr, settings.take_profit_atr*atr, execution,
                                 start=start, close_at_end=close_at_end, bar_seconds=bar_seconds,
                                 fee_bps=fee_bps, slippage=slippage, spread=spread, funding_bps=funding_bps)
    annotate_trades(result['trades'], bars)
    result['report'] = dict(build_report(prepared, result['trades'], settings), executionAudit=result['audit'])
    return result


def annotate_trades(trades: pd.DataFrame, bars: pd.DataFrame) -> None:
    """Attach the model's view at each trade's signal candle (the candle before the next-open entry)."""
    if not len(trades):
        for column in ('model_probability', 'model_other_probability', 'signal_time'):
            trades[column] = pd.Series(dtype=float)
        return
    positions = bars.index.get_indexer(trades.entry_time)-1
    valid = positions >= 0
    signal = np.where(valid, positions, 0)
    p_long, p_short = bars.p_long.to_numpy()[signal], bars.p_short.to_numpy()[signal]
    long = trades.direction.to_numpy() == 1
    trades['model_probability'] = np.where(valid, np.where(long, p_long, p_short), np.nan)
    trades['model_other_probability'] = np.where(valid, np.where(long, p_short, p_long), np.nan)
    trades['signal_time'] = [bars.index[i] if ok else pd.NaT for i, ok in zip(signal, valid)]


def prediction_vs_actual(trades: pd.DataFrame, settings: DirectionalSettings) -> dict:
    """Compare each trade's predicted take-profit chance with what happened."""
    if not len(trades) or 'model_probability' not in trades:
        return dict(trades=0, buckets=[], rows=[])
    predicted = trades.model_probability.to_numpy(float)
    reached = (trades.exit_reason == 'take_profit').to_numpy()
    profitable = (trades.pnl > 0).to_numpy()
    risk = (trades.entry_price-trades.initial_stop).abs()*trades.quantity
    r_multiple = (trades.pnl/risk.replace(0, np.nan)).to_numpy(float)
    buckets = []
    for low in np.arange(0., 1., .05):
        mask = np.isfinite(predicted) & (predicted >= low) & (predicted < low+.05 if low < .95 else predicted <= 1)
        if mask.any():
            buckets.append(dict(low=float(low), high=float(low+.05), trades=int(mask.sum()),
                                predicted=float(predicted[mask].mean()), reachedTarget=float(reached[mask].mean()),
                                profitable=float(profitable[mask].mean()), averageR=float(np.nanmean(r_multiple[mask]))))
    rows = [dict(signalTime=int(signal.timestamp()) if pd.notna(signal) else None, entryTime=int(entry.timestamp()),
                 exitTime=int(exit_.timestamp()), direction=int(direction), predicted=None if not np.isfinite(p) else float(p),
                 other=None if not np.isfinite(o) else float(o), entry=float(ep), exit=float(xp), target=None if target is None else float(target),
                 stop=float(stop), exitReason=reason, reachedTarget=bool(hit), netPnl=float(pnl), r=None if not np.isfinite(r) else float(r))
            for signal, entry, exit_, direction, p, o, ep, xp, target, stop, reason, hit, pnl, r in zip(
                trades.signal_time, trades.entry_time, trades.exit_time, trades.direction, predicted,
                trades.model_other_probability.to_numpy(float), trades.entry_price, trades.exit_price,
                trades.target, trades.initial_stop, trades.exit_reason, reached, trades.pnl, r_multiple)]
    finite = np.isfinite(predicted)
    return dict(trades=len(trades), averagePredicted=float(predicted[finite].mean()) if finite.any() else None,
                reachedTarget=float(reached.mean()), profitable=float(profitable.mean()),
                breakEven=1/(1+settings.take_profit_atr/settings.stop_atr), buckets=buckets, rows=rows[-2000:])


def directional_readiness(bar, settings: DirectionalSettings) -> dict:
    def value(name):
        number = getattr(bar, name, np.nan)
        try:
            number = float(number)
        except (TypeError, ValueError):
            return np.nan
        return number

    p_long, p_short, ev_long, ev_short = (value(k) for k in ('p_long', 'p_short', 'ev_long', 'ev_short'))
    vol_ok = bool(getattr(bar, 'vol_ok', False))

    def side(p, other, ev, allowed):
        checks = side_checks(p, other, ev, vol_ok, allowed, settings, value('rank_threshold'))
        return round(100*sum(int(c[1]) for c in checks)/len(checks)), [
            dict(label=label, passed=bool(passed), value=val, threshold=threshold) for label, passed, val, threshold in checks]

    long_ready, long_checks = side(p_long, p_short, ev_long, settings.trade_mode != 'Short Only')
    short_ready, short_checks = side(p_short, p_long, ev_short, settings.trade_mode != 'Long Only')
    signal = value('ml_signal')

    def finite(number):
        return float(number) if np.isfinite(number) else None
    return dict(indicators=dict(pLong=finite(p_long), pShort=finite(p_short), evLong=finite(ev_long),
                                evShort=finite(ev_short), atr=finite(value('atr'))),
                longReadiness=long_ready, shortReadiness=short_ready, longChecks=long_checks, shortChecks=short_checks,
                signal='long' if signal == 1 else 'short' if signal == -1 else None)


def settings_from(config: dict) -> DirectionalSettings:
    try:
        return DirectionalSettings(**config)
    except TypeError as error:
        raise ValueError(f'Invalid ML Directional setting: {error}') from error


DEFAULTS = asdict(DirectionalSettings())

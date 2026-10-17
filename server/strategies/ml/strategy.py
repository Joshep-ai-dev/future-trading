"""ML Ensemble strategy: indicator features -> walk-forward models -> ATR-bracketed trades.

``run_ml_backtest`` has the same output contract as the BB engine (bars,
trades, open_position, cash) plus ``probabilities`` and a ``report`` with fold
accuracy and feature importance, so backtests, paper trading and the
dashboard can treat both strategies uniformly.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field

import numpy as np
import pandas as pd

from server.strategies.execution import ExecutionSettings, run_signal_backtest
from server.strategies.ml.features import DEFAULT_GROUPS, FEATURE_GROUPS, build_features
from server.strategies.ml.exits import REGIME_NAMES
from server.strategies.ml.labels import excursions, triple_barrier
from server.strategies.ml.models import MODELS
from server.strategies.ml.walk_forward import config_key, walk_forward

DEFAULT_MODELS = {'lightgbm': 1., 'xgboost': 0., 'hist_gbm': 0., 'random_forest': 0., 'extra_trees': .5,
                  'logistic': 0., 'neural_net': 0.}


@dataclass
class MLSettings:
    feature_groups: list[str] = field(default_factory=lambda: list(DEFAULT_GROUPS))
    models: dict[str, float] = field(default_factory=lambda: dict(DEFAULT_MODELS))
    horizon: int = 12
    take_profit_atr: float = 1.5
    stop_atr: float = 1.0
    atr_length: int = 14
    entry_threshold: float = .55
    min_edge: float = .15
    min_reward_cost: float = 3.
    train_bars: int = 6000
    retrain_every: int = 2000
    trade_mode: str = 'Both'
    reverse_on_signal: bool = True
    amount_per_trade: float = 100.
    amount_unit: str = 'percent'
    capacity: str = 'standard'
    # Learned exits: quantile models decide take-profit, stop and trailing per trade.
    exit_mode: str = 'learned'
    tp_quantile: float = .4
    sl_quantile: float = .7
    min_reward_risk: float = 1.2
    trailing: bool = True
    trail_start: float = .6
    trail_noise: float = 1.
    regimes: list[str] = field(default_factory=lambda: list(REGIME_NAMES))
    # Recent candles matter more: training weights halve every ``recency_half_life`` candles back (0 = equal).
    recency_half_life: int = 2000

    def __post_init__(self):
        unknown = [key for key in self.feature_groups if key not in FEATURE_GROUPS]
        if unknown or not self.feature_groups:
            raise ValueError('Choose at least one valid feature group')
        self.models = {key: float(weight) for key, weight in self.models.items() if key in MODELS}
        if not any(weight > 0 for weight in self.models.values()):
            raise ValueError('Enable at least one model with a positive weight')
        missing = [MODELS[key].label for key, weight in self.models.items() if weight > 0 and not MODELS[key].available()]
        if missing:
            raise ValueError(f'Install the packages for: {", ".join(missing)}')
        checks = [(1 <= self.horizon <= 500, 'Horizon must be 1-500 candles'),
                  (0 < self.take_profit_atr <= 20 and 0 < self.stop_atr <= 20, 'ATR multiples must be between 0 and 20'),
                  (2 <= self.atr_length <= 500, 'ATR length must be 2-500'),
                  (.34 <= self.entry_threshold < 1, 'Entry probability must be between 0.34 and 1'),
                  (0 <= self.min_edge < 1, 'Minimum edge must be between 0 and 1'),
                  (0 <= self.min_reward_cost <= 50, 'Reward-to-cost ratio must be 0-50'),
                  (500 <= self.train_bars <= 200_000, 'Training window must be 500-200000 candles'),
                  (50 <= self.retrain_every <= 50_000, 'Retrain interval must be 50-50000 candles'),
                  (self.trade_mode in ('Both', 'Long Only', 'Short Only'), 'Invalid trade mode'),
                  (self.amount_per_trade > 0 and (self.amount_unit != 'percent' or self.amount_per_trade <= 100), 'Invalid amount per trade'),
                  (self.amount_unit in ('percent', 'price'), 'Invalid amount unit'),
                  (self.capacity in ('light', 'standard', 'rich'), 'Model capacity must be light, standard or rich'),
                  (self.exit_mode in ('learned', 'fixed'), 'Exit mode must be learned or fixed'),
                  (.05 <= self.tp_quantile <= .95 and .05 <= self.sl_quantile <= .95, 'Exit quantiles must be 0.05-0.95'),
                  (0 <= self.min_reward_risk <= 10, 'Minimum reward/risk must be 0-10'),
                  (.1 <= self.trail_start <= 2 and .2 <= self.trail_noise <= 5, 'Trailing settings out of range'),
                  (bool(self.regimes) and all(name in REGIME_NAMES for name in self.regimes), 'Choose at least one valid market regime'),
                  (0 <= self.recency_half_life <= 200_000, 'Recency half-life must be 0-200000 candles')]
        for valid, message in checks:
            if not valid:
                raise ValueError(message)

    @property
    def warmup_bars(self) -> int:
        return self.train_bars+self.horizon+200

    def model_key(self) -> str:
        """Identity of everything that changes a trained fold (not sizing or entry rules)."""
        return config_key(groups=sorted(self.feature_groups), models=self.models, horizon=self.horizon,
                          tp=self.take_profit_atr, sl=self.stop_atr, atr=self.atr_length, capacity=self.capacity,
                          exits=self.exit_mode, quantiles=(self.tp_quantile, self.sl_quantile) if self.exit_mode == 'learned' else None,
                          recency=self.recency_half_life)


def _atr(frame: pd.DataFrame, length: int) -> pd.Series:
    previous = frame.close.shift()
    tr = pd.concat([frame.high-frame.low, (frame.high-previous).abs(), (frame.low-previous).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1/length, adjust=False, min_periods=length).mean()


def exit_plan(probabilities: pd.DataFrame, atr: pd.Series, settings: MLSettings) -> dict[str, np.ndarray]:
    """Per-bar take-profit, stop and trailing distances (price units) for both sides.

    Learned mode uses the block's quantile predictions (ATR units) and falls back
    to the fixed ATR multiples where a block has no exit model.
    """
    distance = atr.to_numpy(float)
    n = len(distance)
    def learned(column, fallback):
        if settings.exit_mode == 'learned' and column in probabilities:
            values = probabilities[column].to_numpy(float)
            return np.where(np.isfinite(values), values, fallback)
        return np.full(n, fallback)
    plan = {}
    for side in ('long', 'short'):
        tp, sl = learned(f'{side}_tp', settings.take_profit_atr), learned(f'{side}_sl', settings.stop_atr)
        plan[f'{side}_target'], plan[f'{side}_stop'] = tp*distance, sl*distance
        plan[f'{side}_rr'] = tp/np.maximum(sl, 1e-9)
        plan[f'{side}_trail_start'] = tp*settings.trail_start*distance if settings.trailing else np.full(n, np.nan)
        plan[f'{side}_trail'] = sl*settings.trail_noise*distance if settings.trailing else np.full(n, np.nan)
    p_long = probabilities.p_long.to_numpy()
    p_short = probabilities.p_short.to_numpy()
    plan['reward_risk'] = np.where(np.nan_to_num(p_short) > np.nan_to_num(p_long), plan['short_rr'], plan['long_rr'])
    return plan


def signals_from(probabilities: pd.DataFrame, settings: MLSettings) -> np.ndarray:
    p_long, p_short = probabilities.p_long.to_numpy(), probabilities.p_short.to_numpy()
    long = (p_long >= settings.entry_threshold) & (p_long-p_short >= settings.min_edge)
    short = (p_short >= settings.entry_threshold) & (p_short-p_long >= settings.min_edge)
    if settings.trade_mode == 'Long Only':
        short[:] = False
    if settings.trade_mode == 'Short Only':
        long[:] = False
    return np.where(long, 1, np.where(short, -1, 0)).astype(float)


@dataclass
class Prepared:
    clean: pd.DataFrame
    atr: pd.Series
    features_count: int
    labels: pd.Series
    start_index: int
    walk: object


def prepare(frame: pd.DataFrame, settings: MLSettings, start=None, progress=None) -> Prepared:
    """Features, labels and walk-forward probabilities: the expensive, cacheable part."""
    clean = frame.dropna(subset=['open', 'high', 'low', 'close'])
    if len(clean) < 2:
        raise ValueError('Not enough candles for the ML strategy')
    atr = _atr(clean, settings.atr_length)
    features = build_features(clean, settings.feature_groups)
    labels = triple_barrier(clean, atr, settings.horizon, settings.take_profit_atr, settings.stop_atr)
    start_index = int(np.searchsorted(clean.index, start)) if start is not None else 0
    targets = excursions(clean, atr, settings.horizon) if settings.exit_mode == 'learned' else None
    result = walk_forward(features, labels, start_index=start_index, train_bars=settings.train_bars,
                          retrain_every=settings.retrain_every, horizon=settings.horizon,
                          models=settings.models, key=settings.model_key(), capacity=settings.capacity, progress=progress,
                          exit_targets=targets, quantiles=(settings.tp_quantile, settings.sl_quantile),
                          half_life=settings.recency_half_life)
    return Prepared(clean, atr, features.shape[1], labels, start_index, result)


def execute(prepared: Prepared, settings: MLSettings, *, initial_capital: float, leverage: float, start=None, end=None,
            close_at_end=False, bar_seconds=None, min_tick=.01, fee_bps=0., slippage=0., spread=0., funding_bps=0.):
    """Turn prepared probabilities into trades with the given entry rules (cheap)."""
    clean, atr, result = prepared.clean, prepared.atr, prepared.walk
    start_index = prepared.start_index
    plan = exit_plan(result.probabilities, atr, settings)
    signals = signals_from(result.probabilities, settings)
    raw_signals = signals.copy()
    distance = atr.to_numpy()
    # Learned risk/reward and regime filters.
    signals = np.where(plan['reward_risk'] >= settings.min_reward_risk, signals, 0.)
    blocked_by_reward_risk = int(((raw_signals != 0) & (signals == 0))[start_index:].sum())
    regime_codes = result.probabilities['regime'].to_numpy() if 'regime' in result.probabilities else np.full(len(clean), -1)
    allowed = np.isin(regime_codes, [REGIME_NAMES.index(name) for name in settings.regimes]) | (regime_codes < 0)
    blocked_by_regime = int(((signals != 0) & ~allowed)[start_index:].sum())
    signals = np.where(allowed, signals, 0.)
    # Skip entries whose take-profit cannot pay for the round trip several times over.
    close = clean.close.to_numpy()
    round_trip = 2*(slippage+spread/2)+2*close*fee_bps/10000
    target_for_signal = np.where(signals == -1, plan['short_target'], plan['long_target'])
    affordable = target_for_signal >= settings.min_reward_cost*round_trip
    blocked_by_cost = int(((signals != 0) & ~affordable)[start_index:].sum())
    signals = np.where(affordable, signals, 0.)
    stop_distance = np.where(signals == -1, plan['short_stop'], plan['long_stop'])
    target_distance = target_for_signal
    trail_activation = np.where(signals == -1, plan['short_trail_start'], plan['long_trail_start'])
    trail_distance = np.where(signals == -1, plan['short_trail'], plan['long_trail'])
    execution = ExecutionSettings(initial_capital=initial_capital, leverage=leverage,
                                  amount_per_trade=settings.amount_per_trade, amount_unit=settings.amount_unit,
                                  max_hold_bars=settings.horizon, reverse_on_signal=settings.reverse_on_signal,
                                  min_tick=min_tick)
    bars = clean.join(result.probabilities).assign(atr=atr)
    if end is not None:
        keep = bars.index <= end
        bars, signals, distance = bars.loc[keep], signals[keep], distance[keep]
        stop_distance, target_distance = stop_distance[keep], target_distance[keep]
        trail_activation, trail_distance = trail_activation[keep], trail_distance[keep]
    output = run_signal_backtest(bars, signals, stop_distance, target_distance, execution,
                                 start=start, close_at_end=close_at_end, bar_seconds=bar_seconds,
                                 fee_bps=fee_bps, slippage=slippage, spread=spread, funding_bps=funding_bps,
                                 trail_activation=trail_activation, trail_distance=trail_distance)
    trades = output['trades']
    if len(trades):
        codes = bars['regime'].reindex(trades.entry_time).to_numpy() if 'regime' in bars else np.full(len(trades), -1)
        trades['regime'] = [REGIME_NAMES[int(code)] if code >= 0 else 'Unknown' for code in np.nan_to_num(codes, nan=-1)]
    labels = prepared.labels
    evaluated = result.probabilities[['p_short', 'p_none', 'p_long']].iloc[start_index:]
    known = labels.iloc[start_index:].notna() & evaluated.p_long.notna()
    evaluated_cost = round_trip[start_index:]
    window = slice(start_index, len(clean) if end is None else int(np.searchsorted(clean.index, end, side='right')))
    regimes_in_window = regime_codes[window]
    regime_stats = []
    for code, name in enumerate(REGIME_NAMES):
        chosen = trades[trades.regime == name] if len(trades) and 'regime' in trades else trades.iloc[0:0]
        regime_stats.append(dict(name=name, share=float((regimes_in_window == code).mean()) if len(regimes_in_window) else 0.,
                                 trades=int(len(chosen)), netPnl=float(chosen.pnl.sum()) if len(chosen) else 0.,
                                 winRate=float((chosen.pnl > 0).mean()*100) if len(chosen) else None,
                                 allowed=name in settings.regimes))
    learned_window = result.probabilities.iloc[window]
    output['report'] = dict(exitMode=settings.exit_mode, regimes=regime_stats,
                            blockedByRewardRisk=blocked_by_reward_risk, blockedByRegime=blocked_by_regime,
                            learnedExits={column: float(np.nanmedian(learned_window[column])) if column in learned_window and learned_window[column].notna().any() else None
                                          for column in ('long_tp', 'long_sl', 'short_tp', 'short_sl')},
                            blockedByCost=blocked_by_cost,
                            medianTarget=float(np.nanmedian((distance*settings.take_profit_atr)[start_index:])) if len(evaluated_cost) else None,
                            medianRoundTripCost=float(np.nanmedian(evaluated_cost)) if len(evaluated_cost) else None,
                            folds=result.folds, importance=dict(list(result.importance.items())[:25]),
                            featureCount=prepared.features_count, trainedBars=int(sum(f['bars'] for f in result.folds)),
                            labelBalance={name: float((labels.iloc[start_index:] == value).mean())
                                          for name, value in (('long', 1), ('none', 0), ('short', -1))},
                            accuracy=float((np.array([-1, 0, 1])[np.argmax(evaluated[known].to_numpy(), axis=1)]
                                            == labels.iloc[start_index:][known].to_numpy()).mean()) if known.any() else None,
                            settings=asdict(settings))
    return output


def run_ml_backtest(frame: pd.DataFrame, settings: MLSettings, *, initial_capital: float, leverage: float,
                    start=None, close_at_end=False, bar_seconds=None, min_tick=.01,
                    fee_bps=0., slippage=0., spread=0., funding_bps=0.):
    prepared = prepare(frame, settings, start)
    return execute(prepared, settings, initial_capital=initial_capital, leverage=leverage, start=start,
                   close_at_end=close_at_end, bar_seconds=bar_seconds, min_tick=min_tick, fee_bps=fee_bps,
                   slippage=slippage, spread=spread, funding_bps=funding_bps)


def ml_readiness(bar, settings: MLSettings) -> dict:
    """Bot status for the ML strategy: model probabilities instead of rule checks."""
    def value(name):
        number = float(getattr(bar, name, np.nan))
        return number if np.isfinite(number) else None
    p_long, p_short, p_none = value('p_long'), value('p_short'), value('p_none')
    def side(probability, opposite):
        checks = [dict(label='Probability', passed=probability is not None and probability >= settings.entry_threshold,
                       value=probability, threshold=settings.entry_threshold),
                  dict(label='Edge vs opposite', passed=probability is not None and opposite is not None and probability-opposite >= settings.min_edge,
                       value=None if probability is None or opposite is None else probability-opposite, threshold=settings.min_edge)]
        return dict(readiness=round(100*(probability or 0)), checks=checks)
    long, short = side(p_long, p_short), side(p_short, p_long)
    regime = getattr(bar, 'regime', -1)
    regime_name = REGIME_NAMES[int(regime)] if regime is not None and np.isfinite(regime) and regime >= 0 else None
    return dict(indicators=dict(pLong=p_long, pShort=p_short, pNone=p_none, atr=value('atr'), regime=regime_name,
                                longTp=value('long_tp'), longSl=value('long_sl'), shortTp=value('short_tp'), shortSl=value('short_sl')),
                longReadiness=long['readiness'], shortReadiness=short['readiness'],
                longChecks=long['checks'], shortChecks=short['checks'],
                signal='long' if bool(getattr(bar, 'long_signal', False)) else 'short' if bool(getattr(bar, 'short_signal', False)) else None)

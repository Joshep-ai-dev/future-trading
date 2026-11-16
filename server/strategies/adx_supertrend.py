"""ADX + Supertrend trend-following strategy.

Core rules (evaluated on completed candles, fills at the candle close):

* Direction = Supertrend (length, multiplier) direction.
* Entry when ADX >= threshold **and** ADX is rising (above its value
  ``adx_rising_bars`` ago) **and** either ADX just crossed above the threshold
  or the Supertrend just flipped. Long in an up-Supertrend, short in a
  down-Supertrend. An opposite signal reverses the position.
* Exit: the stop is the Supertrend line, updated every candle (it only
  tightens while the trend lasts). Intrabar touches fill at the stop, or at
  the open on an adverse gap; an opposite Supertrend flip closes at the close.

Minor filters (each optional): higher-timeframe Supertrend agreement, minimum ATR
(no new entries while ATR is below it), RSI extremes and a saved forecast model's
calibrated direction probability. Every value uses only closed candles.
"""
from __future__ import annotations

from dataclasses import dataclass, fields

import numpy as np
import pandas as pd

from server.strategies.ml.features import _dmi, _rsi, _supertrend, _true_range, _wilder

HTF_SECONDS = {'15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400}


@dataclass(frozen=True)
class Settings:
    adx_length: int = 14
    di_length: int = 14
    adx_threshold: float = 25.
    adx_rising_bars: int = 1
    require_di_agreement: bool = False
    st_length: int = 10
    st_multiplier: float = 3.
    trade_mode: str = 'Both'  # Both | Long Only | Short Only
    amount_per_trade: float = 100.
    amount_unit: str = 'percent'  # percent of balance | price (USDT)
    # Minor filters
    htf_filter: bool = True
    htf_timeframe: str = '1h'
    atr_filter: bool = True
    atr_length: int = 14
    atr_min: float = .03  # No new entries while ATR (price units, USDT) is below this.
    rsi_filter: bool = True
    rsi_length: int = 14
    rsi_overbought: float = 70.
    rsi_oversold: float = 30.
    forecast_filter: bool = False
    forecast_model_id: str = ''
    forecast_min_probability: float = .55
    forecast_owner: int = 0  # Set by the server from the signed-in user; never trusted from clients.
    # Engine settings (filled by the runner from the request)
    initial_capital: float = 2000.
    leverage: float = 1.
    min_tick: float = .01

    def __post_init__(self):
        ints = dict(adx_length=(1, 500), di_length=(1, 500), adx_rising_bars=(1, 50), st_length=(1, 500),
                    atr_length=(1, 500), rsi_length=(1, 500))
        for name, (low, high) in ints.items():
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
                raise ValueError(f'{name} must be an integer between {low} and {high}')
        checks = [('adx_threshold', 0, 100), ('st_multiplier', .01, 100), ('atr_min', 0, 1e6),
                  ('rsi_overbought', 0, 100), ('rsi_oversold', 0, 100), ('forecast_min_probability', .5, 1)]
        for name, low, high in checks:
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not np.isfinite(value) or not low <= value <= high:
                raise ValueError(f'{name} must be between {low} and {high}')
        if self.rsi_oversold >= self.rsi_overbought:
            raise ValueError('RSI oversold level must be below overbought')
        if self.trade_mode not in ('Both', 'Long Only', 'Short Only'):
            raise ValueError('trade_mode must be Both, Long Only or Short Only')
        if self.amount_unit not in ('percent', 'price') or not np.isfinite(self.amount_per_trade) or self.amount_per_trade <= 0:
            raise ValueError('Amount per trade must be positive (percent or USDT)')
        if self.amount_unit == 'percent' and self.amount_per_trade > 100:
            raise ValueError('Amount per trade cannot exceed 100% of balance')
        if self.htf_timeframe not in HTF_SECONDS:
            raise ValueError(f'htf_timeframe must be one of {", ".join(HTF_SECONDS)}')
        if self.forecast_filter and not self.forecast_model_id:
            raise ValueError('Choose a saved forecast model for the forecast filter')

    @classmethod
    def from_dict(cls, values: dict, **overrides) -> 'Settings':
        known = {f.name for f in fields(cls)}
        # The ATR percentile band was replaced by a fixed minimum ATR; old saved settings still load.
        values = {key: value for key, value in values.items() if key not in LEGACY_KEYS}
        unknown = sorted(set(values)-known)
        if unknown:
            raise ValueError(f'Unknown ADX + Supertrend settings: {", ".join(unknown)}')
        return cls(**{**values, **overrides})


LEGACY_KEYS = frozenset({'atr_window', 'atr_min_pct', 'atr_max_pct'})


def _htf_direction(frame: pd.DataFrame, s: Settings, bar_seconds: int) -> pd.Series:
    """Higher-timeframe Supertrend direction known at each entry candle's close."""
    seconds = HTF_SECONDS[s.htf_timeframe]
    if seconds <= bar_seconds:
        return pd.Series(np.nan, index=frame.index)
    rule = pd.Timedelta(seconds=seconds)
    htf = frame[['open', 'high', 'low', 'close']].resample(rule, label='left', closed='left').agg(
        dict(open='first', high='max', low='min', close='last')).dropna()
    # Keep only higher-timeframe bars fully covered by closed entry candles.
    last_close = frame.index[-1]+pd.Timedelta(seconds=bar_seconds)
    htf = htf.loc[htf.index+rule <= last_close]
    if htf.empty:
        return pd.Series(np.nan, index=frame.index)
    _, direction = _supertrend(htf, s.st_length, s.st_multiplier)
    known_at = pd.Series(direction, index=htf.index+rule)  # value is known once the HTF bar closes
    entry_close = frame.index+pd.Timedelta(seconds=bar_seconds)
    aligned = known_at.reindex(known_at.index.union(entry_close)).ffill().reindex(entry_close)
    return pd.Series(aligned.to_numpy(), index=frame.index).replace(0, np.nan)


def _forecast_probability(frame: pd.DataFrame, s: Settings, bar_seconds: int, start) -> pd.Series:
    """Calibrated P(up) from a saved Quantile Boost model, causal at each candle."""
    from server.forecast_models import load_model
    from server.forecast_research import ForecastRequest, forecast_inputs
    from server.market.data import TIMEFRAMES

    model, metadata = load_model(int(s.forecast_owner), s.forecast_model_id)
    config = metadata['config']
    if not callable(getattr(type(model), 'direction_rows', None)):
        raise ValueError('The forecast filter needs a Quantile Boost model (it reports a calibrated direction probability)')
    if TIMEFRAMES[config['timeframe']] != bar_seconds:
        raise ValueError(f'The forecast model uses {config["timeframe"]} candles; choose the same strategy timeframe')
    first = start if start is not None else frame.index[0]
    if pd.Timestamp(metadata['trainedThrough']) > first:
        raise ValueError('The forecast model was trained on data after this period starts (look-ahead). '
                         'Use a model trained before the backtest start date.')
    request = ForecastRequest(model=config['model'], timeframe=config['timeframe'], horizon=config['horizon'],
                              train_bars=config['train_bars'], start_date=frame.index[0].date(),
                              end_date=frame.index[-1].date(), path_forecast=True)
    features, atr, _, _ = forecast_inputs(frame, request, pd.Timedelta(seconds=bar_seconds))
    if list(features.columns) != metadata['featureNames']:
        raise ValueError('Market feature schema differs from the saved forecast model; train a new model')
    chance = model.direction_rows(features, slice(0, len(features)))
    chance[~np.isfinite(atr.to_numpy())] = np.nan
    return pd.Series(chance, index=frame.index)


def calculate(frame: pd.DataFrame, s: Settings, *, bar_seconds: int | None = None, start=None) -> pd.DataFrame:
    """Indicator, filter and signal columns. Uses only current and past candles."""
    bars = frame.copy()
    bar_seconds = bar_seconds or int(pd.Series(frame.index).diff().dt.total_seconds().median() or 300)
    plus_di, minus_di, adx = _dmi(bars, s.di_length, s.adx_length)
    line, direction = _supertrend(bars, s.st_length, s.st_multiplier)
    atr = _wilder(_true_range(bars), s.atr_length)
    bars['plus_di'], bars['minus_di'], bars['adx'] = plus_di, minus_di, adx
    bars['st_line'], bars['st_direction'] = line, direction
    bars['atr'] = atr
    previous_direction = bars.st_direction.shift()
    bars['st_flip'] = (bars.st_direction != previous_direction) & previous_direction.ne(0) & previous_direction.notna() & bars.st_direction.ne(0)
    adx_prev = adx.shift()
    bars['adx_cross'] = (adx >= s.adx_threshold) & (adx_prev < s.adx_threshold)
    bars['adx_rising'] = adx > adx.shift(s.adx_rising_bars)
    bars['adx_ok'] = adx >= s.adx_threshold
    trigger = bars.adx_ok & bars.adx_rising & (bars.adx_cross | bars.st_flip)
    di_long = (plus_di > minus_di) if s.require_di_agreement else pd.Series(True, index=bars.index)
    di_short = (minus_di > plus_di) if s.require_di_agreement else pd.Series(True, index=bars.index)
    # Minor filters
    ok_long = pd.Series(True, index=bars.index)
    ok_short = pd.Series(True, index=bars.index)
    if s.htf_filter:
        htf = _htf_direction(bars, s, bar_seconds)
        bars['htf_direction'] = htf
        # When the HTF equals the entry timeframe the filter has no information: pass.
        no_information = HTF_SECONDS[s.htf_timeframe] <= bar_seconds
        ok_long &= (htf == 1) | no_information
        ok_short &= (htf == -1) | no_information
    if s.atr_filter:
        # Too little movement: skip new entries. Open trades keep their Supertrend stop.
        active = atr >= s.atr_min
        ok_long &= active
        ok_short &= active
    if s.rsi_filter:
        rsi = _rsi(bars.close, s.rsi_length)
        bars['rsi'] = rsi
        ok_long &= rsi <= s.rsi_overbought
        ok_short &= rsi >= s.rsi_oversold
    if s.forecast_filter:
        chance = _forecast_probability(bars, s, bar_seconds, start)
        bars['forecast_up'] = chance
        ok_long &= chance >= s.forecast_min_probability
        ok_short &= (1-chance) >= s.forecast_min_probability
    ready = adx.notna() & np.isfinite(line) & bars.atr.notna()
    bars['raw_long'] = ready & trigger & (bars.st_direction == 1) & di_long
    bars['raw_short'] = ready & trigger & (bars.st_direction == -1) & di_short
    bars['filter_long'] = ok_long.fillna(False).astype(bool)
    bars['filter_short'] = ok_short.fillna(False).astype(bool)
    bars['entry_long'] = bars.raw_long & bars.filter_long & (s.trade_mode != 'Short Only')
    bars['entry_short'] = bars.raw_short & bars.filter_short & (s.trade_mode != 'Long Only')
    return bars


def run_backtest(frame: pd.DataFrame, s: Settings, *, start=None, close_at_end=False, bar_seconds=None,
                 fee_bps=0., slippage=0., spread=0., funding_bps=0.) -> dict:
    """Simulate trades; output matches ``bb_outer_reversal.run_backtest``."""
    if not all(np.isfinite(v) for v in (fee_bps, slippage, spread, funding_bps)) or min(fee_bps, slippage, spread) < 0:
        raise ValueError('Execution costs must be finite; fees, slippage and spread must be nonnegative')
    adverse = slippage+spread/2
    bars = calculate(frame, s, bar_seconds=bar_seconds, start=start)
    if start is not None:
        bars = bars.loc[bars.index >= start]
    trades, records = [], []
    position = None
    cash = s.initial_capital

    def stamp(time):
        return int(time.timestamp()) if hasattr(time, 'timestamp') else int(time)

    def accrue_funding(time):
        nonlocal cash
        if position is None:
            return
        now = float(stamp(time))
        elapsed = now-position['funding_time']
        charge = position['entry_price']*position['quantity']*funding_bps/10000*position['direction']*max(0, elapsed)/(8*3600)
        cash -= charge
        position['funding'] += charge
        position['funding_time'] = now

    def close_position(time, price, reason):
        nonlocal cash, position
        accrue_funding(time)
        d, q = position['direction'], position['quantity']
        fill = price-d*adverse
        exit_fee = abs(fill*q)*fee_bps/10000
        filled_gross = (fill-position['entry_price'])*d*q
        fees = position['entry_fee']+exit_fee
        cash += filled_gross-exit_fee
        gross = (price-position['reference_entry'])*d*q
        trades.append(dict(**position, exit_time=time, exit_price=float(fill), exit_reason=reason,
                           pnl=float(filled_gross-fees-position['funding']), gross_pnl=float(gross),
                           fees=float(fees), execution_cost=float(gross-filled_gross)))
        position = None

    for i, bar in enumerate(bars.itertuples()):
        time = bar.Index
        if bar_seconds and i and (time-bars.index[i-1]).total_seconds() > bar_seconds and position is not None:
            close_position(bars.index[i-1], bars.close.iloc[i-1], 'data_gap')
        # 1) Intrabar stop on the Supertrend line set at the previous close.
        if position is not None:
            accrue_funding(time)
            stop, d = position['stop'], position['direction']
            if d == 1 and bar.low <= stop:
                close_position(time, min(bar.open, stop), 'supertrend_stop')
            elif d == -1 and bar.high >= stop:
                close_position(time, max(bar.open, stop), 'supertrend_stop')
        # 2) Opposite Supertrend flip at the close.
        if position is not None and bar.st_direction == -position['direction']:
            close_position(time, bar.close, 'supertrend_flip')
        # 3) Entries / reversals at the close.
        direction = 1 if bar.entry_long else -1 if bar.entry_short else 0
        if direction and position is not None and position['direction'] == direction:
            direction = 0  # already positioned this way
        if direction and position is not None:
            close_position(time, bar.close, 'reversal')
        if direction and cash > 0 and np.isfinite(bar.st_line):
            amount = cash*s.amount_per_trade/100 if s.amount_unit == 'percent' else min(s.amount_per_trade, cash)
            quantity = amount*s.leverage/bar.close
            entry = float(bar.close)+direction*adverse
            minimum = s.min_tick
            stop = float(bar.st_line)
            if direction*(entry-stop) < minimum:
                stop = entry-direction*minimum
            entry_fee = abs(entry*quantity)*fee_bps/10000
            cash -= entry_fee
            position = dict(reference_entry=float(bar.close), entry_fee=entry_fee, funding=0., funding_time=float(stamp(time)),
                            direction=direction, entry_time=time, entry_price=entry, quantity=float(quantity),
                            stop=stop, initial_stop=stop, extreme=float(bar.close), trailing_active=True,
                            trail_trigger=0., trail_distance=float(direction*(entry-stop)),
                            stop_history=[dict(time=stamp(time), price=stop, reason='initial')])
        elif position is not None and np.isfinite(bar.st_line) and bar.st_direction == position['direction']:
            # 4) Trail: follow the Supertrend line; never loosen.
            d = position['direction']
            candidate = float(bar.st_line)
            tightened = max(position['stop'], candidate) if d == 1 else min(position['stop'], candidate)
            if tightened != position['stop']:
                position['stop'] = tightened
                position['stop_history'].append(dict(time=stamp(time), price=tightened, reason='trailing'))
        unrealized = 0 if position is None else (bar.close-position['entry_price'])*position['direction']*position['quantity']
        records.append(dict(long_signal=direction == 1, short_signal=direction == -1,
                            position=0 if position is None else position['direction'],
                            stop=np.nan if position is None else position['stop'],
                            trailing_active=position is not None, equity=float(cash+unrealized)))
    if close_at_end and position is not None and len(bars):
        close_position(bars.index[-1], bars.close.iloc[-1], 'period_end')
        records[-1].update(position=0, stop=np.nan, trailing_active=False, equity=float(cash))
    diagnostics = pd.DataFrame(records, index=bars.index)
    return dict(bars=bars.join(diagnostics), trades=pd.DataFrame(trades),
                open_position=None if position is None else position.copy(), cash=float(cash))


def readiness(bar, s: Settings) -> dict:
    """Checklist for the bot status panel (latest completed candle)."""
    def value(name):
        number = getattr(bar, name, np.nan)
        try:
            number = float(number)
        except (TypeError, ValueError):
            return None
        return number if np.isfinite(number) else None

    direction = value('st_direction') or 0
    adx = value('adx')
    trigger = bool(getattr(bar, 'adx_cross', False) or getattr(bar, 'st_flip', False))
    core = [dict(label=f'ADX ≥ {s.adx_threshold:g}', passed=bool(getattr(bar, 'adx_ok', False)), value=adx, threshold=s.adx_threshold),
            dict(label='ADX rising', passed=bool(getattr(bar, 'adx_rising', False)), value=adx, threshold=None),
            dict(label='ADX cross or Supertrend flip this candle', passed=trigger, value=int(trigger), threshold=1)]

    def side(sign):
        checks = [dict(label='Supertrend direction', passed=direction == sign, value=direction, threshold=sign), *core]
        if s.htf_filter:
            htf = value('htf_direction')
            checks.append(dict(label=f'{s.htf_timeframe} Supertrend agrees', passed=htf == sign,
                               value=htf, threshold=sign))
        if s.atr_filter:
            atr = value('atr')
            checks.append(dict(label=f'ATR ≥ {s.atr_min:g}', passed=atr is not None and atr >= s.atr_min,
                               value=atr, threshold=s.atr_min))
        if s.rsi_filter:
            rsi = value('rsi')
            limit = s.rsi_overbought if sign == 1 else s.rsi_oversold
            passed = rsi is not None and (rsi <= limit if sign == 1 else rsi >= limit)
            checks.append(dict(label=f'RSI {"≤" if sign == 1 else "≥"} {limit:g}', passed=passed, value=rsi, threshold=limit))
        if s.forecast_filter:
            chance = value('forecast_up')
            p = None if chance is None else (chance if sign == 1 else 1-chance)
            checks.append(dict(label=f'Forecast P({"up" if sign == 1 else "down"}) ≥ {s.forecast_min_probability:.0%}',
                               passed=p is not None and p >= s.forecast_min_probability, value=p, threshold=s.forecast_min_probability))
        return checks

    long_checks, short_checks = side(1), side(-1)
    score = lambda checks: int(round(100*sum(c['passed'] for c in checks)/len(checks)))
    return dict(indicators=dict(adx=adx, plusDi=value('plus_di'), minusDi=value('minus_di'), supertrend=value('st_line'),
                                supertrendDirection=direction, atr=value('atr'), rsi=value('rsi'), forecastUp=value('forecast_up')),
                longReadiness=score(long_checks) if s.trade_mode != 'Short Only' else 0,
                shortReadiness=score(short_checks) if s.trade_mode != 'Long Only' else 0,
                longChecks=long_checks, shortChecks=short_checks,
                signal='long' if getattr(bar, 'long_signal', False) else 'short' if getattr(bar, 'short_signal', False) else None)

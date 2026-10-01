"""Shared cost/risk simulator and legacy sweep rules. All bar timestamps are opens."""
from bisect import bisect_left, bisect_right, insort
from datetime import date, datetime, timedelta, timezone
from math import ceil, floor
from typing import Literal
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
from pydantic import BaseModel, ConfigDict, Field, model_validator
from .indicators import indicators
from .exits import indicator_exit, updated_stop


class BacktestRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    start_date: date
    end_date: date
    validation_date: date
    strategy: Literal['sweep', 'mtf'] = 'sweep'
    direction_active: bool = True
    direction_timeframe: Literal['15m', '30m', '1h', '4h'] = '1h'
    setup_active: bool = True
    setup_timeframe: Literal['5m', '15m', '30m', '1h'] = '15m'
    entry_active: bool = True
    entry_timeframe: Literal['1m', '3m', '5m', '15m'] = '5m'
    exit_condition: Literal['none', 'ema', 'rsi', 'either'] = 'none'
    stop_mode: Literal['none', 'fixed', 'breakeven', 'trailing', 'breakeven_trailing'] = 'fixed'
    atr_active: bool = False
    atr_period: int = Field(default=14, ge=1, le=500)
    atr_multiplier: float = Field(default=2., gt=0, le=100)
    ema_fast: int = Field(default=20, ge=1, le=500)
    ema_slow: int = Field(default=50, ge=2, le=1000)
    rsi_period: int = Field(default=20, ge=1, le=500)
    rsi_threshold: float = Field(default=50, gt=0, lt=100)
    rsi_active: bool = True
    capital: float = Field(default=2000, gt=0, le=1e9)
    tick_size: float = Field(default=.01, gt=0, le=10)
    fee_bps: float = Field(default=5, ge=0, le=100)
    spread: float = Field(default=.01, ge=0, le=10)
    slippage: float = Field(default=.01, ge=0, le=10)
    funding_bps: float = Field(default=1, ge=-100, le=100)
    max_leverage: float = Field(default=1, ge=1, le=100)
    session_start: int = Field(default=0, ge=0, le=23)
    session_end: int = Field(default=24, ge=0, le=24)
    session_timezone: Literal['UTC', 'Asia/Shanghai', 'America/New_York', 'Europe/London'] = 'UTC'

    @model_validator(mode='after')
    def check_ranges(self):
        if self.ema_fast >= self.ema_slow:
            raise ValueError('Fast EMA period must be less than slow EMA period.')
        if not self.start_date < self.validation_date <= self.end_date:
            raise ValueError('Validation date must be after the start date and on or before the end date.')
        if self.session_start == self.session_end or (self.session_start == 0 and self.session_end == 0):
            raise ValueError('Session hours must differ; use 00–24 for a full day.')
        if self.strategy == 'mtf' and not any((self.direction_active, self.setup_active, self.entry_active)):
            raise ValueError('Activate at least one timeframe for the EMA + RSI strategy.')
        if self.strategy == 'mtf':
            self.exit_condition = 'ema'
            self.stop_mode = 'none'
        elif self.stop_mode == 'none':
            raise ValueError('Sweep requires a stop-loss mode.')
        return self


def seconds(day):
    return int(datetime.combine(day, datetime.min.time(), timezone.utc).timestamp())


def structure_events(frame):
    """A pivot at i becomes visible at the close of i+2, never at i."""
    values = frame[['open', 'high', 'low', 'close']].to_numpy()
    times = frame.index.asi8 // 10**9
    highs, lows, resistance, support = [], [], [], []
    events = []
    for j, row in enumerate(values):
        if not np.isfinite(row).all():
            highs, lows, resistance, support = [], [], [], []
            events.append(dict(time=int(times[j])+900, trend=0, highs=[], lows=[], resistance=[], support=[]))
            continue
        resistance = [x for x in resistance if x >= row[3]]
        support = [x for x in support if x <= row[3]]
        if j >= 4:
            window = values[j-4:j+1]
            if np.isfinite(window).all():
                middle = window[2]
                others = window[[0, 1, 3, 4]]
                if all(middle[1] > others[:, 1]):
                    highs.append(float(middle[1]))
                    highs = highs[-2:]
                    if middle[1] not in resistance:
                        insort(resistance, float(middle[1]))
                if all(middle[2] < others[:, 2]):
                    lows.append(float(middle[2]))
                    lows = lows[-2:]
                    if middle[2] not in support:
                        insort(support, float(middle[2]))
        trend = 0
        if len(highs) == 2 and len(lows) == 2:
            if highs[1] > highs[0] and lows[1] > lows[0]:
                trend = 1
            elif highs[1] < highs[0] and lows[1] < lows[0]:
                trend = -1
        events.append(dict(time=int(times[j])+900, trend=trend, highs=highs.copy(), lows=lows.copy(),
                           resistance=resistance.copy(), support=support.copy()))
    return events


def session_at(stamp, settings):
    local = datetime.fromtimestamp(stamp, timezone.utc).astimezone(ZoneInfo(settings.session_timezone))
    if local.weekday() >= 5:
        return None
    hour = local.hour + local.minute / 60
    start, end = settings.session_start, settings.session_end
    if start < end:
        active = start <= hour < end
        day = local.date()
    else:
        active = hour >= start or hour < end
        day = local.date() if hour >= start else local.date() - timedelta(days=1)
    return day.isoformat() if active else None


def nearest_level(state, direction, entry):
    levels = state['resistance'] if direction == 1 else state['support']
    if direction == 1:
        i = bisect_right(levels, entry)
        return levels[i] if i < len(levels) else None
    i = bisect_left(levels, entry) - 1
    return levels[i] if i >= 0 else None


def setup_order(rows, i, state, settings):
    if i < 6 or not state['trend']:
        return None
    history = rows[i-6:i]
    if not np.isfinite(history).all():
        return None
    _, high, low, close = map(float, rows[i])
    direction = state['trend']
    level = float(history[:, 2].min() if direction == 1 else history[:, 1].max())
    swept = low < level < close if direction == 1 else high > level > close
    if not swept:
        return None
    tick = settings.tick_size
    if direction == 1:
        trigger = (floor(high/tick+1e-8)+1)*tick
        stop = (ceil(low/tick-1e-8)-1)*tick
    else:
        trigger = (ceil(low/tick-1e-8)-1)*tick
        stop = (floor(high/tick+1e-8)+1)*tick
    if min(trigger, stop) <= 0:
        return None
    entry = trigger + direction*(settings.spread/2+settings.slippage)
    risk = direction*(entry-stop)
    obstacle = nearest_level(state, direction, entry)
    return dict(direction=direction, trigger=trigger, stop=stop, sweepLevel=level,
                obstacle=obstacle, blocked=obstacle is not None and direction*(obstacle-entry) < 2*risk,
                swingHighs=state['highs'], swingLows=state['lows'])


def exit_on_bar(position, row, friction, entered_this_bar=False):
    """Stop-first if OHLC cannot establish whether target or stop occurred first."""
    opening, high, low, _ = row
    d, stop, target = position['direction'], position['stop'], position['target']
    hit_stop = low <= stop if d == 1 else high >= stop
    hit_target = target is not None and (high >= target if d == 1 else low <= target)
    if hit_stop:
        raw = stop if entered_this_bar else (min(opening, stop) if d == 1 else max(opening, stop))
        return raw-d*friction, 'stop', bool(hit_target)
    if hit_target:
        return target-d*friction, 'target', False
    return None


def metrics(trades, equity, capital):
    net = sum(t['netPnl'] for t in trades)
    gains = sum(max(t['netPnl'], 0) for t in trades)
    losses = -sum(min(t['netPnl'], 0) for t in trades)
    peak, drawdown = capital, 0.
    for point in equity:
        peak = max(peak, point['value'])
        drawdown = min(drawdown, point['value']/peak-1)
    return dict(trades=len(trades), wins=sum(t['netPnl'] > 0 for t in trades),
                losses=sum(t['netPnl'] < 0 for t in trades), netPnl=net, endingBalance=capital+net,
                returnPct=net/capital*100, winRate=sum(t['netPnl'] > 0 for t in trades)/len(trades)*100 if trades else 0,
                profitFactor=gains/losses if losses else None, maxDrawdownPct=drawdown*100,
                averageR=sum(t['netR'] for t in trades)/len(trades) if trades else 0,
                fees=sum(t['fees'] for t in trades), funding=sum(t['funding'] for t in trades),
                executionCost=sum(t['executionCost'] for t in trades),
                meets100Trades=len(trades) >= 100)


def simulate(frame, events, settings, start, end, name, bar_seconds=300, orders=None, exit_values=None):
    atr_enabled = settings.strategy == 'mtf' and settings.atr_active
    protected = settings.strategy != 'mtf' or atr_enabled
    times = frame.index.asi8 // 10**9
    rows = frame[['open', 'high', 'low', 'close']].to_numpy()
    balance = settings.capital
    pending = position = None
    positions = []
    trades, equity = [], [dict(time=start, value=balance)]
    diagnostics = dict(signals=0, invalidEntries=0, sweeps=0, blockedByLevel=0, expiredOrders=0, cancelledOrders=0, ambiguousBars=0)
    state = dict(trend=0, highs=[], lows=[], resistance=[], support=[])
    event_index = 0
    current_session, session_trades, session_losses = None, 0, 0
    friction = settings.spread/2+settings.slippage
    fee = settings.fee_bps/10000
    prior_time, prior_close = None, None
    valid_indices = np.flatnonzero((times >= start) & (times+bar_seconds <= end) & np.isfinite(rows).all(axis=1))
    if not len(valid_indices):
        return dict(name=name, start=start, end=end, trades=[], equity=equity,
                    summary=metrics([], equity, balance), diagnostics=diagnostics, status='no_complete_bars')
    last_index = int(valid_indices[-1])

    def close_trade(price, stamp, reason, ambiguous=False, raw=None):
        nonlocal balance, position, session_losses
        p = position
        gross = p['direction']*(price-p['entry'])*p['quantity']
        fees = p['entryFee']+abs(price*p['quantity'])*fee
        net = gross-fees-p['funding']
        balance += gross-abs(price*p['quantity'])*fee
        session_losses += int(net < 0)
        trade = {k:v for k,v in p.items() if k not in ('entryFee', 'lastFunding', 'pendingStop', 'pendingExit')}
        trade['finalStop'] = p['stop']
        trade['stop'] = p['initialStop']
        if not protected:
            trade['sizingReference'] = p['initialStop']
            trade.update(stop=None, initialStop=None, finalStop=None, target=None, stopHistory=[], plannedRisk=None)
        raw = price+p['direction']*friction if raw is None else raw
        trade.update(id=len(trades)+1, exitTime=stamp, exit=price, exitReason=reason,
                     grossPnl=gross, fees=fees, netPnl=net, netR=net/p['riskBudget'], balance=balance,
                     executionCost=(abs(p['entry']-p['rawEntry'])+abs(price-raw))*p['quantity'],
                     ambiguous=ambiguous, period=name)
        trades.append(trade)
        diagnostics['ambiguousBars'] += int(ambiguous)
        positions.remove(p)
        position = None

    for i, time_value in enumerate(times):
        t = int(time_value)
        if t < start:
            continue
        if t+bar_seconds > end or i > last_index:
            break
        row = tuple(map(float, rows[i]))
        session = session_at(t, settings)
        # A coarse execution bar cannot establish prices at a session boundary inside it.
        if session is not None and session_at(t+bar_seconds-1, settings) != session:
            session = None
        # Gaps flatten at the last known close; unknown prices cannot be simulated.
        if not np.isfinite(row).all():
            for position in positions.copy():
                close_trade(prior_close-position['direction']*friction, prior_time, 'data_gap')
                equity[-1]['value'] = balance
            if pending is not None:
                diagnostics['cancelledOrders'] += 1
            pending = None
            prior_time = prior_close = None
            continue
        if session != current_session:
            for position in positions.copy():
                close_trade(prior_close-position['direction']*friction, prior_time, 'session_end')
            if pending is not None:
                diagnostics['cancelledOrders'] += 1
            pending = None
            current_session, session_trades, session_losses = session, 0, 0
        closing_session = session_at(t+bar_seconds, settings) != session
        for position in positions:
            if not position.get('pendingStop'):
                continue
            update = position.pop('pendingStop')
            position['stop'] = update['price']
            position['stopHistory'].append(dict(time=t, **update))
        just_entered = False
        if pending is not None and session is not None:
            d = pending['direction']
            market_order = pending.get('orderType') == 'market'
            triggered = market_order or (row[1] >= pending['trigger'] if d == 1 else row[2] <= pending['trigger'])
            if triggered:
                raw_entry = row[0] if market_order else (max(row[0], pending['trigger']) if d == 1 else min(row[0], pending['trigger']))
                entry = raw_entry+d*friction
                if atr_enabled:
                    pending['stop'] = entry-d*pending['atrDistance']
                risk = d*(entry-pending['stop']) if protected else max(abs(entry-pending['stop']), settings.tick_size)
                obstacle = pending['obstacle']
                blocked = obstacle is not None and d*(obstacle-entry) < 2*risk
                if blocked or risk <= 0 or balance <= 0 or (protected and pending['stop'] <= 0) or (settings.strategy != 'mtf' and entry+d*2*risk <= 0):
                    diagnostics['blockedByLevel' if blocked else 'invalidEntries'] += 1
                else:
                    account_equity = balance + sum(p['direction']*(row[0]-p['entry'])*p['quantity'] for p in positions)
                    risk_budget = max(0., account_equity)*.005
                    stop_fill = pending['stop']-d*friction
                    unit_loss = risk+friction+(entry+abs(stop_fill))*fee
                    used_notional = sum(abs(p['quantity']*row[0]) for p in positions)
                    capacity = max(0., account_equity*settings.max_leverage-used_notional)
                    quantity = min(risk_budget/unit_loss, capacity/entry)
                    if quantity <= 0:
                        diagnostics['invalidEntries'] += 1
                        pending = None
                        # Existing positions must still be processed on this candle.
                    else:
                        position = {k:v for k,v in pending.items() if k not in ('expires', 'blocked')}
                        position.update(entryTime=t, entry=entry, rawEntry=raw_entry, target=None if settings.strategy == 'mtf' else entry+d*2*risk,
                                        quantity=quantity, riskBudget=risk_budget, plannedRisk=quantity*unit_loss,
                                        entryFee=entry*quantity*fee, funding=0., lastFunding=t,
                                        initialStop=pending['stop'], initialRisk=risk,
                                        stopHistory=[dict(time=t, price=pending['stop'], reason='initial')])
                        positions.append(position)
                        balance -= position['entryFee']
                        session_trades += 1
                        just_entered = True
                pending = None
            elif i >= pending['expires']:
                diagnostics['expiredOrders'] += 1
                pending = None
        for position in positions.copy():
            just_entered = position['entryTime'] == t
            # Fixed illustrative funding at 00/08/16 UTC. Intrabar entries skip that bar's opening event.
            if not just_entered and t % (8*3600) == 0:
                payment = position['direction']*position['quantity']*row[0]*settings.funding_bps/10000
                position['funding'] += payment
                balance -= payment
            queued_exit = position.pop('pendingExit', None)
            if queued_exit is not None:
                d = position['direction']
                gap_stop = protected and (row[0] <= position['stop'] if d == 1 else row[0] >= position['stop'])
                gap_target = position['target'] is not None and protected and (row[0] >= position['target'] if d == 1 else row[0] <= position['target'])
                # Existing protective orders take priority at the next open.
                position['exitSignal'] = queued_exit
                reason = 'stop' if gap_stop else 'target' if gap_target else queued_exit['reason']
                raw_exit = position['target'] if gap_target and not gap_stop else row[0]
                close_trade(raw_exit-d*friction, t, reason)
            else:
                outcome = exit_on_bar(position, row, friction, just_entered) if protected else None
                if outcome is not None:
                    price, reason, ambiguous = outcome
                    close_trade(price, t, reason, ambiguous or (just_entered and position.get('orderType') != 'market' and reason == 'stop'))
                elif closing_session or i == last_index:
                    close_trade(row[3]-position['direction']*friction, t,
                                'session_end' if closing_session else 'period_end')
            if position is not None:
                # Observe this candle only after price stops/targets have been evaluated.
                if exit_values is not None and i > 0:
                    reason = indicator_exit(position['direction'], exit_values[i-1], exit_values[i], settings.exit_condition, settings.rsi_threshold)
                    if reason:
                        values = exit_values[i]
                        position['pendingExit'] = dict(time=t, closeTime=t+bar_seconds, reason=reason,
                            ema20=float(values[0]) if np.isfinite(values[0]) else None,
                            ema50=float(values[1]) if np.isfinite(values[1]) else None,
                            rsi20=float(values[2]) if np.isfinite(values[2]) else None)
                update = updated_stop(position, row, settings.stop_mode, settings.tick_size)
                if update:
                    position['pendingStop'] = dict(update, confirmedAt=t+bar_seconds)
        while event_index < len(events) and events[event_index]['time'] <= t+bar_seconds:
            state = events[event_index]
            event_index += 1
        if (session is not None and not closing_session and i < last_index and
                (not positions or settings.strategy == 'mtf') and pending is None and balance > 0 and
                (settings.strategy == 'mtf' or (session_trades < 2 and session_losses < 2))):
            order = setup_order(rows, i, state, settings) if orders is None else orders.get(i)
            if order is not None:
                diagnostics['signals'] += 1
                diagnostics['sweeps'] += int(orders is None)
                if order['blocked']:
                    diagnostics['blockedByLevel'] += 1
                else:
                    pending = dict(order, signalTime=t, expires=i+(1 if order.get('orderType') == 'market' else 3), session=session)
        if (closing_session or i == last_index) and pending is not None:
            diagnostics['cancelledOrders'] += 1
            pending = None
        mark = balance
        for position in positions:
            liquidation = row[3]-position['direction']*friction
            mark += position['direction']*(liquidation-position['entry'])*position['quantity']
            mark -= abs(liquidation*position['quantity'])*fee
        equity.append(dict(time=t+bar_seconds, value=float(mark)))
        prior_time, prior_close = t, float(row[3])
    return dict(name=name, start=start, end=end, trades=trades, equity=equity,
                summary=metrics(trades, equity, settings.capital), diagnostics=diagnostics, status='ok')


def run_backtest(five, fifteen, settings):
    events = structure_events(fifteen)
    start, split, end = seconds(settings.start_date), seconds(settings.validation_date), seconds(settings.end_date+timedelta(days=1))
    calculated = indicators(five, settings.ema_fast, settings.ema_slow, settings.rsi_period) if settings.exit_condition != 'none' else None
    exit_values = calculated.to_numpy() if calculated is not None else None
    research = simulate(five, events, settings, start, split, 'Research', exit_values=exit_values)
    validation = simulate(five, events, settings, split, end, 'Validation', exit_values=exit_values)
    candles = [dict(time=int(t.timestamp()), open=float(r.open), high=float(r.high), low=float(r.low), close=float(r.close))
               for t,r in five.loc[(five.index >= pd.Timestamp(start,unit='s',tz='UTC')) &
                                   (five.index < pd.Timestamp(end,unit='s',tz='UTC'))].dropna().iterrows()]
    return dict(settings=settings.model_dump(mode='json'), research=research, validation=validation, candles=candles,
                strategyName='Structure / liquidity sweep', executionTimeframe='5m', barSeconds=300,
                indicators=[] if calculated is None else [dict(time=int(t.timestamp()),
                    **{k:float(v) if np.isfinite(v) else None for k,v in row.items()})
                    for t,row in calculated.loc[five.index[(five.index.asi8//10**9 >= start) &
                        (five.index.asi8//10**9 < end) & five.close.notna().to_numpy()]].iterrows()])

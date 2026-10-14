"""BB request validation, UTC period boundaries and result metrics.

Legacy configuration fields are accepted for saved-session compatibility.
"""
from datetime import date, datetime, timezone
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator


class BacktestRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    start_date: date
    end_date: date
    validation_date: date | None = None  # Accepted only for older saved settings.
    strategy: Literal['bb_outer_reversal'] = 'bb_outer_reversal'
    bb_reversal: dict = Field(default_factory=dict)
    direction_active: bool = True
    direction_timeframe: Literal['15m', '30m', '1h', '4h'] = '1h'
    setup_active: bool = True
    setup_timeframe: Literal['5m', '15m', '30m', '1h'] = '15m'
    entry_active: bool = True
    entry_timeframe: Literal['1m', '3m', '5m', '10m', '15m', '30m', '1h', '4h', '1d'] = '5m'
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
    bb_period: int = Field(default=200, ge=1, le=1000)
    chartart_stop_pct: float = Field(default=1., gt=0, lt=100)
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
        if self.end_date < self.start_date:
            raise ValueError('End date must be on or after the start date.')
        from .bb_outer_reversal import Settings
        try:
            config = Settings(**self.bb_reversal)
            if config.amount_unit == 'price' and config.amount_per_trade > self.capital:
                raise ValueError('Amount per trade cannot exceed the starting account balance')
        except (TypeError, ValueError) as error:
            raise ValueError(str(error)) from error
        self.bb_reversal = {**self.bb_reversal, 'trade_mode': 'Both'}
        self.exit_condition = 'none'
        self.stop_mode = 'trailing'
        return self


def seconds(day):
    return int(datetime.combine(day, datetime.min.time(), timezone.utc).timestamp())


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


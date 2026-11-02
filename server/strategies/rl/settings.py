from dataclasses import dataclass, fields
import math


@dataclass(frozen=True)
class RLSettings:
    train_bars: int = 10000
    retrain_every: int = 1000
    lookback: int = 16
    timesteps: int = 51200
    learning_rate: float = .0003
    seed: int = 7
    min_atr: float = .03
    stop_atr: float = 3.
    max_drawdown_pct: float = 20.
    drawdown_penalty: float = .1
    turnover_penalty: float = .0001
    amount_per_trade: float = 100.
    amount_unit: str = 'percent'

    def __post_init__(self) -> None:
        for item in fields(self):
            value = getattr(self, item.name)
            if item.name != 'amount_unit' and (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)):
                raise ValueError(f'{item.name} must be a finite number')
        for name, low, high in (('train_bars', 500, 200000), ('retrain_every', 50, 50000),
                                ('lookback', 1, 64), ('timesteps', 256, 1000000), ('seed', 0, 2147483647)):
            value = getattr(self, name)
            if not isinstance(value, int) or not low <= value <= high:
                raise ValueError(f'{name} must be an integer between {low} and {high}')
        if not 0 < self.learning_rate <= .01 or not 0 <= self.min_atr <= 100:
            raise ValueError('Invalid learning rate or minimum ATR')
        if not .1 <= self.stop_atr <= 20 or not 0 < self.max_drawdown_pct <= 80 or not 0 <= self.drawdown_penalty <= 10:
            raise ValueError('Invalid RL risk limits')
        if not 0 <= self.turnover_penalty <= .01:
            raise ValueError('Turnover penalty must be between 0 and 0.01')
        if self.amount_unit not in ('percent', 'price') or self.amount_per_trade <= 0 or (self.amount_unit == 'percent' and self.amount_per_trade > 100):
            raise ValueError('Invalid RL position size')

"""Position close signals and stops, effective only after the observed candle."""
import numpy as np


def indicator_exit(direction, previous, current, mode, threshold=50):
    if mode == 'none':
        return None
    ema = False
    if mode in ('ema', 'either') and np.isfinite(previous[:2]).all() and np.isfinite(current[:2]).all():
        before, now = previous[0]-previous[1], current[0]-current[1]
        ema = before >= 0 and now < 0 if direction == 1 else before <= 0 and now > 0
    rsi = False
    if mode in ('rsi', 'either') and np.isfinite(previous[2]) and np.isfinite(current[2]):
        rsi = previous[2] >= threshold and current[2] < threshold if direction == 1 else previous[2] <= threshold and current[2] > threshold
    if ema and rsi:
        return 'ema_rsi_exit'
    if ema:
        return 'ema_exit'
    if rsi:
        return 'rsi_exit'
    return None


def updated_stop(position, row, mode, tick):
    if mode == 'fixed':
        return None
    direction = position['direction']
    candidates = []
    if mode in ('breakeven', 'breakeven_trailing'):
        reached = row[1] >= position['entry']+position['initialRisk'] if direction == 1 else row[2] <= position['entry']-position['initialRisk']
        if reached:
            candidates.append((position['entry'], 'breakeven'))
    if mode in ('trailing', 'breakeven_trailing'):
        candidates.append((float(row[2]-tick if direction == 1 else row[1]+tick), 'trailing'))
    candidates = [(price,reason) for price,reason in candidates if price > 0 and direction*(price-position['stop']) > 1e-10]
    if not candidates:
        return None
    price, reason = max(candidates, key=lambda pair: direction*pair[0])
    return dict(price=float(price), reason=reason)

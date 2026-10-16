"""Entry readiness of the BB Outer Band Reversal strategy on a completed bar.

Shared by the live bot and paper trading so both report the same checks.
Readiness is the share of passing entry checks, not a win probability.
"""
import math


def _metric(value) -> float | None:
    number = float(value)
    return number if math.isfinite(number) else None


def strategy_readiness(signal, config: dict) -> dict:
    """Return long/short readiness percentages and their individual checks."""
    common = [
        ('ATR', bool(signal.atr >= config['min_atr']), _metric(signal.atr), float(config['min_atr'])),
        ('BB width', bool(signal.bb_width_pct >= config['min_bb_width_pct']), _metric(signal.bb_width_pct),
         float(config['min_bb_width_pct'])),
        ('ADX', bool(signal.adx > config['adx_threshold']), _metric(signal.adx), float(config['adx_threshold'])),
        ('Trend ready', bool(not config.get('use_sma_trend_adjustment', True) or signal.sma_ready), None, None),
    ]

    def side(rebound, direction_allowed) -> dict:
        checks = common + [
            ('Band rebound', bool(rebound), None, None),
            ('Direction allowed', bool(direction_allowed), None, None),
        ]
        return dict(readiness=round(100 * sum(int(item[1]) for item in checks) / len(checks)),
                    checks=[dict(label=label, passed=passed, value=value, threshold=threshold)
                            for label, passed, value, threshold in checks])

    long = side(signal.long_rebound, signal.long_direction_allowed)
    short = side(signal.short_rebound, signal.short_direction_allowed)
    return dict(longReadiness=long['readiness'], shortReadiness=short['readiness'],
                longChecks=long['checks'], shortChecks=short['checks'],
                signal='long' if bool(signal.long_signal) else 'short' if bool(signal.short_signal) else None)

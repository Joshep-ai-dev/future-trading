"""JSON-safe scalar helpers for market data responses."""
import math


def optional_volume(value):
    try:
        volume = float(value)
    except (TypeError, ValueError):
        return {}
    return {'volume': volume} if math.isfinite(volume) else {}

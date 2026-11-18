"""Read market leverage without changing the exchange account."""
import math


def positive_number(value: object) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and number >= 1 else None


def leverage_profile(service, venue: str) -> dict:
    exchange, market = service._get(venue)
    symbol = market['symbol']
    limits = (market.get('limits') or {}).get('leverage') or {}
    minimum = math.ceil(positive_number(limits.get('min')) or 1)
    maximum = positive_number(limits.get('max'))
    current_values = []
    errors = []
    try:
        positions = service.positions(venue)
        current_values = [positive_number(row.get('leverage')) for row in positions
                          if row.get('symbol') == symbol and row.get('marginMode') == 'isolated']
        current_values = [value for value in current_values if value is not None]
    except Exception:
        errors.append('Current position leverage could not be read.')
    if not current_values and venue == 'hyperliquid' and isinstance(exchange.walletAddress, str):
        try:
            coin = (market.get('info') or {}).get('name') or market.get('baseName') or market.get('base')
            row = exchange.publicPostInfo({'type': 'activeAssetData', 'user': exchange.walletAddress, 'coin': coin})
            leverage = row.get('leverage') or {}
            value = positive_number(leverage.get('value'))
            if leverage.get('type') == 'isolated' and value is not None:
                current_values = [value]
        except Exception:
            errors.append('Current asset leverage could not be read.')
    if not current_values and exchange.has.get('fetchLeverage'):
        try:
            row = exchange.fetch_leverage(symbol, {'marginMode': 'isolated'})
            if row.get('marginMode') == 'isolated':
                current_values = [value for key in ('longLeverage', 'shortLeverage')
                                  if (value := positive_number(row.get(key))) is not None]
        except Exception:
            errors.append('Current account leverage could not be read.')
    if maximum is None and exchange.has.get('fetchLeverageTiers'):
        try:
            tiers = exchange.fetch_leverage_tiers([symbol]).get(symbol, [])
            maxima = [value for row in tiers
                      if (value := positive_number(row.get('maxLeverage'))) is not None]
            maximum = max(maxima) if maxima else None
        except Exception:
            errors.append('Exchange leverage limits could not be read.')
    # The UI uses one setting for both directions. Do not guess when they differ.
    distinct = set(current_values)
    current = next(iter(distinct)) if len(distinct) == 1 else None
    return dict(venue=venue, symbol=symbol, minimum=minimum,
                maximum=math.floor(maximum) if maximum is not None else None,
                current=current, differentSides=len(distinct) > 1, warnings=errors)

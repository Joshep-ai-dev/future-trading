"""Read classic HTX linear accounts when the V5 adapter exposes no USDT account."""
from typing import Any


def classic_request(exchange: Any, endpoint: str, params: dict) -> Any:
    response = exchange.request('linear-swap-api/v1/' + endpoint,
                                ['contract', 'private'], 'POST', params)
    if response.get('status') != 'ok':
        raise ValueError('HTX classic account query failed')
    return response.get('data')


def classic_balance(exchange: Any) -> dict:
    accounts = []
    for endpoint in ('swap_account_info', 'swap_cross_account_info'):
        rows = classic_request(exchange, endpoint, {})
        if not isinstance(rows, list):
            raise ValueError('HTX returned an unrecognized classic account response')
        accounts.extend(row for row in rows if row.get('margin_asset') == 'USDT')
    if not accounts:
        raise ValueError('HTX did not expose a USDT futures account. Check API account access.')
    total = sum(float(row['margin_balance']) for row in accounts)
    free = sum(float(row['margin_available']) for row in accounts)
    used = sum(float(row.get('margin_position', 0)) + float(row.get('margin_frozen', 0)) for row in accounts)
    return {'total': {'USDT': total}, 'free': {'USDT': free}, 'used': {'USDT': used}}


def classic_positions(exchange: Any, market: dict) -> list[dict]:
    positions = []
    for mode, endpoint in (('isolated', 'swap_position_info'), ('cross', 'swap_cross_position_info')):
        rows = classic_request(exchange, endpoint, {'contract_code': market['id']})
        if not isinstance(rows, list):
            raise ValueError('HTX returned an unrecognized position response')
        for row in rows:
            if row.get('contract_code') == market['id']:
                positions.append(exchange.parse_position({**row, 'margin_mode': mode}, market))
    return positions


def classic_orders(exchange: Any, market: dict) -> list[dict]:
    orders = []
    for mode, endpoint in (('isolated', 'swap_openorders'), ('cross', 'swap_cross_openorders')):
        page = 1
        while True:
            data = classic_request(exchange, endpoint,
                {'contract_code': market['id'], 'page_index': page, 'page_size': 50})
            if not isinstance(data, dict) or not isinstance(data.get('orders'), list):
                raise ValueError('HTX returned an unrecognized orders response')
            orders.extend(exchange.parse_order({**row, 'margin_mode': mode}, market)
                          for row in data['orders'] if row.get('contract_code') == market['id'])
            if page >= int(data.get('total_page', 1)):
                break
            page += 1
            if page > 100:
                raise ValueError('HTX open order result exceeded the supported page limit')
    return orders

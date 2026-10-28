"""Read classic HTX linear accounts when the V5 adapter exposes no USDT account."""
from typing import Any
import json
import math


def normalize_htx_balance(balance: dict) -> dict:
    """Read HTX's available/available_margin fields consistently across adapter releases."""
    info = balance.get('info') or {}
    if not isinstance(info, dict):
        return balance
    data = info.get('data') or info
    if not isinstance(data, dict) or not isinstance(data.get('details'), list):
        return balance
    for detail in data['details']:
        if str(detail.get('currency', '')).upper() != 'USDT':
            continue
        raw = detail.get('available_margin')
        if raw is None:
            raw = detail.get('available')
        if raw is None:
            continue
        try:
            free = float(raw)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(free):
            continue
        result = dict(balance)
        result['free'] = dict(balance.get('free') or {}, USDT=free)
        # Prefer explicit initial margin; never substitute wallet equity for spendable margin.
        used = detail.get('initial_margin')
        if used is not None:
            try:
                used = float(used)
                if math.isfinite(used):
                    result['used'] = dict(balance.get('used') or {}, USDT=used)
            except (TypeError, ValueError):
                pass
        return result
    return balance


def rejection_reason(error: Exception) -> str:
    """Classify structured exchange errors using fixed labels, never echo their text."""
    response = {}
    text = str(error)
    try:
        start = text.index('{')
        response, _ = json.JSONDecoder().raw_decode(text[start:])
        if not isinstance(response, dict):
            response = {}
    except (ValueError, json.JSONDecodeError):
        pass
    message = str(response.get('err-msg', response.get('err_msg', response.get('message', '')))).lower()
    code = str(response.get('err-code', response.get('err_code', response.get('code', ''))))
    suffix = f' ({code})' if code in ('401', '403', '1003', 'api-signature-not-valid', 'api-signature-check-failed') else ''
    if type(error).__name__ == 'PermissionDenied':
        return 'HTX denied access to this account API' + suffix
    if 'ip address' in message or 'ip whitelist' in message:
        return 'HTX reported an IP-address authentication restriction' + suffix
    if 'timestamp' in message or 'expired' in message:
        return 'HTX rejected the request timestamp' + suffix
    if 'permission' in message:
        return 'HTX rejected API permissions' + suffix
    if 'access key' in message or 'accesskey' in message:
        return 'HTX did not recognize the access key' + suffix
    return 'HTX rejected authentication or account API access' + suffix


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


def classic_conditional_orders(exchange: Any, market: dict) -> list[dict]:
    """Read pending TP/SL, trigger and trailing orders in both margin accounts."""
    orders = []
    for mode, prefix in (('isolated', 'swap_'), ('cross', 'swap_cross_')):
        for kind in ('tpsl', 'trigger', 'track'):
            page = 1
            while True:
                data = classic_request(exchange, prefix + kind + '_openorders',
                                       dict(contract_code=market['id'], page_index=page, page_size=50))
                if not isinstance(data, dict) or not isinstance(data.get('orders'), list):
                    raise ValueError('HTX returned an unrecognized conditional orders response')
                for row in data['orders']:
                    if row.get('contract_code') != market['id']:
                        continue
                    order_id = row.get('order_id_str') or row.get('order_id')
                    if order_id is None:
                        raise ValueError('HTX returned a conditional order without an id')
                    orders.append(dict(id=f'{mode}:{kind}:{order_id}', side=row.get('direction'),
                        type=row.get('tpsl_order_type') or kind, marginMode=mode,
                        price=None if not row.get('order_price') else float(row['order_price']),
                        triggerPrice=None if row.get('trigger_price') is None else float(row['trigger_price']),
                        amount=None if row.get('volume') is None else float(row['volume']),
                        filled=0, status='open'))
                if page >= int(data.get('total_page', 1)):
                    break
                page += 1
                if page > 100:
                    raise ValueError('HTX conditional orders exceeded the supported page limit')
    return orders

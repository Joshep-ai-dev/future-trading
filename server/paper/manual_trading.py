"""Virtual market execution in the existing per-user paper session."""
import math


class ManualPaperTrading:
    def manual_protection(self) -> dict:
        with self.lock:
            if not self.state or self.state.get('executionMode') != 'manual' or not self.state.get('openPosition'):
                raise ValueError('No manual paper position to protect')
            position = self.state['openPosition']
            return dict(stop=position.get('stop') or None, takeProfit=position.get('take_profit'))

    def set_manual_protection(self, request):
        with self.lock:
            self.manual_protection()
            original, position = self.state, self.state['openPosition']
            market = self.state['settings']['market']
        price, now = self.manual_price(market)
        with self.lock:
            if self.state is not original or self.state['openPosition'] is not position:
                raise ValueError('Paper position changed; refresh the account')
            self.mark_manual(price, now)
            if self.state['openPosition'] is None:
                raise ValueError('The paper position closed before protection could be updated')
            direction = position['direction']
            if request.stop_price is not None and (price-request.stop_price)*direction <= 0:
                raise ValueError('Stop loss must be on the losing side of the current price')
            if request.take_profit_price is not None and (request.take_profit_price-price)*direction <= 0:
                raise ValueError('Take profit must be on the profitable side of the current price')
            position.update(stop=request.stop_price or 0, take_profit=request.take_profit_price)
            self.save(force=True)
            return self.status()

    def price_minutes(self, market: str, limit: int = 300) -> list[dict]:
        if market == 'xag':
            return self.live_fetch(limit)
        if market.startswith('dataset:'):
            from server.market.paper_feed import dataset_minutes
            return dataset_minutes(market)
        raise ValueError('Download this market from its exchange to use live paper trading')

    def manual_price(self, market: str) -> tuple[float, int]:
        rows = self.price_minutes(market)
        now = int(self.now())
        if not rows or now-rows[-1]['time'] > 120 or rows[-1]['time'] > now:
            raise ValueError('No fresh exchange price. Waiting for market sync.')
        price = float(rows[-1]['close'])
        if not math.isfinite(price) or price <= 0:
            raise ValueError('Invalid exchange price')
        return price, now

    def manual_order(self, request):
        # Fetch outside the account lock; recheck session and bot ownership afterwards.
        with self.lock:
            if not self.state or self.state.get('executionMode') != 'manual':
                raise ValueError('Start a manual paper account first')
            original, market = self.state, self.state['settings']['market']
        price, now = self.manual_price(market)
        with self.lock:
            state = self.state
            if state is not original or state.get('executionMode') != 'manual':
                raise ValueError('Paper session changed; retry the order')
            if request.request_id in state.get('manualRequests', []):
                return self.status()
            if not state['running'] or state['halted'] or state['openPosition']:
                raise ValueError('Manual account is paused or already has an open position')
            direction = 1 if request.direction == 'long' else -1
            stop, target = request.stop_price, request.take_profit_price
            if stop is not None and (price-stop)*direction <= 0:
                raise ValueError('Stop loss must be on the losing side of the entry price')
            if target is not None and (target-price)*direction <= 0:
                raise ValueError('Take profit must be on the profitable side of the entry price')
            margin = request.quantity*price/request.leverage
            if margin > state['balance'] or margin <= 0:
                raise ValueError('Insufficient virtual margin')
            state['settings']['max_leverage'] = request.leverage
            state['openPosition'] = dict(direction=direction, entry_time=now, entry_price=price,
                quantity=request.quantity, stop=stop or 0, take_profit=target, trailing_active=False,
                leverage=request.leverage, margin=margin)
            state['manualRequests'] = (state.get('manualRequests', [])+[request.request_id])[-50:]
            state.update(latestPrice=price, quoteTime=now, equity=state['balance'])
            self.save(force=True)
            return self.status()

    def finish_manual(self, price: float, now: int, reason: str) -> None:
        state, position = self.state, self.state['openPosition']
        pnl = (price-position['entry_price'])*position['direction']*position['quantity']
        state['balance'] += pnl
        state['trades'].append({**position, 'id':len(state['trades'])+1, 'exit_time':now,
                               'exit_price':price, 'exit_reason':reason, 'pnl':pnl})
        state.update(openPosition=None, equity=state['balance'], latestPrice=price,
                     halted=state['balance'] <= 0)
        if state['halted']:
            state['running'] = False
        state['equityHistory'].append(dict(time=now, value=state['balance']))
        self.save(force=True)

    def manual_close(self):
        with self.lock:
            if not self.state or not self.state.get('openPosition'):
                raise ValueError('No manual paper position to close')
            if self.state.get('executionMode') != 'manual' and (self.state['running'] or self.state.get('mode','live') != 'live'):
                raise ValueError('Pause the live paper bot before manually closing its position')
            original, position = self.state, self.state['openPosition']
            market = self.state['settings']['market']
        price, now = self.manual_price(market)
        with self.lock:
            if self.state is not original or self.state['openPosition'] is not position:
                raise ValueError('Paper position changed; refresh the account')
            if self.state.get('executionMode') != 'manual':
                # A paused virtual bot hands its position and balance to the manual account.
                position['margin'] = position['quantity']*position['entry_price']/self.state['settings']['max_leverage']
                self.state.update(executionMode='manual', running=True, strategyState=None)
            self.mark_manual(price, now)
            if self.state['openPosition']:
                self.finish_manual(price, now, 'manual_close')
            return self.status()

    def mark_manual(self, price: float, now: int) -> None:
        state, position = self.state, self.state['openPosition']
        state.update(latestPrice=price, quoteTime=now, virtualTime=now)
        if position:
            direction = position['direction']
            stop, target = position.get('stop'), position.get('take_profit')
            pnl = (price-position['entry_price'])*direction*position['quantity']
            if pnl <= -position['margin']:
                # Isolated virtual margin: the remaining account funds stay available.
                liquidation = position['entry_price']-direction*position['margin']/position['quantity']
                self.finish_manual(liquidation, now, 'liquidation')
            elif stop and (price-stop)*direction <= 0:
                self.finish_manual(price, now, 'stop_loss')
            elif target and (price-target)*direction >= 0:
                self.finish_manual(price, now, 'take_profit')
            else:
                state['equity'] = state['balance']+pnl

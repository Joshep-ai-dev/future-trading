"""Per-user trading workspaces.

Each signed-in user gets an isolated paper session, exchange connections, live
bot and exchange stream. Nothing here is shared between users except the public
market data feeds.
"""
from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass

from server.exchanges.exchange_stream import ExchangeStreams
from server.exchanges.live_exchange import AutomaticLiveBot, LiveExchange
from server.market.forming_candle import fetch_live_minutes
from server.paper.paper_trading import PaperTrading
from server.paper.session_store import DatabaseSessionStore

logger = logging.getLogger(__name__)


class SharedMinuteFeed:
    """One public OKX minute-candle request per second, shared by every paper session."""

    def __init__(self, fetch=fetch_live_minutes, ttl: float = .9):
        self.fetch, self.ttl = fetch, ttl
        self.lock = threading.Lock()
        self.cache: dict[int, tuple[float, list]] = {}

    def __call__(self, limit: int):
        with self.lock:
            hit = self.cache.get(limit)
            if hit and time.monotonic() - hit[0] < self.ttl:
                return hit[1]
            rows = self.fetch(limit)
            self.cache[limit] = (time.monotonic(), rows)
            return rows


@dataclass
class Workspace:
    user_id: int
    paper: PaperTrading
    exchange: LiveExchange
    bot: AutomaticLiveBot
    streams: ExchangeStreams


class WorkspaceRegistry:
    def __init__(self, data_store, paper_factory=None):
        self.data = data_store
        self.lock = threading.Lock()
        self.workspaces: dict[int, Workspace] = {}
        self.minute_feed = SharedMinuteFeed()
        self.paper_factory = paper_factory or (lambda user_id: PaperTrading(
            store=DatabaseSessionStore(self.data, user_id), live_fetch=self.minute_feed))

    def get(self, user_id: int) -> Workspace:
        with self.lock:
            workspace = self.workspaces.get(user_id)
            if workspace:
                return workspace
            paper = self.paper_factory(user_id)
            exchange = LiveExchange()
            bot = AutomaticLiveBot(exchange)
            exchange.auto_bot = bot
            bot.on_event = lambda venue, kind, detail: self._log(user_id, venue, kind, detail)
            workspace = Workspace(user_id, paper, exchange, bot, ExchangeStreams(exchange))
            self.workspaces[user_id] = workspace
        paper.start()
        return workspace

    def _log(self, user_id: int, venue: str, kind: str, detail: dict) -> None:
        try:
            self.data.log_bot_event(user_id, venue, kind, detail)
        except Exception:
            logger.exception('Could not record live bot event for user %s', user_id)

    def restore_running(self) -> None:
        """Resume paper sessions that were running when the backend stopped."""
        try:
            users = self.data.running_paper_users()
        except Exception:
            logger.exception('Could not list running paper sessions')
            return
        for user_id in users:
            self.get(user_id)

    def active(self) -> list[Workspace]:
        with self.lock:
            return list(self.workspaces.values())

    async def shutdown(self) -> None:
        for workspace in self.active():
            workspace.bot.stop_event.set()
            workspace.paper.shutdown()
            await workspace.streams.close()

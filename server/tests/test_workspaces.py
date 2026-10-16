import unittest
from unittest.mock import MagicMock

from server.core.workspaces import SharedMinuteFeed, WorkspaceRegistry
from server.paper.session_store import DatabaseSessionStore


class FakeData:
    def __init__(self):
        self.saved, self.trades, self.events, self.archived = [], [], [], []
        self.stored = {}

    def load_paper(self, user_id):
        return self.stored.get(user_id)

    def save_paper(self, user_id, state):
        self.saved.append((user_id, dict(state)))
        self.stored[user_id] = dict(state)

    def save_paper_trades(self, user_id, state):
        self.trades.append((user_id, len(state.get('trades') or [])))

    def archive_paper(self, user_id, state):
        self.archived.append((user_id, state['startedAt']))

    def log_bot_event(self, user_id, venue, kind, detail):
        self.events.append((user_id, venue, kind))

    def running_paper_users(self):
        return [7]


class WorkspaceIsolationTests(unittest.TestCase):
    def registry(self, data):
        paper = lambda user_id: MagicMock(name=f'paper-{user_id}')
        return WorkspaceRegistry(data, paper_factory=paper)

    def test_each_user_gets_separate_services_and_reuses_their_own(self):
        registry = self.registry(FakeData())
        first, second = registry.get(1), registry.get(2)
        self.assertIsNot(first.paper, second.paper)
        self.assertIsNot(first.exchange, second.exchange)
        self.assertIsNot(first.bot, second.bot)
        self.assertIs(first.exchange.auto_bot, first.bot)
        self.assertIs(registry.get(1), first)
        first.paper.start.assert_called_once()

    def test_live_bot_events_are_recorded_for_their_owner(self):
        data = FakeData()
        registry = self.registry(data)
        registry.get(3).bot.on_event('htx', 'open', {'direction': 'long'})
        registry.get(4).bot.on_event('okx', 'stop', {})
        self.assertEqual(data.events, [(3, 'htx', 'open'), (4, 'okx', 'stop')])

    def test_restore_starts_sessions_that_were_running(self):
        registry = self.registry(FakeData())
        registry.restore_running()
        self.assertEqual([workspace.user_id for workspace in registry.active()], [7])


class DatabaseSessionStoreTests(unittest.TestCase):
    def test_quote_saves_are_coalesced_but_trades_and_pauses_write_at_once(self):
        data, clock = FakeData(), [0.]
        store = DatabaseSessionStore(data, 5, interval=3, clock=lambda: clock[0])
        state = dict(startedAt=10, running=True, trades=[])
        store.save(state)
        clock[0] = 1
        store.save({**state, 'equity': 101})
        self.assertEqual(len(data.saved), 1)
        store.save({**state, 'trades': [{'id': 1}]})
        self.assertEqual(len(data.saved), 2)
        self.assertEqual(data.trades[-1], (5, 1))
        store.save({**state, 'trades': [{'id': 1}], 'running': False})
        self.assertEqual(len(data.saved), 3)
        clock[0] = 1.5
        store.save({**state, 'trades': [{'id': 1}], 'running': False, 'equity': 99})
        self.assertEqual(len(data.saved), 3)
        store.flush()
        self.assertEqual(data.saved[-1][1]['equity'], 99)

    def test_archive_belongs_to_the_store_user(self):
        data = FakeData()
        DatabaseSessionStore(data, 9).archive(dict(startedAt=42))
        self.assertEqual(data.archived, [(9, 42)])


class SharedMinuteFeedTests(unittest.TestCase):
    def test_concurrent_sessions_share_one_request_per_second(self):
        fetch = MagicMock(return_value=[{'time': 1}])
        feed = SharedMinuteFeed(fetch, ttl=60)
        self.assertEqual(feed(3), feed(3))
        fetch.assert_called_once_with(3)


if __name__ == '__main__':
    unittest.main()

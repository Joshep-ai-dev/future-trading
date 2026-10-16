"""Where a paper session's state lives: a JSON file (tests, single user) or a user's database row."""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path


class FileSessionStore:
    """Atomic JSON file with archived copies next to it."""

    def __init__(self, path: Path):
        self.path = Path(path)

    def load(self) -> dict | None:
        return json.loads(self.path.read_text(encoding='utf-8')) if self.path.exists() else None

    def save(self, state: dict, force: bool = False) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix('.json.tmp')
        temporary.write_text(json.dumps(state, allow_nan=False), encoding='utf-8')
        temporary.replace(self.path)

    def archive(self, state: dict | None) -> None:
        if state:
            archive = self.path.with_name(f'paper_trading_{state["startedAt"]}_{time.time_ns()}.json')
            archive.write_text(json.dumps(state, allow_nan=False), encoding='utf-8')
        elif self.path.exists():
            archive = self.path.with_name(f'paper_trading_unreadable_{time.time_ns()}.json')
            archive.write_bytes(self.path.read_bytes())

    def flush(self) -> None:
        pass


class DatabaseSessionStore:
    """One user's paper session in MySQL.

    The session saves every second while quotes update, so writes are coalesced
    to one per ``interval`` seconds; trade changes, starts and pauses write at once.
    """

    def __init__(self, data_store, user_id: int, interval: float = 3.0, clock=time.monotonic):
        self.data, self.user_id, self.interval, self.clock = data_store, user_id, interval, clock
        self.lock = threading.Lock()
        self.pending: dict | None = None
        self.last_write = 0.
        self.signature = None

    def load(self) -> dict | None:
        state = self.data.load_paper(self.user_id)
        if state:
            self.signature = (state.get('startedAt'), len(state.get('trades') or []), state.get('running'))
        return state

    def save(self, state: dict, force: bool = False) -> None:
        signature = (state.get('startedAt'), len(state.get('trades') or []), state.get('running'))
        with self.lock:
            changed = signature != self.signature
            if not (force or changed or self.clock() - self.last_write >= self.interval):
                self.pending = state
                return
            self.pending = None
            self.last_write = self.clock()
            self.signature = signature
        self.data.save_paper(self.user_id, state)
        if changed:
            self.data.save_paper_trades(self.user_id, state)

    def archive(self, state: dict | None) -> None:
        if state:
            self.data.archive_paper(self.user_id, state)

    def flush(self) -> None:
        with self.lock:
            state, self.pending = self.pending, None
        if state is not None:
            self.data.save_paper(self.user_id, state)

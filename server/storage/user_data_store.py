"""MySQL storage for each user's setups, backtests, paper sessions and bot events.

Every row is keyed by ``users.id`` so accounts never see each other's data.
Large paper-session state is stored zlib-compressed.
"""
from __future__ import annotations

import json
import threading
import zlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from server.storage.auth_store import auth_store

DATA = Path(__file__).resolve().parents[2] / 'data'
LEGACY_PROFILES = DATA / 'legacy_profiles.json'
LEGACY_PAPER = DATA / 'paper_trading.json'

TABLES = (
    '''CREATE TABLE IF NOT EXISTS bot_profiles (
        user_id BIGINT UNSIGNED NOT NULL,
        name VARCHAR(48) NOT NULL,
        settings JSON NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, name),
        CONSTRAINT fk_profile_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB''',
    '''CREATE TABLE IF NOT EXISTS backtest_runs (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        name VARCHAR(80) NULL,
        timeframe VARCHAR(8) NOT NULL,
        period_start BIGINT NOT NULL,
        period_end BIGINT NOT NULL,
        settings JSON NOT NULL,
        summary JSON NOT NULL,
        trades LONGBLOB NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_backtest_user (user_id, created_at),
        CONSTRAINT fk_backtest_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB''',
    '''CREATE TABLE IF NOT EXISTS paper_sessions (
        user_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
        running BOOLEAN NOT NULL DEFAULT FALSE,
        state LONGBLOB NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT fk_paper_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB''',
    '''CREATE TABLE IF NOT EXISTS paper_session_archive (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        started_at BIGINT NOT NULL,
        mode VARCHAR(8) NOT NULL,
        summary JSON NOT NULL,
        state LONGBLOB NOT NULL,
        archived_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_archive_user (user_id, archived_at),
        CONSTRAINT fk_archive_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB''',
    '''CREATE TABLE IF NOT EXISTS paper_trades (
        user_id BIGINT UNSIGNED NOT NULL,
        session_started BIGINT NOT NULL,
        trade_id INT NOT NULL,
        direction TINYINT NOT NULL,
        entry_time BIGINT NOT NULL,
        exit_time BIGINT NOT NULL,
        entry_price DOUBLE NOT NULL,
        exit_price DOUBLE NOT NULL,
        quantity DOUBLE NOT NULL,
        pnl DOUBLE NOT NULL,
        exit_reason VARCHAR(40) NOT NULL,
        PRIMARY KEY (user_id, session_started, trade_id),
        CONSTRAINT fk_paper_trade_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB''',
    '''CREATE TABLE IF NOT EXISTS live_bot_events (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        venue VARCHAR(24) NOT NULL,
        kind VARCHAR(24) NOT NULL,
        detail JSON NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_bot_event_user (user_id, created_at),
        CONSTRAINT fk_bot_event_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB''',
)


def _pack(value: Any) -> bytes:
    return zlib.compress(json.dumps(value, allow_nan=False, separators=(',', ':')).encode(), 6)


def _unpack(blob: bytes | bytearray | None) -> Any:
    return None if blob is None else json.loads(zlib.decompress(bytes(blob)).decode())


def _json(value: Any) -> Any:
    return json.loads(value) if isinstance(value, (str, bytes, bytearray)) else value


def _iso(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.replace(tzinfo=value.tzinfo or timezone.utc).isoformat()
    return str(value)


def paper_summary(state: dict) -> dict:
    trades = state.get('trades') or []
    capital = float(state.get('settings', {}).get('capital') or 0)
    wins = sum(1 for trade in trades if trade.get('pnl', 0) > 0)
    return dict(startedAt=state.get('startedAt'), mode=state.get('mode', 'live'), capital=capital,
                equity=state.get('equity'), balance=state.get('balance'), trades=len(trades), wins=wins,
                netPnl=(float(state.get('equity') or capital) - capital),
                timeframe=state.get('settings', {}).get('entry_timeframe'),
                leverage=state.get('settings', {}).get('max_leverage'),
                lastProcessed=state.get('lastProcessed'), completed=bool(state.get('completed')),
                halted=bool(state.get('halted')))


class UserDataStore:
    def __init__(self, connect: Callable | None = None):
        self._connect_fn = connect
        self.lock = threading.Lock()
        self.ready = False

    def _connect(self):
        connection = (self._connect_fn or auth_store._connect)()
        cursor = connection.cursor()
        cursor.execute("SET time_zone='+00:00'")  # TIMESTAMP columns are read back as UTC.
        cursor.close()
        return connection

    def _run(self, sql: str, params: tuple = (), fetch: str | None = None):
        with self._connect() as connection:
            cursor = connection.cursor(dictionary=True)
            try:
                cursor.execute(sql, params)
                if fetch == 'one':
                    return cursor.fetchone()
                if fetch == 'all':
                    return cursor.fetchall()
                return cursor.lastrowid
            finally:
                cursor.close()

    def initialize(self) -> None:
        with self.lock:
            if self.ready:
                return
            with self._connect() as connection:
                cursor = connection.cursor()
                for statement in TABLES:
                    cursor.execute(statement)
                cursor.close()
            self.ready = True
        self._migrate_legacy()

    def _first_admin(self) -> int | None:
        row = self._run("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1", fetch='one')
        return int(row['id']) if row else None

    def _migrate_legacy(self) -> None:
        """Move the former shared profiles and paper session to the first admin, once."""
        owner = self._first_admin()
        if owner is None:
            return
        if LEGACY_PROFILES.exists():
            try:
                for profile in json.loads(LEGACY_PROFILES.read_text(encoding='utf-8')):
                    self._run('INSERT IGNORE INTO bot_profiles (user_id,name,settings) VALUES (%s,%s,%s)',
                              (owner, profile['name'], json.dumps(profile['settings'])))
                LEGACY_PROFILES.rename(LEGACY_PROFILES.with_suffix('.json.migrated'))
            except (OSError, ValueError, KeyError):
                pass
        if LEGACY_PAPER.exists() and self.load_paper(owner) is None:
            try:
                state = json.loads(LEGACY_PAPER.read_text(encoding='utf-8'))
                self.save_paper(owner, state)
                LEGACY_PAPER.rename(LEGACY_PAPER.with_suffix('.json.migrated'))
            except (OSError, ValueError):
                pass

    # Saved bot setups
    def list_profiles(self, user_id: int) -> list[dict]:
        rows = self._run('SELECT name, settings, updated_at FROM bot_profiles WHERE user_id=%s ORDER BY name',
                         (user_id,), fetch='all')
        return [dict(name=row['name'], settings=_json(row['settings']), updatedAt=_iso(row['updated_at'])) for row in rows]

    def save_profile(self, user_id: int, name: str, settings: dict) -> dict:
        self._run('INSERT INTO bot_profiles (user_id,name,settings) VALUES (%s,%s,%s) '
                  'ON DUPLICATE KEY UPDATE settings=VALUES(settings)', (user_id, name, json.dumps(settings)))
        return dict(name=name, settings=settings)

    def delete_profile(self, user_id: int, name: str) -> bool:
        before = self._run('SELECT name FROM bot_profiles WHERE user_id=%s AND name=%s', (user_id, name), fetch='one')
        self._run('DELETE FROM bot_profiles WHERE user_id=%s AND name=%s', (user_id, name))
        return before is not None

    # Backtest results
    def save_backtest(self, user_id: int, result: dict, name: str | None = None) -> int:
        period = result['backtest']
        return int(self._run(
            'INSERT INTO backtest_runs (user_id,name,timeframe,period_start,period_end,settings,summary,trades) '
            'VALUES (%s,%s,%s,%s,%s,%s,%s,%s)',
            (user_id, name, result['executionTimeframe'], int(period['start']), int(period['end']),
             json.dumps(result['settings']), json.dumps(period['summary']), _pack(period['trades']))))

    def list_backtests(self, user_id: int, limit: int = 50) -> list[dict]:
        rows = self._run('SELECT id,name,timeframe,period_start,period_end,summary,created_at FROM backtest_runs '
                         'WHERE user_id=%s ORDER BY id DESC LIMIT %s', (user_id, limit), fetch='all')
        return [dict(id=row['id'], name=row['name'], timeframe=row['timeframe'], start=row['period_start'],
                     end=row['period_end'], summary=_json(row['summary']), createdAt=_iso(row['created_at'])) for row in rows]

    def get_backtest(self, user_id: int, run_id: int) -> dict | None:
        row = self._run('SELECT * FROM backtest_runs WHERE user_id=%s AND id=%s', (user_id, run_id), fetch='one')
        if not row:
            return None
        return dict(id=row['id'], name=row['name'], timeframe=row['timeframe'], start=row['period_start'],
                    end=row['period_end'], settings=_json(row['settings']), summary=_json(row['summary']),
                    trades=_unpack(row['trades']), createdAt=_iso(row['created_at']))

    def rename_backtest(self, user_id: int, run_id: int, name: str | None) -> None:
        self._run('UPDATE backtest_runs SET name=%s WHERE user_id=%s AND id=%s', (name, user_id, run_id))

    def delete_backtest(self, user_id: int, run_id: int) -> None:
        self._run('DELETE FROM backtest_runs WHERE user_id=%s AND id=%s', (user_id, run_id))

    # Paper sessions
    def load_paper(self, user_id: int) -> dict | None:
        row = self._run('SELECT state FROM paper_sessions WHERE user_id=%s', (user_id,), fetch='one')
        return _unpack(row['state']) if row else None

    def save_paper(self, user_id: int, state: dict) -> None:
        self._run('INSERT INTO paper_sessions (user_id,running,state) VALUES (%s,%s,%s) '
                  'ON DUPLICATE KEY UPDATE running=VALUES(running), state=VALUES(state)',
                  (user_id, bool(state.get('running')), _pack(state)))

    def save_paper_trades(self, user_id: int, state: dict) -> None:
        started = state.get('startedAt')
        trades = state.get('trades') or []
        if started is None or not trades:
            return
        with self._connect() as connection:
            cursor = connection.cursor()
            cursor.executemany(
                'INSERT IGNORE INTO paper_trades (user_id,session_started,trade_id,direction,entry_time,exit_time,'
                'entry_price,exit_price,quantity,pnl,exit_reason) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                [(user_id, int(started), int(t['id']), int(t['direction']), int(t['entry_time']), int(t['exit_time']),
                  float(t['entry_price']), float(t['exit_price']), float(t['quantity']), float(t['pnl']),
                  str(t.get('exit_reason', ''))[:40]) for t in trades])
            cursor.close()

    def archive_paper(self, user_id: int, state: dict) -> None:
        self.save_paper_trades(user_id, state)
        self._run('INSERT INTO paper_session_archive (user_id,started_at,mode,summary,state) VALUES (%s,%s,%s,%s,%s)',
                  (user_id, int(state.get('startedAt') or 0), state.get('mode', 'live'),
                   json.dumps(paper_summary(state)), _pack({k: v for k, v in state.items()
                                                             if k not in ('replayCandles', 'minuteCandles')})))

    def running_paper_users(self) -> list[int]:
        rows = self._run('SELECT user_id FROM paper_sessions WHERE running=TRUE', fetch='all')
        return [int(row['user_id']) for row in rows]

    def paper_history(self, user_id: int, limit: int = 30) -> list[dict]:
        rows = self._run('SELECT id,summary,archived_at FROM paper_session_archive WHERE user_id=%s '
                         'ORDER BY id DESC LIMIT %s', (user_id, limit), fetch='all')
        return [dict(id=row['id'], archivedAt=_iso(row['archived_at']), **_json(row['summary'])) for row in rows]

    def paper_trades(self, user_id: int, session_started: int) -> list[dict]:
        rows = self._run('SELECT * FROM paper_trades WHERE user_id=%s AND session_started=%s ORDER BY trade_id',
                         (user_id, session_started), fetch='all')
        return [dict(id=row['trade_id'], direction=row['direction'], entryTime=row['entry_time'],
                     exitTime=row['exit_time'], entryPrice=row['entry_price'], exitPrice=row['exit_price'],
                     quantity=row['quantity'], pnl=row['pnl'], exitReason=row['exit_reason']) for row in rows]

    # Live bot events
    def log_bot_event(self, user_id: int, venue: str, kind: str, detail: dict) -> None:
        self._run('INSERT INTO live_bot_events (user_id,venue,kind,detail) VALUES (%s,%s,%s,%s)',
                  (user_id, venue, kind, json.dumps(detail, default=str)))

    def bot_events(self, user_id: int, limit: int = 100) -> list[dict]:
        rows = self._run('SELECT id,venue,kind,detail,created_at FROM live_bot_events WHERE user_id=%s '
                         'ORDER BY id DESC LIMIT %s', (user_id, limit), fetch='all')
        return [dict(id=row['id'], venue=row['venue'], kind=row['kind'], detail=_json(row['detail']),
                     createdAt=_iso(row['created_at'])) for row in rows]


user_data_store = UserDataStore()

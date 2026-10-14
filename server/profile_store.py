"""SQLite storage for reusable trading bot setup profiles."""
import json
import sqlite3
from pathlib import Path


DATABASE = Path(__file__).resolve().parent.parent / 'data' / 'trading_profiles.sqlite3'


class ProfileStore:
    def __init__(self, path=DATABASE):
        self.path = Path(path)

    def _connect(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute('''CREATE TABLE IF NOT EXISTS bot_profiles (
            name TEXT PRIMARY KEY COLLATE NOCASE,
            settings TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )''')
        return connection

    def list(self):
        connection = self._connect()
        try:
            rows = connection.execute(
                'SELECT name, settings, updated_at FROM bot_profiles ORDER BY name COLLATE NOCASE'
            ).fetchall()
        finally:
            connection.close()
        return [dict(name=row['name'], settings=json.loads(row['settings']), updatedAt=row['updated_at'])
                for row in rows]

    def save(self, name, settings):
        connection = self._connect()
        try:
            with connection:
                connection.execute('''INSERT INTO bot_profiles(name, settings, updated_at)
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(name) DO UPDATE SET
                        settings=excluded.settings, updated_at=CURRENT_TIMESTAMP''',
                    (name, json.dumps(settings, separators=(',', ':'), allow_nan=False)))
                row = connection.execute(
                    'SELECT name, settings, updated_at FROM bot_profiles WHERE name = ?', (name,)
                ).fetchone()
        finally:
            connection.close()
        return dict(name=row['name'], settings=json.loads(row['settings']), updatedAt=row['updated_at'])

    def delete(self, name):
        connection = self._connect()
        try:
            with connection:
                cursor = connection.execute('DELETE FROM bot_profiles WHERE name = ?', (name,))
                return cursor.rowcount > 0
        finally:
            connection.close()


profile_store = ProfileStore()

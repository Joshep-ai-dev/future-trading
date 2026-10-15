"""Encrypted local exchange credentials; never return decrypted values to the UI."""
import json
import sqlite3
import threading
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

from .profile_store import DATABASE


KEY_FILE = Path(__file__).resolve().parent.parent / '.runtime' / 'credentials.key'


class CredentialStore:
    def __init__(self, path: Path = DATABASE, key_path: Path = KEY_FILE):
        self.path = Path(path)
        self.key_path = Path(key_path)
        self.lock = threading.RLock()

    def _cipher(self, create: bool = False) -> Fernet:
        if create:
            self.key_path.parent.mkdir(parents=True, exist_ok=True)
            try:
                with self.key_path.open('xb') as key_file:
                    key_file.write(Fernet.generate_key())
            except FileExistsError:
                pass
        try:
            return Fernet(self.key_path.read_bytes())
        except (OSError, ValueError) as error:
            raise ValueError('Saved API keys cannot be unlocked. Restore the local encryption key or forget and re-enter the credentials.') from error

    def _connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, timeout=10)
        connection.execute('CREATE TABLE IF NOT EXISTS exchange_credentials (venue TEXT PRIMARY KEY, encrypted BLOB NOT NULL)')
        return connection

    def venues(self) -> list[str]:
        with self.lock:
            connection = self._connect()
            try:
                return [row[0] for row in connection.execute('SELECT venue FROM exchange_credentials ORDER BY venue')]
            finally:
                connection.close()

    def save(self, venue: str, api_key: str, secret: str, passphrase: str | None) -> None:
        with self.lock:
            encrypted = self._cipher(create=True).encrypt(json.dumps(
                dict(api_key=api_key.strip(), secret=secret.strip(), passphrase=passphrase)
            ).encode())
            connection = self._connect()
            try:
                with connection:
                    connection.execute('INSERT INTO exchange_credentials VALUES (?, ?) ON CONFLICT(venue) DO UPDATE SET encrypted=excluded.encrypted', (venue, encrypted))
            finally:
                connection.close()

    def load(self, venue: str) -> dict:
        with self.lock:
            connection = self._connect()
            try:
                row = connection.execute('SELECT encrypted FROM exchange_credentials WHERE venue=?', (venue,)).fetchone()
            finally:
                connection.close()
            if row is None:
                raise ValueError('No saved API credentials for this exchange')
            try:
                return json.loads(self._cipher().decrypt(row[0]))
            except InvalidToken as error:
                raise ValueError('Saved API keys cannot be unlocked. Forget and re-enter the credentials.') from error

    def delete(self, venue: str) -> None:
        with self.lock:
            connection = self._connect()
            try:
                with connection:
                    connection.execute('DELETE FROM exchange_credentials WHERE venue=?', (venue,))
            finally:
                connection.close()


credential_store = CredentialStore()

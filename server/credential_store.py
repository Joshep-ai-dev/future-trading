"""Encrypted local exchange credentials; never return decrypted values to the UI."""
import json
import sqlite3
import threading
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

from .auth_store import auth_store


KEY_FILE = Path(__file__).resolve().parent.parent / '.runtime' / 'credentials.key'


class CredentialStore:
    def __init__(self, path: Path | None = None, key_path: Path = KEY_FILE):
        self.path = Path(path) if path is not None else None
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

    def _sqlite(self) -> sqlite3.Connection:
        assert self.path is not None
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, timeout=10)
        connection.execute('CREATE TABLE IF NOT EXISTS exchange_credentials (venue TEXT PRIMARY KEY, encrypted BLOB NOT NULL)')
        return connection

    def _mysql(self):
        connection = auth_store._connect()
        cursor = connection.cursor()
        cursor.execute('''CREATE TABLE IF NOT EXISTS exchange_credentials (
            user_id BIGINT UNSIGNED NOT NULL,
            venue VARCHAR(24) NOT NULL,
            encrypted LONGBLOB NOT NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id,venue),
            CONSTRAINT fk_credential_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB''')
        cursor.close()
        return connection

    def venues(self, user_id: int = 0) -> list[str]:
        with self.lock:
            connection = self._sqlite() if self.path is not None else self._mysql()
            try:
                if self.path is not None:
                    return [row[0] for row in connection.execute('SELECT venue FROM exchange_credentials ORDER BY venue')]
                cursor = connection.cursor()
                cursor.execute('SELECT venue FROM exchange_credentials WHERE user_id=%s ORDER BY venue', (user_id,))
                venues = [row[0] for row in cursor.fetchall()]
                cursor.close()
                return venues
            finally:
                connection.close()

    def save(self, venue: str, api_key: str, secret: str, passphrase: str | None, user_id: int = 0) -> None:
        with self.lock:
            encrypted = self._cipher(create=True).encrypt(json.dumps(
                dict(api_key=api_key.strip(), secret=secret.strip(), passphrase=passphrase)
            ).encode())
            connection = self._sqlite() if self.path is not None else self._mysql()
            try:
                if self.path is not None:
                    with connection:
                        connection.execute('INSERT INTO exchange_credentials VALUES (?, ?) ON CONFLICT(venue) DO UPDATE SET encrypted=excluded.encrypted', (venue, encrypted))
                else:
                    cursor = connection.cursor()
                    cursor.execute('INSERT INTO exchange_credentials (user_id,venue,encrypted) VALUES (%s,%s,%s) ON DUPLICATE KEY UPDATE encrypted=VALUES(encrypted)', (user_id, venue, encrypted))
                    cursor.close()
            finally:
                connection.close()

    def load(self, venue: str, user_id: int = 0) -> dict:
        with self.lock:
            connection = self._sqlite() if self.path is not None else self._mysql()
            try:
                if self.path is not None:
                    row = connection.execute('SELECT encrypted FROM exchange_credentials WHERE venue=?', (venue,)).fetchone()
                else:
                    cursor = connection.cursor()
                    cursor.execute('SELECT encrypted FROM exchange_credentials WHERE user_id=%s AND venue=%s', (user_id, venue))
                    row = cursor.fetchone()
                    cursor.close()
            finally:
                connection.close()
            if row is None:
                raise ValueError('No saved API credentials for this exchange')
            try:
                return json.loads(self._cipher().decrypt(row[0]))
            except InvalidToken as error:
                raise ValueError('Saved API keys cannot be unlocked. Forget and re-enter the credentials.') from error

    def delete(self, venue: str, user_id: int = 0) -> None:
        with self.lock:
            connection = self._sqlite() if self.path is not None else self._mysql()
            try:
                if self.path is not None:
                    with connection:
                        connection.execute('DELETE FROM exchange_credentials WHERE venue=?', (venue,))
                else:
                    cursor = connection.cursor()
                    cursor.execute('DELETE FROM exchange_credentials WHERE user_id=%s AND venue=%s', (user_id, venue))
                    cursor.close()
            finally:
                connection.close()


credential_store = CredentialStore()

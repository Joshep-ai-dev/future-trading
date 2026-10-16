"""Encrypted per-user exchange credentials in MySQL; never return decrypted values to the UI."""
import json
import threading
from pathlib import Path
from typing import Callable

from cryptography.fernet import Fernet, InvalidToken

from server.storage.auth_store import auth_store


KEY_FILE = Path(__file__).resolve().parents[2] / '.runtime' / 'credentials.key'
TABLE = '''CREATE TABLE IF NOT EXISTS exchange_credentials (
    user_id BIGINT UNSIGNED NOT NULL,
    venue VARCHAR(24) NOT NULL,
    encrypted LONGBLOB NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id,venue),
    CONSTRAINT fk_credential_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB'''


class CredentialStore:
    def __init__(self, connect: Callable | None = None, key_path: Path = KEY_FILE):
        self._connect_fn = connect
        self.key_path = Path(key_path)
        self.lock = threading.RLock()
        self.table_ready = False

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

    def _query(self, sql: str, params: tuple, fetch: str | None = None):
        connection = (self._connect_fn or auth_store._connect)()
        try:
            cursor = connection.cursor()
            if not self.table_ready:
                cursor.execute(TABLE)
                self.table_ready = True
            cursor.execute(sql, params)
            result = cursor.fetchall() if fetch == 'all' else cursor.fetchone() if fetch == 'one' else None
            cursor.close()
            return result
        finally:
            connection.close()

    def venues(self, user_id: int) -> list[str]:
        with self.lock:
            rows = self._query('SELECT venue FROM exchange_credentials WHERE user_id=%s ORDER BY venue', (user_id,), 'all')
            return [row[0] for row in rows]

    def save(self, venue: str, api_key: str, secret: str, passphrase: str | None, user_id: int) -> None:
        with self.lock:
            encrypted = self._cipher(create=True).encrypt(json.dumps(
                dict(api_key=api_key.strip(), secret=secret.strip(), passphrase=passphrase)
            ).encode())
            self._query('INSERT INTO exchange_credentials (user_id,venue,encrypted) VALUES (%s,%s,%s) '
                        'ON DUPLICATE KEY UPDATE encrypted=VALUES(encrypted)', (user_id, venue, encrypted))

    def load(self, venue: str, user_id: int) -> dict:
        with self.lock:
            row = self._query('SELECT encrypted FROM exchange_credentials WHERE user_id=%s AND venue=%s',
                              (user_id, venue), 'one')
            if row is None:
                raise ValueError('No saved API credentials for this exchange')
            try:
                return json.loads(self._cipher().decrypt(bytes(row[0])))
            except InvalidToken as error:
                raise ValueError('Saved API keys cannot be unlocked. Forget and re-enter the credentials.') from error

    def delete(self, venue: str, user_id: int) -> None:
        with self.lock:
            self._query('DELETE FROM exchange_credentials WHERE user_id=%s AND venue=%s', (user_id, venue))


credential_store = CredentialStore()

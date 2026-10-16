import tempfile
import unittest
from pathlib import Path

from server.storage.credential_store import CredentialStore


class FakeMySQL:
    """Minimal in-memory stand-in for the credential table's MySQL queries."""

    def __init__(self):
        self.rows: dict[tuple[int, str], bytes] = {}

    def __call__(self):
        return self

    def cursor(self):
        return self

    def execute(self, sql, params=()):
        self.result = None
        if sql.startswith('SELECT venue'):
            self.result = [(venue,) for (user, venue) in sorted(self.rows) if user == params[0]]
        elif sql.startswith('SELECT encrypted'):
            value = self.rows.get(params)
            self.result = None if value is None else (value,)
        elif sql.startswith('INSERT'):
            self.rows[(params[0], params[1])] = params[2]
        elif sql.startswith('DELETE'):
            self.rows.pop(params, None)

    def fetchall(self):
        return self.result

    def fetchone(self):
        return self.result

    def close(self):
        pass


class CredentialStoreTests(unittest.TestCase):
    def test_encrypted_round_trip_restart_replace_and_delete(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database, key_path = FakeMySQL(), Path(directory) / 'key'
            store = CredentialStore(database, key_path)
            store.save('htx', 'api-key-marker', 'secret-marker', 'passphrase-marker', user_id=1)
            encrypted = database.rows[(1, 'htx')]
            for value in (b'api-key-marker', b'secret-marker', b'passphrase-marker'):
                self.assertNotIn(value, encrypted)
            restarted = CredentialStore(database, key_path)
            self.assertEqual(restarted.load('htx', 1)['secret'], 'secret-marker')
            self.assertEqual(restarted.venues(1), ['htx'])
            restarted.save('htx', 'replacement', 'new-secret', None, user_id=1)
            self.assertEqual(restarted.load('htx', 1)['api_key'], 'replacement')
            restarted.delete('htx', 1)
            self.assertEqual(restarted.venues(1), [])
            with self.assertRaises(ValueError):
                restarted.load('htx', 1)

    def test_credentials_are_private_to_each_user(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = CredentialStore(FakeMySQL(), Path(directory) / 'key')
            store.save('okx', 'key-a', 'secret-a', 'pass-a', user_id=1)
            self.assertEqual(store.venues(2), [])
            with self.assertRaises(ValueError):
                store.load('okx', 2)

    def test_missing_or_wrong_encryption_key_fails_without_exposing_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database, key_path = FakeMySQL(), Path(directory) / 'key'
            store = CredentialStore(database, key_path)
            store.save('okx', 'key', 'private-secret', 'private-passphrase', user_id=1)
            key_path.unlink()
            with self.assertRaisesRegex(ValueError, 'cannot be unlocked'):
                store.load('okx', 1)
            other = CredentialStore(database, Path(directory) / 'other-key')
            other._cipher(create=True)
            with self.assertRaisesRegex(ValueError, 'cannot be unlocked'):
                other.load('okx', 1)


if __name__ == '__main__':
    unittest.main()

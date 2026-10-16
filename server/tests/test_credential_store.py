import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from server.storage.credential_store import CredentialStore


class CredentialStoreTests(unittest.TestCase):
    def test_encrypted_round_trip_restart_replace_and_delete(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'credentials.db'
            key_path = Path(directory) / 'key'
            store = CredentialStore(path, key_path)
            store.save('htx', 'api-key-marker', 'secret-marker', 'passphrase-marker')
            with closing(sqlite3.connect(path)) as connection:
                encrypted = connection.execute('SELECT encrypted FROM exchange_credentials').fetchone()[0]
            for value in (b'api-key-marker', b'secret-marker', b'passphrase-marker'):
                self.assertNotIn(value, encrypted)
            restarted = CredentialStore(path, key_path)
            self.assertEqual(restarted.load('htx')['secret'], 'secret-marker')
            self.assertEqual(restarted.venues(), ['htx'])
            restarted.save('htx', 'replacement', 'new-secret', None)
            self.assertEqual(restarted.load('htx')['api_key'], 'replacement')
            restarted.delete('htx')
            self.assertEqual(restarted.venues(), [])
            with self.assertRaises(ValueError):
                restarted.load('htx')

    def test_missing_or_wrong_encryption_key_fails_without_exposing_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'credentials.db'
            key_path = Path(directory) / 'key'
            store = CredentialStore(path, key_path)
            store.save('okx', 'key', 'private-secret', 'private-passphrase')
            key_path.unlink()
            with self.assertRaisesRegex(ValueError, 'cannot be unlocked'):
                store.load('okx')
            other = CredentialStore(path, Path(directory) / 'other-key')
            other._cipher(create=True)
            with self.assertRaisesRegex(ValueError, 'cannot be unlocked'):
                other.load('okx')

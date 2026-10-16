import unittest

from server.storage.auth_store import _password_hash, _password_matches


class AuthStoreTests(unittest.TestCase):
    def test_password_hash_is_salted_and_verifiable(self):
        first = _password_hash('correct horse battery staple')
        second = _password_hash('correct horse battery staple')
        self.assertNotEqual(first, second)
        self.assertTrue(_password_matches('correct horse battery staple', first))
        self.assertFalse(_password_matches('wrong password', first))


if __name__ == '__main__':
    unittest.main()

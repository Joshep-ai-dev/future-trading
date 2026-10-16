"""MySQL-backed users and opaque login sessions."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import base64
import hashlib
import hmac
import os
import secrets
from typing import Any
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass


SESSION_DAYS = 14
ROLES = ('viewer', 'trader', 'admin')


def _password_hash(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 600_000)
    return f'pbkdf2_sha256$600000${base64.urlsafe_b64encode(salt).decode()}${base64.urlsafe_b64encode(digest).decode()}'


def _password_matches(password: str, encoded: str) -> bool:
    try:
        algorithm, rounds, salt, expected = encoded.split('$', 3)
        if algorithm != 'pbkdf2_sha256':
            return False
        raw_salt = base64.urlsafe_b64decode(salt.encode())
        digest = hashlib.pbkdf2_hmac('sha256', password.encode(), raw_salt, int(rounds))
        return hmac.compare_digest(base64.urlsafe_b64encode(digest).decode(), expected)
    except (ValueError, TypeError):
        return False


class AuthStore:
    startup_error: str | None = None

    def configured(self) -> bool:
        return bool(os.getenv('MYSQL_DATABASE') and os.getenv('MYSQL_USER'))

    def _connect(self):
        if not self.configured():
            raise RuntimeError('MySQL is not configured. Set MYSQL_HOST, MYSQL_PORT, MYSQL_DATABASE, MYSQL_USER, and MYSQL_PASSWORD.')
        try:
            import mysql.connector
        except ImportError as error:
            raise RuntimeError('MySQL support is missing. Install requirements.txt and restart the backend.') from error
        return mysql.connector.connect(
            host=os.getenv('MYSQL_HOST', '127.0.0.1'),
            port=int(os.getenv('MYSQL_PORT', '3306')),
            database=os.environ['MYSQL_DATABASE'],
            user=os.environ['MYSQL_USER'],
            password=os.getenv('MYSQL_PASSWORD', ''),
            autocommit=True,
        )

    def initialize(self) -> None:
        if not self.configured():
            return
        try:
            with self._connect() as connection:
                cursor = connection.cursor()
                cursor.execute('''CREATE TABLE IF NOT EXISTS users (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(254) NOT NULL UNIQUE,
                display_name VARCHAR(80) NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                role ENUM('viewer','trader','admin') NOT NULL DEFAULT 'trader',
                active BOOLEAN NOT NULL DEFAULT TRUE,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB''')
                cursor.execute('''CREATE TABLE IF NOT EXISTS user_sessions (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                user_id BIGINT UNSIGNED NOT NULL,
                token_hash CHAR(64) NOT NULL UNIQUE,
                expires_at DATETIME NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT fk_session_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_session_expiry (expires_at)
            ) ENGINE=InnoDB''')
                cursor.close()
            self.startup_error = None
        except Exception:
            self.startup_error = 'MySQL rejected the connection. Check that the database user exists and its password matches .env.'

    def available(self) -> bool:
        return self.configured() and self.startup_error is None

    @staticmethod
    def public_user(row: dict[str, Any]) -> dict[str, Any]:
        return {'id': row['id'], 'email': row['email'], 'displayName': row['display_name'], 'level': row['role']}

    def sign_up(self, email: str, display_name: str, password: str) -> tuple[dict[str, Any], str]:
        email = email.strip().lower()
        with self._connect() as connection:
            cursor = connection.cursor(dictionary=True)
            cursor.execute('SELECT COUNT(*) AS total FROM users')
            role = 'admin' if cursor.fetchone()['total'] == 0 else 'trader'
            try:
                cursor.execute('INSERT INTO users (email,display_name,password_hash,role) VALUES (%s,%s,%s,%s)',
                               (email, display_name.strip(), _password_hash(password), role))
            except Exception as error:
                if getattr(error, 'errno', None) == 1062:
                    raise ValueError('An account already uses this email address.') from error
                raise
            user = {'id': cursor.lastrowid, 'email': email, 'display_name': display_name.strip(), 'role': role}
            token = self._create_session(cursor, user['id'])
            cursor.close()
            return self.public_user(user), token

    def sign_in(self, email: str, password: str) -> tuple[dict[str, Any], str]:
        with self._connect() as connection:
            cursor = connection.cursor(dictionary=True)
            cursor.execute('SELECT id,email,display_name,password_hash,role,active FROM users WHERE email=%s', (email.strip().lower(),))
            user = cursor.fetchone()
            if not user or not user['active'] or not _password_matches(password, user['password_hash']):
                raise ValueError('Incorrect email or password.')
            token = self._create_session(cursor, user['id'])
            cursor.close()
            return self.public_user(user), token

    def _create_session(self, cursor, user_id: int) -> str:
        token = secrets.token_urlsafe(48)
        expires = datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(days=SESSION_DAYS)
        cursor.execute('DELETE FROM user_sessions WHERE expires_at <= UTC_TIMESTAMP()')
        cursor.execute('INSERT INTO user_sessions (user_id,token_hash,expires_at) VALUES (%s,%s,%s)',
                       (user_id, hashlib.sha256(token.encode()).hexdigest(), expires))
        return token

    def user_for_token(self, token: str | None) -> dict[str, Any] | None:
        if not token or not self.configured():
            return None
        with self._connect() as connection:
            cursor = connection.cursor(dictionary=True)
            cursor.execute('''SELECT u.id,u.email,u.display_name,u.role FROM user_sessions s
                JOIN users u ON u.id=s.user_id
                WHERE s.token_hash=%s AND s.expires_at>UTC_TIMESTAMP() AND u.active=TRUE''',
                           (hashlib.sha256(token.encode()).hexdigest(),))
            user = cursor.fetchone()
            cursor.close()
            return self.public_user(user) if user else None

    def sign_out(self, token: str | None) -> None:
        if not token or not self.configured():
            return
        with self._connect() as connection:
            cursor = connection.cursor()
            cursor.execute('DELETE FROM user_sessions WHERE token_hash=%s', (hashlib.sha256(token.encode()).hexdigest(),))
            cursor.close()

    def list_users(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            cursor = connection.cursor(dictionary=True)
            cursor.execute('SELECT id,email,display_name,role FROM users WHERE active=TRUE ORDER BY created_at,id')
            users = [self.public_user(row) for row in cursor.fetchall()]
            cursor.close()
            return users

    def set_level(self, user_id: int, level: str) -> dict[str, Any]:
        if level not in ROLES:
            raise ValueError('Unknown account level.')
        with self._connect() as connection:
            cursor = connection.cursor(dictionary=True)
            cursor.execute('UPDATE users SET role=%s WHERE id=%s AND active=TRUE', (level, user_id))
            cursor.execute('SELECT id,email,display_name,role FROM users WHERE id=%s AND active=TRUE', (user_id,))
            user = cursor.fetchone()
            cursor.close()
            if not user:
                raise ValueError('Account not found.')
            return self.public_user(user)


auth_store = AuthStore()

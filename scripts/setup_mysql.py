"""Create the application's MySQL database and align its login with .env."""
from getpass import getpass
import os
import re

from dotenv import load_dotenv
import mysql.connector


load_dotenv()
database = os.getenv('MYSQL_DATABASE', 'silver_terminal')
app_user = os.getenv('MYSQL_USER', 'silver_app')
app_password = os.getenv('MYSQL_PASSWORD', '')
host = os.getenv('MYSQL_HOST', '127.0.0.1')
port = int(os.getenv('MYSQL_PORT', '3306'))
if not re.fullmatch(r'[A-Za-z0-9_]+', database) or not re.fullmatch(r'[A-Za-z0-9_]+', app_user):
    raise SystemExit('MYSQL_DATABASE and MYSQL_USER may contain only letters, numbers, and underscores.')
if not app_password:
    raise SystemExit('Set MYSQL_PASSWORD in .env first.')

admin_user = input('MySQL administrator [root]: ').strip() or 'root'
admin_password = getpass('MySQL administrator password: ')
connection = mysql.connector.connect(host=host, port=port, user=admin_user, password=admin_password, autocommit=True)
with connection:
    cursor = connection.cursor()
    cursor.execute(f'CREATE DATABASE IF NOT EXISTS `{database}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci')
    cursor.execute(f"CREATE USER IF NOT EXISTS '{app_user}'@'localhost' IDENTIFIED BY %s", (app_password,))
    cursor.execute(f"ALTER USER '{app_user}'@'localhost' IDENTIFIED BY %s", (app_password,))
    cursor.execute(f"GRANT ALL PRIVILEGES ON `{database}`.* TO '{app_user}'@'localhost'")
    cursor.execute('FLUSH PRIVILEGES')
    cursor.close()
print(f'MySQL database {database} and user {app_user} are ready. Restart npm run dev:lan.')

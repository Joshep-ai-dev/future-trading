"""Bootstrap a dedicated application login from the current XAMPP admin login."""
from pathlib import Path
import re
import secrets

from dotenv import dotenv_values
import mysql.connector


env_path = Path(__file__).resolve().parents[1] / '.env'
config = dotenv_values(env_path)
host = config.get('MYSQL_HOST') or '127.0.0.1'
port = int(config.get('MYSQL_PORT') or '3306')
database = config.get('MYSQL_DATABASE') or 'silver_terminal'
admin_user = config.get('MYSQL_USER') or 'root'
admin_password = config.get('MYSQL_PASSWORD') or ''
app_user = 'silver_app'
if not re.fullmatch(r'[A-Za-z0-9_]+', database):
    raise SystemExit('MYSQL_DATABASE may contain only letters, numbers, and underscores.')

app_password = secrets.token_urlsafe(32)
connection = mysql.connector.connect(host=host, port=port, user=admin_user,
                                     password=admin_password, autocommit=True)
with connection:
    cursor = connection.cursor()
    cursor.execute(f'CREATE DATABASE IF NOT EXISTS `{database}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci')
    cursor.execute(f"CREATE USER IF NOT EXISTS '{app_user}'@'localhost' IDENTIFIED BY %s", (app_password,))
    cursor.execute(f"ALTER USER '{app_user}'@'localhost' IDENTIFIED BY %s", (app_password,))
    cursor.execute(f"GRANT ALL PRIVILEGES ON `{database}`.* TO '{app_user}'@'localhost'")
    cursor.execute('FLUSH PRIVILEGES')
    cursor.close()

lines = env_path.read_text(encoding='utf-8').splitlines()
updates = {'MYSQL_USER': app_user, 'MYSQL_PASSWORD': app_password}
seen: set[str] = set()
output: list[str] = []
for line in lines:
    key = line.split('=', 1)[0].strip() if '=' in line and not line.lstrip().startswith('#') else ''
    if key in updates:
        output.append(f'{key}={updates[key]}')
        seen.add(key)
    else:
        output.append(line)
for key, value in updates.items():
    if key not in seen:
        output.append(f'{key}={value}')
env_path.write_text('\n'.join(output) + '\n', encoding='utf-8')
print(f'Created {database}, configured {app_user}, and updated .env. The generated password was not displayed.')

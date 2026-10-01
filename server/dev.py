"""Stop the development server when its launcher's heartbeat disappears."""
import sys
import threading
import time
from pathlib import Path

import uvicorn


def main():
    heartbeat = Path(sys.argv[1])
    server = uvicorn.Server(uvicorn.Config(
        'server.app:app', host='127.0.0.1', port=3001,
        timeout_graceful_shutdown=5,
    ))

    def watch_launcher():
        last_modified = None
        last_change = time.monotonic()
        while True:
            try:
                modified = heartbeat.stat().st_mtime_ns
            except FileNotFoundError:
                break
            if modified != last_modified:
                last_modified, last_change = modified, time.monotonic()
            if time.monotonic() - last_change > 5:
                break
            time.sleep(.25)
        server.should_exit = True
        heartbeat.unlink(missing_ok=True)

    threading.Thread(target=watch_launcher, daemon=True).start()
    server.run()


if __name__ == '__main__':
    main()

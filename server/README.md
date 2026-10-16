# Backend architecture

- `app.py`: FastAPI composition, request validation, authentication, and HTTP routes.
- `dev.py`: development process lifecycle.
- `market/`: historical market data, refresh, aggregation, and forming candles.
- `strategies/`: strategy configuration, indicators, backtest adapter, and parameter search.
- `exchanges/`: exchange adapters, account normalization, live automation, and streaming.
- `paper/`: simulation session lifecycle and execution.
- `storage/`: MySQL authentication, encrypted credentials, and saved profiles.
- `core/`: shared serialization helpers.
- `tests/`: unittest suite, mirroring backend responsibilities.

Use absolute package imports. Runtime files remain under the repository `data/` and `.runtime/` directories; moving a module must not change those locations. Never return credentials or secrets through HTTP responses.

Existing entry points remain `server.app:app` and `python -m server.dev`. Run `.venv/Scripts/python.exe -m unittest discover -s server -t .` from the repository root.

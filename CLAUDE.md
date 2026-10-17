# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Silver Terminal: local XAG/USDT perpetual research, paper trading and optional live execution. Python FastAPI backend (`server/`) + React 19/TypeScript/Vite UI (`src/`) using `lightweight-charts`. Strategies: **BB Outer Band Reversal** (`bb_outer_reversal`, backtest/paper/live) and **ML Ensemble** (`ml_ensemble`, backtest/paper only). See `AGENTS.md` for style/commit rules and `README.md`, `server/README.md`, `src/README.md` for feature and module notes.

## Commands (Windows, run from repo root)

- First-time / full start: `start.cmd` (creates `.venv`, installs `requirements.txt`, `npm install`, then `npm run dev`).
- Dev: `npm run dev` — API on `127.0.0.1:3001` (via `scripts/backend.mjs` → `python -m server.dev`) and Vite on `127.0.0.1:5173`, which proxies `/api`. `npm run dev:lan` binds both to `0.0.0.0` (`SILVER_HOST`).
- The backend does **not** hot-reload; restart after Python changes. `backend.mjs` refuses to start if port 3001 is busy.
- Build/type-check UI: `npm run build` (`npm.cmd run build` from PowerShell). There is no linter/formatter; run `git diff --check`.
- All Python tests: `.venv/Scripts/python.exe -m unittest discover -s server -t .`
- One file: `.venv/Scripts/python.exe -m unittest server.tests.test_paper_trading`
- One test: `.venv/Scripts/python.exe -m unittest server.tests.test_paper_trading.<TestClass>.<test_method>`
- One-off market catch-up (backend stopped): `.venv/Scripts/python.exe -m server.market.market_refresh`

Note: some paths in the root `README.md` predate the package reorganization (e.g. `server/bb_outer_reversal.py` is now `server/strategies/bb_outer_reversal.py`). Use absolute `server.<pkg>.<module>` imports.

## Architecture

**One strategy engine, three consumers.** `server/strategies/bb_outer_reversal.py` (`Settings` dataclass, `calculate`, `run_backtest`) is a port of a Pine strategy and is the single source of trading logic. It is called by:
- `strategies/bb_reversal_adapter.py` — maps `BacktestRequest` (`strategies/strategy.py`, Pydantic, `extra='forbid'`, carries legacy fields for saved-session compatibility) into `Settings`, then shapes ledger/metrics/chart output for `POST /api/backtest`.
- `paper/paper_trading.py` — `PaperTrading`, a threaded virtual bot with Live and accelerated Replay modes. State goes through a session store (`paper/session_store.py`): MySQL per user in the app, a JSON file in tests. It re-runs the engine causally over closed execution candles; the forming-candle animation (`market/forming_candle.py`) is display-only and must never feed indicators or fills. Never submits exchange orders.
- `exchanges/live_exchange.py` — `LiveExchange`/`AutomaticLiveBot`, ccxt-based real execution (OKX, HTX, MEXC, Binance) and automation on completed candles. `exchange_stream.py` streams account/market updates; `htx_*` handle venue specifics.

Strategy setting changes therefore usually touch `Settings`, the adapter, the UI defaults (`src/features/strategy/strategyDefaults.ts`, `BBReversalSettings.tsx`) and the tests.

**Strategy registry.** `server/strategies/registry.py` maps a strategy id to a `StrategyRunner` (run, warmup bars, chart columns, readiness, report, `live_supported`). Backtests (`bb_reversal_adapter.run_strategy_backtest`), paper trading and the live-bot guard use it; add a strategy by implementing a runner. Engines must return `dict(bars, trades, open_position, cash)` with BB-compatible trade fields.

**ML Ensemble.** `server/strategies/ml/`: `features.py` (registered look-ahead-free indicator groups), `labels.py` (triple-barrier labels and MFE/MAE excursion targets), `exits.py` (per-block quantile exit models and Gaussian-mixture regimes; learned exits are the default), `models.py` (registry: LightGBM, XGBoost, sklearn boosting/forests/linear/MLP; optional libs detected at runtime), `walk_forward.py` (causal folds, trained-fold LRU cache keyed by the exact training window), `strategy.py` (`MLSettings`, signals with probability/edge/reward-to-cost filters). Trades execute through the shared `strategies/execution.py` engine. `/api/strategies` serves the feature/model catalog to the UI.

**Market data.** `market/data.py` (`load_bars`, `TIMEFRAMES`) merges the untouched source `data/OKX_XAG-USDT-SWAP_1m.csv` with `data/OKX_XAG-USDT-SWAP_1m_updates.csv`, which `market/market_refresh.py` (`refresh_service`) fills from public OKX candles at startup and hourly. Higher timeframes are aggregated from 1m. All market data and date boundaries are UTC; chart display time zone is a UI preference only.

**Per-user workspaces.** `core/workspaces.py` (`WorkspaceRegistry`) gives each signed-in user their own `PaperTrading`, `LiveExchange`, `AutomaticLiveBot` and `ExchangeStreams`; routes call `workspace(request)` and must never use shared instances. All paper sessions share one cached public minute feed. Running paper sessions are restored at startup.

**App composition.** `server/app.py` holds all routes and request models; the `lifespan` starts `auth_store`, `refresh_service` and `paper_service`. An HTTP middleware requires a session cookie (`silver_session`) for all `/api/*` except health/auth, and requires trader/admin level for mutating paths in `TRADER_PATHS` — add new trading/mutating routes there. `server/dev.py` runs uvicorn and exits when the launcher's `.runtime/backend-*` heartbeat file stops updating.

**Storage.** `storage/auth_store.py` uses MySQL configured via `.env` (see `.env.example`; tables auto-created; first user becomes Admin). Without MySQL the API returns 503. `storage/credential_store.py` encrypts saved exchange credentials with a Fernet key at `.runtime/credentials.key`; decrypted secrets must never be returned over HTTP. `user_data_store.py` keeps per-user saved setups, backtest runs (saved on every `/api/backtest`), paper session state (zlib-compressed, writes coalesced), archived sessions, paper trades and live bot events; on first start it migrates the old shared `data/paper_trading.json` and profiles SQLite to the first admin. MariaDB's default `max_allowed_packet` (1 MB) limits very long replay sessions. Runtime paths are resolved relative to the repo root, so moving modules must not change `data/` or `.runtime/` locations.

**Frontend.** `src/main.tsx` is the auth gate; `src/app/` composes the workspace (Trading terminal is the initial page, plus Bot settings, Results & trades, Account). Page logic lives in `src/features/*`; reusable chart code (shared by trading and research) in `src/shared/charts/`, HTTP client and exchange stream in `src/shared/api/`, domain types in `src/shared/types/types.ts`. Shared modules must not import feature pages. Exchange execution stays on the backend. Draft bot settings persist in browser localStorage.

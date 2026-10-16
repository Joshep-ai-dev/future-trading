# Frontend architecture

- `app/`: workspace navigation, composition, and persistent layout.
- `features/auth/`: sign-in and registration.
- `features/account/`: account settings and exchange connection management.
- `features/trading/`: live and paper terminals, order tickets, bot controls, assets, and positions.
- `features/research/`: backtest results workspace.
- `features/strategy/`: strategy configuration and defaults.
- `shared/charts/`: chart rendering, indicators, viewport, volume, and history helpers.
- `shared/ui/`: reusable controls, trade tables, and market status.
- `shared/api/`: HTTP client, exchange stream, venue selection, and exchange types.
- `shared/types/`: common domain contracts.
- `styles/`: shared visual rules; `style.css` defines their import order.
- `main.tsx`: React bootstrap and authentication gate.

Keep page composition in features. Shared modules should expose reusable behavior; avoid importing page components into helpers. Exchange execution stays on the backend. Chart settings and viewport helpers are shared by trading and research.

Run `npm.cmd run build` and `git diff --check` after frontend changes.

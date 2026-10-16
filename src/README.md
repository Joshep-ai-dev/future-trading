# Frontend structure

The workspace uses a dark exchange layout with shared controls across Trading,
Backtest, Bot settings, and Account.

## Page composition

- `main.tsx` owns navigation, account mode, and the available history range.
- `components/AppHeader.tsx` renders the persistent workspace navigation.
- `BacktestPanel.tsx` owns strategy settings, saved setups, and research results.
  Account, configuration, paper trading, and results load through React lazy
  boundaries. Settings remain in the parent when a page is unmounted.
- `LiveTrading.tsx` composes live market, chart, account activity, and execution.
- `PaperTrading.tsx` contains only simulation UI and its session lifecycle.
- `ExchangeOverview.tsx` owns account tabs and the close-position interaction.
  `components/ExchangeTables.tsx` renders the account tables.
- Account settings show API connection management and display preferences only.
  Market data, positions, and order actions belong in the trading terminal.
- `components/ManualOrderTicket.tsx` provides market Open/Close controls;
  `orderSizing.ts` converts the entered USDT order value or XAG quantity.
  Protective stops and explicit live-order confirmation remain required.
- `components/LiveAssets.tsx` displays reported margin balances and XAG PnL.
- `components/LiveBotPanel.tsx` uses available exchange margin for sizing;
  simulation capital stays in Backtest/Paper settings. The backend validates
  available margin again before starting and before each live entry.
- `components/ExchangeConnections.tsx` owns API forms and connection actions.
  Account uses a settings sidebar with Connections and Preferences sections.
- `components/StrategyNavigation.tsx` owns strategy section navigation.
- `strategyDefaults.ts` provides configuration defaults without importing a UI page.

## Reusable UI

Use `components/ui.tsx` for `Button`, `PageHeader`, `Panel`, `Metric`,
`StatusBadge`, `TabBar`, `EmptyState`, `TableFrame`, and `NumberField`.
`TabBar` provides arrow-key navigation, focus management, and tab semantics.
Give each tab bar a unique `idPrefix` and connect its tabs to panel IDs.

Keep exchange calls and trading decisions outside these display components.
Preserve confirmation and backend verification when composing live actions.

## Styling

`style.css` is an import manifest. Import order is intentional:

1. `styles/tokens.css`: colors, spacing, radius, and typography defaults.
2. `styles/base.css`: browser resets and terminal primitives.
3. `styles/research.css`: strategy analysis and backtest layouts.
4. `styles/workspace.css`: execution controls, indicators, and trade views.
5. `styles/charts.css`: chart tool layout.
6. `styles/exchange.css`: live market and account composition.
7. `styles/components.css`: reusable UI controls.
8. `styles/theme.css`: workspace layout, page composition, and breakpoints.
9. `styles/order-ticket.css`: manual execution and asset-sidebar composition.
10. `styles/account-settings.css`: connection management and live bot composition.

Use tokens instead of introducing a new color or spacing scale. Update a shared
component's styles once instead of adding separate page-specific copies.

## Live data

`useExchangeStream.ts` shares one EventSource connection per venue across mounted
components. The backend shares exchange WebSocket feeds and handles reconnects,
account reconciliation, and credential-safe errors. The order book and depth
subscription are intentionally absent.

Disconnect stops the selected venue's local bot, waits for in-flight work, and
releases local clients and streams. Exchange positions/orders/stops and saved
credentials remain intact. Remove saved keys is a separate explicit action.

Keep failed queries distinct from an empty account. Display exchange timestamps
and connection status; never synthesize a successful balance or position query.

## Validation

Run `npm.cmd run build` and `git diff --check`. Review desktop and narrow layouts
when changing a shared control or page composition. Backend stream tests live in
`server/test_exchange_stream.py`.

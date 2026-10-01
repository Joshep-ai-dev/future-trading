# Silver / Price research

Local historical price dashboard using `data/OKX_XAG-USDT-SWAP_1m.csv`. No exchange calls or orders.

## Start

Windows: run `start.cmd` or `start.ps1`, then open http://localhost:5173. Stop with Ctrl+C before starting another copy. Startup rejects occupied ports rather than silently connecting a new UI to an old backend. The backend shuts down when its launcher exits, including across WSL/Windows. Restart after Python code changes; frontend changes reload automatically.

Linux/macOS:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm install
npm run dev
```

WSL can also use an existing Windows `.venv/Scripts/python.exe`. Do not run Windows and Linux copies simultaneously.

## Data and charts

Select 1m, 3m, 5m, 10m, 15m, 30m, 1h, 4h, or UTC 1d bars and click **Load prices**. The chart starts with the latest 5,000 complete bars and 168 initially visible. Pan to the left edge to automatically load earlier candles in batches of 5,000, preserving the current viewport. **Load earlier** fetches another batch manually; **Latest** returns to the newest bars. The history counter indicates when the beginning of the CSV is reached. UTC OHLC hover remains available.

The loader validates timestamps and OHLCV values, preserves gaps, and excludes incomplete bars. Source CSV and existing model data are left untouched.

`POST /api/analyze` accepts `{"timeframe":"1m"}` and returns candles, data quality and a history cursor. `POST /api/candles` accepts `timeframe`, an optional exclusive `before` UNIX-seconds cursor, and `limit` (1–5,000); it returns ordered candles, `hasMore` and `nextBefore`. `GET /api/health` identifies the backend as `silver-price`, version 3.

## Tabbed workspace and chart controls

- **Price chart**: timeframe selection, candles, and older-history loading.
- **Strategy settings**: dates, sessions, execution costs, and strategy rules.
- **Results & equity**: performance summary and account balance graph.
- **Trade positions**: entries/exits, stop/target zones, and the trade ledger.

Tabs keep settings, results, selected trades, loaded history, and chart zoom in memory while switching; switching tabs does not rerun the backtest. Use arrow keys or Home/End to navigate tabs with the keyboard.

Every chart has **Time + / −**, **Price + / −** (or **Amount + / −** on equity), and **Fit / reset**. Mouse wheel or pinch zooms time; drag the chart to pan, or drag an axis to scale it. Fit resets the amount/price axis to automatic scaling and shows the loaded history. Drag the lower-right corner of a chart to adjust its height. The equity graph initially fits the full selected period, and zoom persists when changing tabs.

## Checks

```sh
python -m unittest server.test_data server.test_strategy server.test_mtf server.test_history -v
npm run build
```

## Multi-timeframe EMA + RSI strategy

In **Strategy settings**, select **Multi-timeframe EMA + RSI** (the new UI default). The original **Structure / liquidity sweep** strategy remains separately selectable.

| Stage | Default | Options | Confirmation |
|---|---|---|---|
| Direction | Active, 1H | 15M, 30M, 1H, 4H | EMA20 above EMA50 for long; below for short |
| Setup | Active, 15M | 5M, 15M, 30M, 1H | EMA alignment plus RSI20 above 50 for long; below 50 for short |
| Entry | Active, 5M | 1M, 3M, 5M, 15M | Fresh EMA alignment plus RSI20 above/below 50 |

Each stage has an independent **Active / Disabled** switch. Disabled stages retain their selected timeframe but are excluded from calculations and confirmations. Every active stage must agree. The execution timeframe is Entry when active, otherwise Setup, otherwise Direction. If all three are disabled, the form and API require a stage to be activated before running.

**Entry signal:** on the execution timeframe, the combined EMA/RSI condition must first become true, having previously been neutral or opposite. If only Direction is active, its EMA-only alignment supplies that fresh signal. Higher-stage confirmations must already agree at that close; a later filter change alone does not create a new entry while the execution signal remains unchanged.

Use only completed candles. An unfinished hourly candle cannot confirm a 5-minute signal. Candles that close at the same instant may confirm each other. EMA20/50 are seeded with the first 20/50 closes' simple average, then updated with `2/(period+1)`. RSI20 uses Wilder smoothing, seeded with the first 20 price changes; a flat market has RSI 50. Warmup restarts after gaps. Each active stage needs at least 50 completed candles.

Confirmed signals enter at the **next execution candle's open**, plus the configured adverse spread/slippage. A long stop uses the signal candle's low; a short stop uses its high. Target is 2× actual entry-to-stop distance. Entries opening beyond the stop are skipped. This strategy has no sweep or swing-resistance filter. It retains the existing 0.5% risk budget, notional cap, costs/funding, two-trade/two-loss session limits and independent research/validation balances. Only execution candles fully contained in the selected session are tradable; a 4H candle crossing a session boundary is excluded from execution, and positions close at the prior usable candle's close. Drawdown is measured on the selected execution timeframe's closing equity.

The position chart follows the effective execution timeframe and displays EMA20/50, an RSI20 pane with its 50 reference, signals, entries/exits, and stop/target zones. Selecting a trade shows each active stage's indicator values and the completed candle timestamp used for confirmation. Exports include these snapshots, the exact switch settings, `executionTimeframe`, `barSeconds`, and indicator series.

API example (omitting `strategy` retains the legacy sweep API behavior):

```json
{
  "strategy": "mtf",
  "start_date": "2026-03-26",
  "validation_date": "2026-08-02",
  "end_date": "2026-09-27",
  "direction_active": true, "direction_timeframe": "1h",
  "setup_active": true, "setup_timeframe": "15m",
  "entry_active": true, "entry_timeframe": "5m"
}
```

The initial default run is recorded in [reports/mtf-backtest-summary.md](reports/mtf-backtest-summary.md). Tick size, fees, spread, slippage and funding remain editable modeled assumptions, not verified historical execution costs.

## Sweep strategy backtest

The dashboard runs a **15-minute market structure / 5-minute liquidity sweep** hypothesis. The price viewer also supports **5m and 10m**. Its timeframe selector does not change the strategy's fixed timeframes.

- Confirm a swing high only when its high is strictly above the two candles on either side; reverse for lows. Use it only after the second following 15m candle closes.
- Long direction requires the last two confirmed highs and lows both rising. Short direction requires both falling; otherwise stay flat.
- A long setup trades below the lowest low of the previous six completed 5m candles and closes above that level. Reverse for shorts.
- Submit a stop order one tick beyond the sweep candle's high/low, starting on the next candle. It expires after three candles. Stop is one tick beyond the other extreme; target is twice actual entry-to-stop distance.
- Skip when the nearest opposing, confirmed 15m swing level leaves less than 2R. Keep levels until a completed 15m candle closes through them; recheck the captured level on a gap entry.
- Risk budget is 0.5% of current account equity, including estimated stop fill costs and fees. The editable notional/equity cap can reduce actual risk. One position/pending order at a time, maximum two fills per session, stop after two net losses. Session/period boundaries close positions and cancel orders.

The initial run splits the available calendar history 70%/30% into **Research** and **Validation**. Both use identical settings and each starts with its own account balance. Earlier bars warm up indicators without carrying trades or equity across the split. The dashboard reports separately whether each period has at least 100 trades. Repeated tuning against validation would make it no longer a fresh holdout.

### Execution assumptions

Defaults are illustrative and editable: 2,000 USDT capital, 00:00–24:00 UTC sessions, 0.01 tick, 5 bps fee on each fill, 0.01 full spread, 0.01 slippage per fill, 1× notional cap, and +1 bp funding at UTC 00:00/08:00/16:00 for positions already open. Positive funding charges longs and credits shorts. These are **not verified exchange specifications or historical cost observations**; the CSV has no historical funding, bid/ask spread or order book.

Spread/2 plus slippage is adverse on every entry and exit, including targets. Gap entries use the worse of trigger/open; gap stops use the worse of stop/open. If OHLC cannot resolve stop/target ordering, stop comes first. A stop touched anywhere on the entry candle is assumed to occur after entry, without using a pre-entry opening gap as a stop fill. Actual fills can differ. Missing bars cancel orders and flatten positions at the last known close. Trade times identify the containing candle, not exact intrabar times.

Sizing uses continuous silver-equivalent units, not exchange contract lot rounding. Liquidation is not simulated. Funding and gaps can make realized risk exceed the budget. R values divide net P&L by the account's 0.5% risk budget; leverage-capped positions may have smaller planned risk. Drawdown uses 5m closing equity marked to modeled liquidation prices, not intrabar extremes. Profit factor is unavailable when there are no losing trades.

### Results and position charts

Open **Strategy settings** and use **Run backtest** to refresh after editing dates, session or cost assumptions. A completed manual run opens **Results & equity**. Switch between Research and Validation to inspect net return, equity, win rate, drawdown, profit factor, fees, funding, and spread/slippage cost. Select a trade in the ledger or click an entry/exit candle to focus the position: sweep marker, buy/sell arrow, exit marker, entry line, shaded stop zone and shaded 2R target zone. The **Trade positions** chart contains all candles in the selected research or validation period. Selecting a trade focuses its surrounding candles without removing earlier or later history; keep dragging or zooming to explore beyond the selected trade. **Export result JSON** includes settings, all trades, equity and 5m candles.

Initial local-data results and assumptions are saved in [reports/sweep-backtest-summary.md](reports/sweep-backtest-summary.md), with a CSV trade ledger. The tested strategy lost money under these assumptions; this is a testable hypothesis, not evidence of an edge.

`POST /api/backtest` accepts the date range, validation date and settings defined in `server/strategy.py`. Example:

```json
{"start_date":"2026-03-26","validation_date":"2026-08-02","end_date":"2026-09-27","capital":2000}
```

Run the execution tests with:

```sh
python -m unittest server.test_data server.test_strategy server.test_mtf server.test_history -v
npm run build
```

Support/resistance background: [CME Group](https://www.cmegroup.com/education/courses/trading-and-analysis/support-and-resistance.html). Sweeps in candle data do not prove the location of order clusters.

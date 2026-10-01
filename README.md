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
python -m unittest server.test_data server.test_strategy server.test_mtf server.test_history server.test_exits server.test_indicator_settings server.test_atr -v
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

Confirmed signals enter at the **next execution candle's open**, plus the configured adverse spread/slippage. There is no profit target. An optional ATR stop loss can be activated alongside EMA reversal exits. Longs close when EMA20 crosses below EMA50; shorts close on the reverse crossover, using a completed execution candle and filling at the next open. RSI remains an entry filter only. The signal candle low/high is retained only as a sizing reference; 0.5% is not a maximum loss. Session, period and data-gap exits still apply. This strategy has no sweep or swing-resistance filter. It retains the existing 0.5% sizing reference, notional cap, costs/funding, independent research/validation balances, with no daily trade-count or loss-count limit. Multiple positions may overlap: each fresh qualifying signal can open another trade. The notional/equity cap applies to total open exposure, and equity includes all open positions. Each position retains its own fees, funding, and exit record. A persistent signal does not add a trade on every candle. Only execution candles fully contained in the selected session are tradable; a 4H candle crossing a session boundary is excluded from execution, and positions close at the prior usable candle's close. Drawdown is measured on the selected execution timeframe's closing equity.

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

## Indicator controls and weekdays

In **Strategy settings → Indicator settings**, edit the fast EMA period (default 20), slow EMA period (50), RSI period (20), and RSI threshold (50). These values apply across all active timeframes and indicator exits. Fast EMA must be shorter than slow EMA. The EMA + RSI **RSI Active / Disabled** switch controls the Setup and Entry RSI filter; Direction remains EMA-only. Disabled RSI does not block entry or require RSI warmup, and its chart pane is hidden. EMA reversal remains the only indicator exit for this strategy.

Both strategies exclude Saturday and Sunday according to the selected **session timezone**. Positions close at the last usable candle before the weekend, and pending orders cannot fill over the weekend. This is a weekday filter, not an exchange holiday calendar. Existing historical reports predate this filter and should be rerun.

API fields: `ema_fast`, `ema_slow`, `rsi_period`, `rsi_threshold`, `rsi_active`. Chart labels and confirmation values use the chosen settings. Exported `ema20`, `ema50`, and `rsi20` field names are retained for compatibility; they contain the configured fast EMA, slow EMA and RSI values, with periods recorded in `settings`.

## Optional ATR stop for EMA + RSI

In Strategy settings, turn **ATR Active** on to combine an ATR stop with EMA-reversal exits. Defaults are ATR period **14**, multiplier **2**, initially disabled. Long stop = actual entry price − ATR × multiplier; short stop = entry + ATR × multiplier. Each overlapping position gets its own fixed stop, shown on its chart, and keeps its EMA-reversal exit. No profit target is added.

ATR uses the completed execution-timeframe signal candle, seeds from the average of the first period true ranges, then uses Wilder smoothing. True range includes gaps from the previous close; missing candles reset warmup. Signals without a positive warmed-up ATR are skipped. Stops are active on the entry candle; gap-through stops fill at the adverse opening price plus modeled costs. EMA exits still fill at the next open; a stop already breached at that open takes precedence. ATR distance is used in position sizing when enabled. Session, weekend and data-gap rules remain in force.

API: `atr_active`, `atr_period`, `atr_multiplier`. Trade exports include the signal `atr`, `atrDistance`, and stop levels. Disabled ATR preserves EMA-only behavior.

## Close conditions and stop management

EMA + RSI uses EMA reversal exits with an optional fixed ATR stop and no profit target. The API normalizes its settings to `exit_condition: ema` and `stop_mode: none`. Earlier MTF reports describe the old stop/target rules and must be rerun for this version.

The sweep strategy exposes **Close conditions & stop loss** in Strategy settings. Its defaults remain **Stop / target only** and **Fixed initial stop**.

- **EMA reversal:** exit a long when EMA20 crosses below EMA50; reverse for shorts.
- **RSI cross:** exit a long when RSI20 crosses below 50; reverse for shorts.
- **Either:** close when either selected indicator crosses against the position.
- **Breakeven after +1R:** move the stop to the entry price after price reaches the original entry-to-stop distance in profit.
- **Trailing:** move a long stop one tick below the last completed candle’s low, or a short stop one tick above its high.
- **Breakeven + trailing:** apply whichever gives the tighter stop. Stops never loosen. Position size, original risk and the 2R target stay unchanged.

Conditions use the execution timeframe: 5M for sweep, or the effective active timeframe for EMA + RSI. A completed candle’s close signal fills at the next open; stop adjustments also take effect on the next candle. Existing stop/target fills take precedence during the signal candle, and protective stop/target gaps take precedence at the next open. Session, period and data-gap exits still apply. Breakeven means entry price before costs, so net P&L can still be negative.

Results show counts by exit reason. Select a position to see its initial/final stop, stop-adjustment history and indicator close signal. The chart displays the moving stop and close-signal marker; the shaded risk zone retains the original stop. JSON exports include `initialStop`, `finalStop`, `initialRisk`, `stopHistory` and, where applicable, `exitSignal`.

API settings: `exit_condition` is `none`, `ema`, `rsi` or `either`; `stop_mode` is `fixed`, `breakeven`, `trailing` or `breakeven_trailing`. These selectable modes apply to sweep; EMA + RSI always uses `ema` and `none`.

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
python -m unittest server.test_data server.test_strategy server.test_mtf server.test_history server.test_exits server.test_indicator_settings server.test_atr -v
npm run build
```

Support/resistance background: [CME Group](https://www.cmegroup.com/education/courses/trading-and-analysis/support-and-resistance.html). Sweeps in candle data do not prove the location of order clusters.

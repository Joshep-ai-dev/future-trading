# BB Outer Band Reversal + Trailing SL

Local OKX XAG-USDT-SWAP research and virtual trading. This is the only active strategy. No exchange orders are submitted.

## Start

On Windows, run `start.cmd` or `start.ps1`, then open http://localhost:5173. Stop with Ctrl+C before restarting. Restart after backend code changes. Alternatively, install requirements in a Python virtual environment, run `npm install`, then `npm run dev`.

## Workspace

- **Strategy settings:** BB reversal parameters, virtual balance, trade allocation, leverage, timeframe and historical dates.
- **Results & trades:** research/validation summaries, equity, position chart, stop adjustments and trade ledger together. Selecting a trade focuses its position. Export the full result as JSON.
- **Paper trading:** virtual bot with Live and Backtest replay modes, moving price chart, equity, open position and trade ledger. This is the initial page.

There is no separate Price chart page or strategy selector. The active backtest and paper APIs accept only `bb_outer_reversal`. Unused strategy implementations, components and their legacy tests/reports have been removed.

## Strategy and sizing

A lower/upper Bollinger touch arms one rebound opportunity. The first qualifying bullish/bearish inside-band candle consumes it even if a filter blocks entry. ATR, minimum BB width and strict ADX threshold filter entries. Filled trades alternate long and short. Both directions are always enabled.

Execution timeframe defaults to 5m; choices are 1m, 3m, 5m, 10m, 15m, 30m, 1h, 4h and 1d. Leverage is selectable from 1x to 100x. Amount per trade is a dollar allocation or a percentage of current balance (up to 100%). Position notional is allocation times leverage. Dollar allocation is capped at available balance after losses. No new trades open at zero or negative balance, including after a reversal close.

**Use SMA Trend Adjustment** defaults on: selected SMA length and slope lookback identify countertrend trades and reduce their stop/trailing distances. Off hides SMA controls and the chart line, skips SMA warmup, and uses normal exit distances.

Entries fill at completed candle closes. Existing stops use OHLC with adverse gap-open fills. Trailing activation and distances use absolute price units and the trailing multiplier; stops never loosen. A newly tightened stop already crossed at close fills at close. Missing data forces a last-known-close exit and indicator warmup resets. Each historical research/validation period starts independently and closes remaining trades at its end.

## Live and accelerated replay

Configure BB settings, open **Paper trading**, choose a mode, then **Start virtual bot**. Session settings are frozen. Pause before starting a new session; old sessions are archived in `data/`.

**Live** starts flat at the next full execution candle and follows real market time. The backend checks confirmed candles every 30 seconds. A separate public OKX minute-candle feed updates the forming price approximately every second. Network delays may reduce that rate. Pause freezes trading; Resume or backend restart catches up missed completed candles in order. Keep the backend running for updates.

**Backtest replay** uses UTC start/end dates (end inclusive) and a frozen snapshot of downloaded history. Replay speeds are 1x, 10x, 60x, 300x, 1800x, 3600x and 10000x. At 300x, five market minutes pass per real second. Speed is adjustable while running. Pause and backend downtime freeze the virtual clock. Replay ends at the selected date or the last downloaded candle and closes any remaining position. Depleted balance halts it sooner.

The chart combines 1-minute data into the selected timeframe's forming candle, including 5m from five minute candles. Historical animation uses a synthetic open -> nearest extreme -> other extreme -> close path at 0/20/40/60 seconds. This is not recorded tick data. The forming animation never feeds strategy indicators or changes fills: trading decisions use closed execution candles. Missing minutes do not produce fabricated candles.

The chart shows the latest 1,000 revealed candles with buy/sell/exit markers, Bollinger bands, optional SMA, open entry and active stop. **Follow bot clock** scrolls to the latest price; disable it to inspect earlier visible candles. Current displayed equity follows the displayed price; equity history records completed candle closes. Session state and trades are saved atomically to `data/paper_trading.json` and restored across restarts without duplicating trades.

All execution is virtual and candle-based. Fees, spread, slippage, funding, tick rounding and margin liquidation are not modeled.

## Market data

The original `data/OKX_XAG-USDT-SWAP_1m.csv` stays untouched. Startup catches up missing confirmed minute candles into `data/OKX_XAG-USDT-SWAP_1m_updates.csv`, then checks hourly. Live paper trading adds 30-second catch-ups. Downloads paginate back to the local boundary, validate OHLCV, skip unfinished minutes and replace the cache atomically. No API key is required; internet access to `www.okx.com` is required.

Download status and **Download latest prices now** remain available above the workspace. Failures preserve prior data. One-off catch-up: `.venv/Scripts/python.exe -m server.market_refresh` with the backend stopped to avoid competing writers.

## APIs and checks

`GET /api/data-range`, `GET /api/market-status`, `POST /api/market-refresh`.

`POST /api/backtest` accepts `strategy: bb_outer_reversal` (also the default), start/validation/end dates, `entry_timeframe`, `capital`, `max_leverage`, and optional `bb_reversal` fields documented by `Settings` in `server/bb_outer_reversal.py`.

`GET /api/paper`, `POST /api/paper/start`, `POST /api/paper/pause`, `POST /api/paper/resume`. Start accepts BB settings plus `paper_mode: live|replay`. Replay also requires `replay_start`, `replay_end` and optional `replay_speed`. Historical backtest dates are ignored for paper start. Change replay speed with `POST /api/paper/speed` and `{"speed": 300}`.

```sh
python -m unittest discover -s server -t .
npm run build
```

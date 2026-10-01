# Multi-timeframe EMA + RSI: initial backtest

Direction **1H ON**, Setup **15M ON**, Entry **5M ON**. Every active stage must confirm; entries use a fresh EMA/RSI alignment, next-open execution, signal-candle stop, and 2R target. No settings were retuned after viewing these results.

Research: March 26–August 1, 2026. Validation: August 2–September 27, 2026. Each starts with a separate 2,000 USDT account.

| Metric | Research | Validation |
|---|---:|---:|
| Trades | 232 | 102 |
| Net return (%) | -33.9938 | -13.3162 |
| Ending balance (USDT) | 1320.1239 | 1733.6769 |
| Win rate (%) | 19.8276 | 21.5686 |
| Max closing-equity drawdown (%) | -33.9938 | -13.4315 |
| Profit factor | 0.2371 | 0.3482 |
| Average net R | -0.3571 | -0.2791 |
| Fees (USDT) | 368.6936 | 185.2750 |
| Net funding paid (USDT) | 0.0542 | 0.7286 |
| Spread and slippage (USDT) | 158.7632 | 85.2633 |

Both periods exceed 100 trades. Both lost money under these assumptions.

Session: 00:00–24:00 UTC. Risk budget: 0.5%, maximum two trades and two net losses per session, 1× notional cap. Modeled costs: fee 5 bps per fill, full spread 0.01, slippage 0.01 per fill, +1 bp funding at 00/08/16 UTC (longs pay, shorts receive). Stops take precedence when a bar touches both stop and target.

These are editable cost assumptions, not verified historical spread/funding or exchange specifications. Quantity uses continuous silver-equivalent units without contract lot rounding or liquidation modeling. Source: `data/OKX_XAG-USDT-SWAP_1m.csv`.

[Settings and metrics JSON](mtf-backtest-summary.json) · [Trade ledger with confirmation snapshots](mtf-trades.csv). Timestamps are UNIX seconds; confirmation times are candle closes and entry times are the next execution candle opens.

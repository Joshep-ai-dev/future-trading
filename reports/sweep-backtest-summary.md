# Silver sweep strategy: initial backtest

Local CSV: `data/OKX_XAG-USDT-SWAP_1m.csv`. 15m confirmed structure, 5m sweep entries. No rules were retuned after viewing these results.

Research: March 26–August 1, 2026. Validation: August 2–September 27, 2026. Dates are UTC. Each period independently starts with 2,000 USDT.

| Metric | Research | Validation |
|---|---:|---:|
| Trades | 196 | 84 |
| Net return (%) | -29.6377 | -13.7444 |
| Ending balance (USDT) | 1407.2452 | 1725.1118 |
| Win rate (%) | 25.0000 | 23.8095 |
| Max closing-equity drawdown (%) | -30.6271 | -14.0906 |
| Profit factor | 0.3497 | 0.3267 |
| Average net R | -0.3572 | -0.3507 |
| Fees (USDT) | 325.1910 | 153.7068 |
| Net funding paid; negative = credit (USDT) | -0.1284 | -0.2067 |
| Spread and slippage (USDT) | 140.3393 | 70.8806 |

Research reached 100 trades; validation had only 84, so it does not meet that sample target. Both periods lost money under the assumptions below.

## Assumptions

- Sessions: 00:00–24:00 UTC, maximum two entries and two net losses per session; flatten at session end.
- Risk budget: 0.5% including estimated stop costs; position notional capped at 1× equity.
- Tick 0.01; fee 5 bps per side; full spread 0.01; adverse slippage 0.01 on every fill.
- Fixed +1 bp funding at 00/08/16 UTC. Longs pay, shorts receive. This is a scenario, not historical funding.
- Conservative 5m OHLC execution: stop first when ordering is uncertain. Same-bar stops may predate entry in reality.
- Continuous silver-equivalent quantity, no contract rounding or liquidation simulation.
- Independent account resets at the validation split; no positions cross periods.

Costs and tick size are editable assumptions and were not verified as exchange specifications. The CSV cannot establish actual spread, funding, slippage, or order clusters. Real fills can differ. Repeated testing against the same validation period weakens its independence.

Machine-readable summary: [sweep-backtest-summary.json](sweep-backtest-summary.json). Trade ledger: [sweep-trades.csv](sweep-trades.csv). Times in CSV are UNIX seconds identifying the containing 5m candle.

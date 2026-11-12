# Adaptive Forecast validation and execution

The strategy remains the existing Extra Trees / sequence forecast strategy.
No Hybrid strategy or PPO directional model is introduced.

## Execution audit and risk

Forecast mode now observes completed candles and enters at the following open.
The prior decision is shifted before slicing the requested evaluation period;
missing-candle gaps block stale next-open entries. Other ML exit modes retain
their prior close-fill behavior.

Targets/stops are anchored to the actual entry fill, including adverse spread
and slippage. Stops win same-candle target/stop ties; opening gaps fill at the
actual open. Close-based exits use candle-end timestamps. Unknown intrabar
exit times conservatively use candle end for funding. Protective stops and
targets are checked before forecasts update them at the completed close.

Forecast positions close after the configured maximum holding time (zero means
the forecast horizon). A separate switch compares forecast-adjusted exits with
fixed entry targets/stops. Sizing is capped by allocation/leverage and a planned
loss budget including stop distance and estimated costs. Defaults: 0.5% planned
risk per trade, 3% UTC daily loss halt, 10% portfolio drawdown halt. Stops cannot
guarantee a maximum realized loss across market gaps. A loss halt stops the
current session/replay and does not silently reset the account the next day.

Each result reconciles gross P&L minus fees, execution costs and signed funding
against net trade P&L; starting cash plus closed net P&L minus costs of an open
position must reconcile to ending cash. Passing this audit verifies arithmetic,
not that OHLC simulation reproduces exchange latency or partial fills.

## Forecast benchmarks and entry quality

For each out-of-sample prediction, compare upward/downward excursion and trend
errors (ATR units) with a historical mean-range baseline and zero-change trend.
The historical baseline uses only outcome windows already completed when it
is calculated. Report aggregates may use completed evaluation outcomes; they
are never fed back as contemporaneous entry information.

An entry needs all three past-only checks:

1. Recent forecast mean absolute error beats the simple baseline.
2. Predicted trend movement exceeds the historical 90th-percentile absolute
   trend error plus execution cost. This is an empirical error band, not a
   guarantee of coverage or an exchange price confidence interval.
3. Non-overlapping historical proposals with the same side and tree-agreement
   bucket have at least 30 matured observations, win frequency above the quality
   threshold and positive mean net return after a dispersion buffer.

Proposal labels replay the same next-open fills, targets, protective stops,
forecast exit adjustments and holding limit, independently per unit. They do
not assume a future account balance or bypass portfolio loss limits. All
statistics are delayed by max(forecast horizon, holding limit)+1 candles.
Windows crossing missing candles and incomplete tail windows are excluded.
Only non-overlapping proposal windows contribute to the empirical quality fit.
This is an empirical calibration table, not an additional neural network.
These checks can abstain for long periods when evidence is insufficient.

Tree vote fractions remain directional agreement. The separately reported
`p_trade_win` is historical proposal win frequency and is not guaranteed future
win probability. The dispersion buffer is not a formal statistical confidence
bound under changing/dependent markets.

## Research workflow

Run `.venv/Scripts/python.exe scripts/validate_adaptive_execution.py` to compare
unguarded adaptive exits, guarded adaptive exits and guarded fixed exits on the
same local evaluation period and costs. All cases keep identical risk limits
and bounded holding times. No case is automatically selected from that report.

Walk-forward fold cache keys include feature/label/target content so corrected
market data cannot silently reuse stale models. Tuning rejects candidates that
hit hard loss limits even when their closed trades are profitable.

Run new evaluations after restarting the backend; previous result cards retain
their historical configuration. This implementation does not claim improved
forecast accuracy or positive out-of-sample profit. The benchmarks establish
whether additional modeling work is justified, rather than forcing entries.


## Calibration prefix and no-trade searches

Guarded forecast preparation now generates an out-of-sample calibration prefix
before the selected trading start. Its length is rounded to whole retraining
blocks so evaluation block boundaries remain anchored to the selected date.
Paper warmup requests include both model training and calibration history.
Only forecasts already available at their own decision times contribute;
proposal outcomes must fully mature before a later decision uses them.
Actual trades are still sliced to the selected evaluation dates.

Each tuning period carries its own forecast-entry diagnostics. Independent
failure counts can overlap; first-blocker counts are sequential and reconcile
to proposed entries minus eligible entries. Pre-period sample totals describe
historical availability; quality still requires 30 observations in the same
side/agreement bucket within the rolling training window. Aggregate historical
counts do not guarantee that any particular bucket has enough examples.

When no finalist passes trade-count, profit and loss-limit requirements, the
search reports `no_eligible_setup` and returns diagnostic cases with explicit
reliability reasons. Applying remains disabled; saving named parameters for
research remains available. Zero-trade win rate is unmeasured, not 0%.

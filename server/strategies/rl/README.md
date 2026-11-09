# PPO training and replay

The actions are target positions: flat, long and short. The policy sees only
closed candles and orders fill at the next open. The same simulator handles
training, historical evaluation and paper replay, including costs, funding,
protective stops, gaps and portfolio drawdown liquidation.

## Historical learning window

Each retraining window is split chronologically:

- First 80%: fit the feature normalizer and train PPO on varied contiguous episodes.
- Next 10%: compare checkpoints against cash using net return divided by drawdown.
- Last 10%: evaluate the chosen checkpoint once. It must pass independently;
  failure returns a cash policy, without trying other checkpoints on this period.

Both evaluation gates require positive net profit after costs, at least ten
closed trades, finite metrics and no drawdown halt. These are minimum eligibility
checks, not statistical proof of an edge. Small windows may produce no eligible
policy. Confirmation is past data relative to the next trading decision.

Observations include recent normalized market features and ten portfolio fields:
cash return, equity return, notional exposure, signed distance to the active stop,
position direction, unrealized return, holding age, current drawdown, ATR entry
eligibility and estimated round-trip execution cost. Normalization never fits on
selection, confirmation or subsequent trading bars.

Training uses separate policy/value networks, entropy regularization, a KL update
limit and rewards scaled by 100 for optimization. The unscaled reward is account
return minus incremental drawdown and turnover preference penalties. Preference
penalties do not change account P&L. Liquidated episode boundaries are terminal
for learning so PPO does not bootstrap a nonexistent continuing position.

## Outer evaluation

The user's selected range is divided into earlier, validation and forward periods.
Each period is an independent walk-forward replay, retraining only on bars already
available at each decision. This evaluates an adaptive training process, not one
frozen set of neural weights. Forward results do not affect checkpoint selection
or setup eligibility. Rejected policy counts/reasons explain zero-trade periods;
coverage counts distinguish early risk halts from full-period evaluation.

## Artifacts and interpretation

The model version, settings, execution costs, candles, features and ATR are hashed
into the artifact key. The v6 observation/training change invalidates older cache
keys without deleting old artifacts. Saved setups contain configuration parameters;
weights are separate historical-window artifacts. Run Train PPO again after a code
or parameter change; old result cards are not recomputed automatically.

Passing tests verifies simulator and selection behavior. It does not establish
profitability. Compare new runs on fixed dates and costs, retain unused future
periods, and report losses, rejected policies and zero-trade periods alongside wins.

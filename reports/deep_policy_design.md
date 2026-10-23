# Deep Policy Model: Design

A fee-aware deep-learning strategy for XAG/USDT perpetual trading.

- **Main loss:** profit after fees.
- **Second loss:** win rate.

Status: design only, nothing implemented yet.

## 1. Why

When the backtest fee is set to 0.06% per side, net profit drops from about $10,000 to about $2,500.

- **Round-trip cost.** 0.06% per side is 0.12% of the position value per trade. At 12x leverage that is about 1.4% of the margin on every trade.
- **Training ignores costs.** The current ML Ensemble trains on labels without costs. A move smaller than the fee still counts as a "win".
- **Costs only filter afterwards.** Fees and slippage are applied only after training, through `min_reward_cost`.
- **Result:** the models learn to chase small moves that lose money once fees are paid.

Goal: train with the cost in the objective, so the model trades less often but takes larger moves.

## 2. Workflow

```
1m OKX candles
   │
   ▼
1. Resample to the trading timeframe (1h suggested)
   │
   ▼
2. Features (server/strategies/ml/features.py, look-ahead free)
   returns · volatility · Bollinger · trend · oscillators · volume
   candles · calendar · higher timeframe · regime (Gaussian mixture)
   → robust scaling fitted on the training block only
   │
   ▼
3. Windows: the last L = 64 bars of F features  →  X: [L, F]
   │
   ▼
4. After-fee targets for each bar t (fee 0.06% per side + slippage)
   r_long  = (close[t+H] − close[t]) / close[t] − round_trip_cost
   r_short = −(close[t+H] − close[t]) / close[t] − round_trip_cost
   win_long = r_long > 0,  win_short = r_short > 0
   (or triple-barrier exits with costs included)
   │
   ▼
5. Walk-forward training: train 6,000 bars → predict the next 2,000 → slide forward
   inside each block: last 15% = early-stopping slice
   │
   ▼
6. Decision layer (no new training)
   position = model output, with weak signals set to 0 (dead zone)
   trade only if expected net return > k × cost
   │
   ▼
7. Shared execution engine (server/strategies/execution.py: stops, trailing, fees, funding)
   │
   ▼
8. Search ranks on train + validation (both out of sample)
   forward test reported only, never used to choose
```

## 3. Model shape

The input for one sample is `X` of shape `[64 bars × F features]`, with F ≈ 60–100.

```
Input [B, 64, F]
 │
 ├─ Linear F→64 + LayerNorm                          [B, 64, 64]
 ├─ 3 × temporal conv block (dilation 1, 2, 4)        [B, 64, 64]
 │     Conv1d(64, 64, k=3) → GELU → Dropout(0.2) → residual
 ├─ GRU(64 → 64), keep the last hidden state          [B, 64]
 ├─ concat [last-bar features, regime one-hot]        [B, 64+F+4]
 ├─ MLP 128 → 64, GELU, Dropout(0.3)                  [B, 64]
 │
 ├─ Head A – position:  Linear 64→1 → tanh            p ∈ [−1, 1]
 ├─ Head B – win chance: Linear 64→2 → sigmoid        P(win_long), P(win_short)
 └─ Head C – expected net return: Linear 64→2         E[r_long], E[r_short]
```

- **Size:** about 60–90k weights. It trains quickly on a GTX 1660 (CUDA).
- **Why it stays small:** 1h data gives only a few thousand samples per walk-forward block, so a bigger network would overfit.

## 4. Loss functions

```
pnl_t      = p_t · r_t  −  cost · |p_t − p_{t−1}|        # fee counted whenever the position changes

L_profit   = −mean(pnl) / (std(pnl) + ε)                  # main loss: Sharpe-like, more stable than raw profit
L_win      = BCE(Head B, win labels)                       # second loss: win rate
L_return   = Huber(Head C, r_long / r_short)               # helper: predicted size of the move
L_turnover = mean(|p_t − p_{t−1}|)                         # discourages trading back and forth

Loss = 1.0·L_profit + 0.3·L_win + 0.2·L_return + 0.05·L_turnover
```

## 5. Training details

- **Batches.** Use blocks of consecutive bars, for example 256 bars in order. The turnover term then sees real position changes.
- **Recency weighting.** Recent bars weigh more, using the existing `recency_half_life` setting.
- **Early stopping.** Stop on the after-fee profit of the early-stopping slice, not on the loss value.
- **Ensembling.** Train 3–5 copies with different seeds and average their outputs. This cuts noise a lot.
- **Optimizer.** AdamW, learning rate 1e-3 with cosine decay, weight decay 1e-4, gradient clipping at 1.0.
- **No look-ahead.** Scaling, regimes and early stopping use only data inside the current training block.

## 6. Search space

| Setting | Values |
|---|---|
| Window length L | 32, 64, 128 |
| Horizon H (bars) | 8, 12, 24 |
| Win-loss weight | 0.1, 0.3, 0.5 |
| Turnover weight | 0.02, 0.05, 0.1 |
| Dead zone \|p\| | 0.2, 0.3, 0.4 |
| Cost multiple k | 1, 2, 3 |

Ranking rules, the same as `server/strategies/ml/tuning.py`:

1. At least 20 training trades and 10 validation trades.
2. A profit in both training and validation.
3. The highest combined profit.
4. The shallower drawdown, to break ties.

The forward test is reported only, never used to choose.

## 7. Integration in this codebase

| Part | Where |
|---|---|
| Model and training loop | new `server/strategies/ml/deep.py`, listed in the `models.py` registry as `deep_policy` |
| After-fee labels | `server/strategies/ml/labels.py`: new cost-aware targets |
| Uses the `position` output directly | `server/strategies/ml/strategy.py`: new "policy" signal mode |
| Search settings | `server/strategies/ml/tuning.py`: window, loss weights, dead zone |
| UI | Bot settings: model choice and loss-weight sliders |
| Tests | `server/tests/test_ml_deep.py`: shapes, no look-ahead, fee in the loss, deterministic seed |

## 8. Build order

1. **After-fee labels** for the existing LightGBM ensemble. This is cheap and shows how much fees alone were costing.
2. **The deep model** with only `L_profit + L_win`.
3. **Add** the return head, the turnover penalty and seed ensembling.
4. **Compare all three** with fees on (0.06% per side plus slippage), over the same train, validation and forward-test split.

## 9. Success criteria

- Positive net P&L after fees in training **and** validation.
- At least 20 training trades and 10 validation trades.
- Validation profit factor above 1.2, and a max drawdown below 25%.
- A positive forward test, as a final check only.

## 10. Risks and expectations

- **Overfitting.** A profit-based loss overfits easily. Early stopping, small layers, dropout and seed ensembling are required, not optional.
- **Costs dominate.** At 0.12% per round trip, the gain will mostly come from fewer, better trades. A higher win rate alone won't do it.
- **Lower fees help directly.** Limit orders that pay the maker fee cut the cost per trade roughly in half.
- **Stop condition.** If the deep model also fails to profit after fees in both training and validation, the edge isn't in this data. Don't take it live.

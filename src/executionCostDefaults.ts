// Editable HTX-oriented simulation assumptions, not authenticated account rates.
export const htxCostDefaults = {
  fee_bps:6,        // 0.06% taker estimate per side.
  slippage:.01,     // XAG price-unit assumption per fill.
  spread:.02,       // XAG full-spread assumption.
  funding_bps:1,    // +0.01% per 8h scenario; actual funding varies.
};

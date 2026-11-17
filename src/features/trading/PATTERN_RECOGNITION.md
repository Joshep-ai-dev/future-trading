# Pattern recognition

`patternRecognition.ts` is the shared entry point for selected-area analysis and
the current-curve library. The sequence is OHLC → ATR ZigZag → geometric rules →
quality ranking. All selected candles must be completed and uninterrupted.

`zigzag.ts` calculates causal Wilder ATR(14), seeded from available bars until
the first full period. A reversal requires a later closing price to move at
least 1.5 × the preceding candle's ATR, with a minimum move of 0.05% of price.
The dialog exposes the ATR multiplier. Confirmed pivots retain their original
index, value, confirmation bar and threshold when new bars arrive. The final
extreme is provisional and does not enter geometric rules. An outside candle
cannot establish the order of its own high and low. Changing the multiplier or
selection intentionally recalculates the pivots.

Twenty specific formations have rules: head and shoulders and its inverse,
double/triple tops and bottoms, bullish/bearish flags and pennants, the three
triangles, rising/falling wedges, rectangle, rising/falling channels and the
two cup-and-handle directions. Other catalog entries remain manual references.
All relevant rules must pass; no template score can override a failure.
Geometry uses the whole selected window, so include the preceding trend.

Results are confirmed (a closing breakout passed), forming (geometry passed,
closing breakout pending), rejected or unverified. Triangle, rectangle and
channel direction is decided by the actual breakout, regardless of catalog
bias. Closing breaks against a directional setup invalidate that candidate.
The chart draws actual OHLC highs/lows, closes, confirmed pivots, the unfinished
leg and fitted boundaries. Pivot tooltips distinguish the swing candle's open
time from the later confirmation close. All displayed times use UTC+9.

Quality is geometry 30%, trendline fit 25%, symmetry 15%, structural checks 20%
and template similarity 10%. The last component uses bounded DTW solely for
ranking and optional sketch comparison. The score is a heuristic quality
measure, not a calibrated win probability. The previous random-walk matcher
remains available in `patternSimilarity.ts`, but does not gate this pipeline.

Run `node scripts/test-pattern-similarity.mjs` for causal pivot, geometry,
breakout, inversion, gap, selection and timezone checks. Run `npm.cmd run build`
for TypeScript and production bundle validation.

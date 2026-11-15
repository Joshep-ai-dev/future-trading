
export type MaType = "SMA" | "EMA";
export type TripleMaPoint = { time: number; values: (number | null)[] };

/** Line colors of TradingView's "Triple MA" (fast green, mid red, slow yellow). */
export const TRIPLE_MA_COLORS = [
  "rgba(0,255,0,0.65)",
  "rgba(255,0,0,0.65)",
  "rgba(255,255,0,0.65)",
];
export const TRIPLE_MA_LABEL_COLORS = ["#00ff00", "#ff0000", "#ffff00"];

function movingAverage(closes: number[], length: number, type: MaType): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (length < 1) return out;
  if (type === "SMA") {
    let sum = 0;
    for (let i = 0; i < closes.length; i++) {
      sum += closes[i];
      if (i >= length) sum -= closes[i - length];
      if (i >= length - 1) out[i] = sum / length;
    }
    return out;
  }
  const k = 2 / (length + 1);
  let ema: number | null = null,
    seed = 0;
  for (let i = 0; i < closes.length; i++) {
    if (ema === null) {
      seed += closes[i];
      if (i === length - 1) ema = seed / length;
    } else ema = ema + k * (closes[i] - ema);
    out[i] = ema;
  }
  return out;
}

export function chartTripleMa(
  candles: { time: number; close: number }[],
  lengths: number[],
  type: MaType,
): TripleMaPoint[] {
  const closes = candles.map((c) => c.close);
  const lines = lengths.map((length) => movingAverage(closes, length, type));
  return candles.map((c, i) => ({ time: c.time, values: lines.map((line) => line[i]) }));
}

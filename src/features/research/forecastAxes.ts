/** Rounded, equal price units and clock-aligned UTC ticks for forecast charts. */
export function priceAxis(min: number, max: number) {
  const padding = Math.max((max - min) * 0.12, 0.01);
  const desired = (max - min + 2 * padding) / 5;
  const magnitude = 10 ** Math.floor(Math.log10(desired));
  const fraction = desired / magnitude;
  const unit =
    ([1, 2, 2.5, 5, 10].find((value) => value >= fraction) || 10) * magnitude;
  const low = Math.floor((min - padding) / unit) * unit,
    high = Math.ceil((max + padding) / unit) * unit;
  const count = Math.round((high - low) / unit);
  const decimals = Math.max(
    2,
    Math.min(
      8,
      Math.ceil(-Math.log10(unit)) + (unit / magnitude === 2.5 ? 1 : 0),
    ),
  );
  return {
    low,
    high,
    unit,
    decimals,
    ticks: Array.from({ length: count + 1 }, (_, index) =>
      Number((low + index * unit).toFixed(8)),
    ),
  };
}

export function timeAxis(left: number, right: number, unit = 0) {
  const intervals = [
    60, 300, 600, 900, 1800, 3600, 7200, 14400, 21600, 43200, 86400, 172800,
    604800, 2592000,
  ];
  const step =
    unit > 0 && (right - left) / unit <= 500
      ? unit
      : intervals.find((value) => value >= (right - left) / 5) || 2592000;
  const ticks: number[] = [];
  for (let value = Math.ceil(left / step) * step; value <= right; value += step)
    ticks.push(value);
  return ticks;
}

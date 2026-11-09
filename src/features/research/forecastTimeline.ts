export type TimelineForecast = {
  time: number;
  close: number;
  originTime: number;
  originClose: number;
  issuedAt: number;
  actualClose?: number;
};
export type TimelineSource = {
  originTime: number;
  originClose: number;
  issuedAt: number;
  path?: { time: number; close: number }[];
};

/** Keep the first next-candle prediction issued before its target close. */
export function retainNextForecast(
  previous: TimelineForecast[],
  prediction: TimelineSource,
): TimelineForecast[] {
  const point = prediction.path?.[0];
  if (
    !point ||
    prediction.issuedAt >= point.time ||
    previous.some((item) => item.time === point.time)
  )
    return previous;
  if (
    ![
      point.time,
      point.close,
      prediction.originTime,
      prediction.originClose,
      prediction.issuedAt,
    ].every(Number.isFinite)
  )
    return previous;
  return [
    ...previous,
    {
      ...point,
      originTime: prediction.originTime,
      originClose: prediction.originClose,
      issuedAt: prediction.issuedAt,
    },
  ]
    .sort((a, b) => a.time - b.time)
    .slice(-500);
}

export function compareForecasts(
  forecasts: TimelineForecast[],
  actual: { time: number; close: number }[],
) {
  const prices = new Map(actual.map((point) => [point.time, point.close]));
  return forecasts.map((point) => {
    const observed = point.actualClose ?? prices.get(point.time);
    return {
      ...point,
      actual: observed ?? null,
      error: observed == null ? null : point.close - observed,
    };
  });
}

/** Capture exact completed-candle outcomes, so old comparisons survive the chart window. */
export function retainObservedCloses(
  forecasts: TimelineForecast[],
  actual: { time: number; close: number }[],
): TimelineForecast[] {
  const prices = new Map(actual.map((point) => [point.time, point.close]));
  return forecasts.map((point) =>
    point.actualClose != null || !prices.has(point.time)
      ? point
      : { ...point, actualClose: prices.get(point.time)! },
  );
}

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineStyle,
  type UTCTimestamp,
} from "lightweight-charts";
import { api } from "../../shared/api/api";
import { fmt } from "../../shared/types/types";
import { TV, tvCandleOptions, tvChartOptions, tvTimeScaleOptions } from "../../shared/charts/tvTheme";
import { chartTimeOptions, useChartTimeZone } from "../../shared/charts/chartTimeZone";
import { formatTradingTime } from "../../shared/charts/tradingTime";
import { chartVolume } from "../../shared/charts/chartVolume";
import type { Analysis } from "../../shared/types/types";

export type ChartRelease = {
  name: string;
  label: string;
  released: number;
  actual: string;
  forecast: string;
  surprise: string;
  reaction: { m15: number | null; m60: number | null; m240: number | null } | null;
};
type Candles = Analysis["candles"];

// Timeframe -> [seconds per candle, hours shown before the release, hours after].
const FRAMES = { "1m": [60, 1, 4], "5m": [300, 6, 24], "15m": [900, 24, 72], "1h": [3600, 72, 240] } as const;
type Frame = keyof typeof FRAMES;
const pct = (value: number | null | undefined) => (value == null ? "—" : `${value > 0 ? "+" : ""}${fmt(value, 2)}%`);
const tone = (value: number | null | undefined) => (value == null || value === 0 ? "" : value > 0 ? "positive" : "negative");

/** XAG/USDT candles around a US release: the release candle is marked and the last pre-release close is a dashed line. */
export default function ReleaseChart({ release, onClose, onOpenTrading }: { release: ChartRelease; onClose: () => void; onOpenTrading?: () => void }) {
  const zone = useChartTimeZone();
  const dialog = useRef<HTMLDialogElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState<Frame>("1m");
  const [candles, setCandles] = useState<Candles | null>(null),
    [error, setError] = useState("");

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  useEffect(() => {
    const [seconds, before, after] = FRAMES[frame];
    setCandles(null);
    setError("");
    const end = release.released + after * 3600 + seconds;
    api<{ candles: Candles }>("/api/candles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeframe: frame, before: end, limit: Math.ceil(((before + after) * 3600) / seconds) + 2 }),
    })
      .then((value) => setCandles(value.candles.filter((c) => c.time >= release.released - before * 3600)))
      .catch((reason) => setError(String(reason)));
  }, [frame, release.released]);

  useEffect(() => {
    if (!host.current || !candles?.length) return;
    const [seconds] = FRAMES[frame];
    const chart = createChart(host.current, {
      ...tvChartOptions,
      autoSize: true,
      localization: chartTimeOptions(zone).localization,
      timeScale: { ...tvTimeScaleOptions, timeVisible: true, rightOffset: 4, ...chartTimeOptions(zone).timeScale },
    });
    const price = chart.addSeries(CandlestickSeries, { ...tvCandleOptions, priceFormat: { type: "price", precision: 3, minMove: 0.001 } });
    price.setData(candles.map((c) => ({ ...c, time: c.time as UTCTimestamp })));
    const volume = chart.addSeries(HistogramSeries, { priceScaleId: "", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volume.setData(chartVolume(candles));
    const releaseCandle = Math.floor(release.released / seconds) * seconds;
    createSeriesMarkers(price, [
      { time: releaseCandle as UTCTimestamp, position: "aboveBar", shape: "arrowDown", color: TV.orange, text: release.label },
    ]);
    const before = [...candles].reverse().find((c) => c.time + seconds <= release.released);
    if (before)
      price.createPriceLine({ price: before.close, color: TV.orange, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "Before" });
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [candles, frame, zone, release.released, release.label]);

  return createPortal(
    <dialog
      ref={dialog}
      className='tv-dialog release-chart'
      aria-labelledby='release-chart-title'
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header className='tv-dialog-header'>
        <div>
          <h3 id='release-chart-title'>
            XAG/USDT · {release.label}
          </h3>
          <small>{formatTradingTime(release.released, zone)}</small>
        </div>
        {onOpenTrading && (
          <button type='button' className='release-open-trading' onClick={onOpenTrading} title='Open the Trading page chart at this release'>
            <svg viewBox='0 0 18 18' aria-hidden='true'>
              <path d='M3 14l4-5 3 3 5-7M11 5h4v4' />
            </svg>
            Open in trading chart
          </button>
        )}
        <button type='button' className='tv-dialog-close' aria-label='Close' onClick={onClose}>
          <svg viewBox='0 0 18 18' aria-hidden='true'>
            <path d='M4.5 4.5l9 9M13.5 4.5l-9 9' />
          </svg>
        </button>
      </header>
      <div className='release-chart-facts'>
        <span>
          Actual <b>{release.actual}</b>
        </span>
        <span>
          Forecast <b>{release.forecast}</b>
        </span>
        <span>
          Surprise <b>{release.surprise}</b>
        </span>
        <span>
          Silver 15m <b className={tone(release.reaction?.m15)}>{pct(release.reaction?.m15)}</b>
        </span>
        <span>
          1h <b className={tone(release.reaction?.m60)}>{pct(release.reaction?.m60)}</b>
        </span>
        <span>
          4h <b className={tone(release.reaction?.m240)}>{pct(release.reaction?.m240)}</b>
        </span>
        <div className='news-segment' role='group' aria-label='Chart timeframe'>
          {(Object.keys(FRAMES) as Frame[]).map((key) => (
            <button key={key} type='button' aria-pressed={frame === key} onClick={() => setFrame(key)}>
              {key}
            </button>
          ))}
        </div>
      </div>
      <div className='release-chart-body'>
        {error ? (
          <p className='error' role='alert'>
            {error}
          </p>
        ) : candles && !candles.length ? (
          <p className='news-caption'>No market candles around this release.</p>
        ) : (
          <div className='release-chart-canvas' ref={host} />
        )}
      </div>
      <p className='news-caption'>
        Orange arrow: the release candle. Dashed line: the last close before the release. Showing {FRAMES[frame][1]}h before to {FRAMES[frame][2]}h after.
      </p>
    </dialog>,
    document.body,
  );
}

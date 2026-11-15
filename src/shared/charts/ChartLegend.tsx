import { TV } from "./tvTheme";
import { useState } from "react";
import type { IndicatorConfig, OverlayKind } from "./IndicatorSettings";

export type OverlayHidden = Partial<Record<OverlayKind | "trend", boolean>>;

/** Legend rows for the price-pane overlay studies (Triple MA, Bollinger Bands, Supertrend). */
export function overlayLegends(
  selection: { bollinger: boolean; supertrend: boolean; triplema: boolean },
  config: IndicatorConfig,
  hidden: OverlayHidden,
  onSettings: (kind: OverlayKind) => void,
  onToggle: (kind: OverlayKind) => void,
  onToggleHidden: (kind: OverlayKind) => void,
): LegendOverlay[] {
  const row = (kind: OverlayKind, name: string, params: string, color: string): LegendOverlay => ({
    key: kind,
    name,
    params,
    color,
    hidden: !!hidden[kind],
    onToggleVisible: () => onToggleHidden(kind),
    onSettings: () => onSettings(kind),
    onRemove: () => onToggle(kind),
  });
  return [
    ...(selection.triplema
      ? [row("triplema", "Triple MA", `${config.maFast} ${config.maMid} ${config.maSlow}${config.maType === "EMA" ? " EMA" : ""}`, "#00ff00")]
      : []),
    ...(selection.bollinger
      ? [row("bollinger", "BB", `${config.bbLength} ${config.bbMaType} ${config.bbSource} ${config.bbMultiplier}${config.bbOffset ? ` ${config.bbOffset}` : ""}`, TV.blue)]
      : []),
    ...(selection.supertrend
      ? [row("supertrend", "Supertrend", `${config.supertrendLength} ${config.supertrendMultiplier}`, TV.green)]
      : []),
  ];
}

export type LegendCandle = {
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};
export type LegendData = {
  candle: LegendCandle;
  previousClose?: number;
  extras?: string[];
  studies?: Record<string, StudyValue[]>;
};
export type StudyValue = { text: string; color: string };
export type LegendOverlay = {
  key: string;
  name: string;
  params: string;
  color: string;
  hidden?: boolean;
  onToggleVisible?: () => void;
  onSettings?: () => void;
  onRemove?: () => void;
};

const price = (value: number) => value.toFixed(3);

export function compactVolume(value: number) {
  const abs = Math.abs(value);
  for (const [limit, suffix] of [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ] as const)
    if (abs >= limit) return `${(value / limit).toFixed(2)}${suffix}`;
  return value.toFixed(abs < 10 ? 2 : 0);
}

export function legendData(
  candles: LegendCandle[],
  index: number,
  extras?: string[],
  studies?: Record<string, StudyValue[]>,
): LegendData | null {
  const candle = candles[index];
  if (!candle) return null;
  return { candle, previousClose: candles[index - 1]?.close, extras, studies };
}

/** TradingView-style legend: symbol line with OHLC, then one row per overlay study. */
export default function ChartLegend({
  title,
  data,
  overlays = [],
}: {
  title: string;
  data: LegendData | null;
  overlays?: LegendOverlay[];
}) {
  const [collapsed, setCollapsed] = useState(false);
  const candle = data?.candle;
  const base = data?.previousClose ?? candle?.open;
  const change = candle && base !== undefined ? candle.close - base : null;
  const color = candle && candle.close >= candle.open ? TV.up : TV.down;
  return (
    <div className='tv-legend' aria-live='off'>
      <div className='tv-legend-row tv-legend-main'>
        <span className='tv-legend-title'>{title}</span>
        {candle && (
          <span className='tv-legend-values' style={{ color }}>
            <span>
              <i>O</i>
              {price(candle.open)}
            </span>
            <span>
              <i>H</i>
              {price(candle.high)}
            </span>
            <span>
              <i>L</i>
              {price(candle.low)}
            </span>
            <span>
              <i>C</i>
              {price(candle.close)}
            </span>
            {change !== null && base ? (
              <span>
                {change >= 0 ? "+" : "−"}
                {price(Math.abs(change))} ({change >= 0 ? "+" : "−"}
                {Math.abs((change / base) * 100).toFixed(2)}%)
              </span>
            ) : null}
          </span>
        )}
      </div>
      {candle?.volume !== undefined && (
        <div className='tv-legend-row'>
          <span className='tv-legend-name'>Vol</span>
          <span style={{ color }}>{compactVolume(candle.volume)}</span>
        </div>
      )}
      {!collapsed &&
        overlays.map((overlay) => (
          <div
            className={`tv-legend-row tv-legend-study${overlay.hidden ? " is-hidden" : ""}`}
            key={overlay.key}
          >
            <span className='tv-legend-name'>{overlay.name}</span>
            {overlay.params && <span className='tv-legend-params'>{overlay.params}</span>}
            {!overlay.hidden &&
              (data?.studies?.[overlay.key] ?? []).map((value, index) => (
                <span key={index} className='tv-legend-value' style={{ color: value.color }}>
                  {value.text}
                </span>
              ))}
            <span className='tv-legend-actions'>
              {overlay.onToggleVisible && (
                <button
                  type='button'
                  className='tv-legend-eye'
                  title={overlay.hidden ? "Show" : "Hide"}
                  aria-label={`${overlay.hidden ? "Show" : "Hide"} ${overlay.name}`}
                  aria-pressed={!overlay.hidden}
                  onClick={overlay.onToggleVisible}
                >
                  <EyeIcon off={overlay.hidden} />
                </button>
              )}
              {overlay.onSettings && (
                <button type='button' title='Settings' aria-label={`${overlay.name} settings`} onClick={overlay.onSettings}>
                  <GearIcon />
                </button>
              )}
              {overlay.onRemove && (
                <button type='button' title='Remove' aria-label={`Remove ${overlay.name}`} onClick={overlay.onRemove}>
                  <CloseIcon />
                </button>
              )}
            </span>
          </div>
        ))}
      {overlays.length > 0 && (
        <button
          type='button'
          className='tv-legend-collapse'
          aria-expanded={!collapsed}
          title={collapsed ? "Show indicator legend" : "Hide indicator legend"}
          aria-label={collapsed ? "Show indicator legend" : "Hide indicator legend"}
          onClick={() => setCollapsed((value) => !value)}
        >
          <svg viewBox='0 0 18 18' aria-hidden='true'>
            <path d={collapsed ? "M5 7l4 4 4-4" : "M5 11l4-4 4 4"} />
          </svg>
          {collapsed && <span>{overlays.length}</span>}
        </button>
      )}
      {data?.extras?.map((extra) => (
        <div className='tv-legend-row tv-legend-extra' key={extra}>
          {extra}
        </div>
      ))}
    </div>
  );
}

export function EyeIcon({ off = false }: { off?: boolean }) {
  return (
    <svg viewBox='0 0 18 18' aria-hidden='true'>
      <path d='M1.5 9S4.2 4 9 4s7.5 5 7.5 5-2.7 5-7.5 5-7.5-5-7.5-5Z' />
      <circle cx='9' cy='9' r='2.3' />
      {off && <path d='M3 15 15 3' />}
    </svg>
  );
}

export function GearIcon() {
  return (
    <svg viewBox='0 0 18 18' aria-hidden='true'>
      <circle cx='9' cy='9' r='2.4' />
      <path d='M9 1.8v2M9 14.2v2M1.8 9h2M14.2 9h2M3.9 3.9l1.4 1.4M12.7 12.7l1.4 1.4M3.9 14.1l1.4-1.4M12.7 5.3l1.4-1.4' />
      <circle cx='9' cy='9' r='5' />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg viewBox='0 0 18 18' aria-hidden='true'>
      <path d='M4.5 4.5l9 9M13.5 4.5l-9 9' />
    </svg>
  );
}

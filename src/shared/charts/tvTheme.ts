import { ColorType, CrosshairMode, LineStyle } from "lightweight-charts";

/**
 * TradingView black theme palette (sampled from TradingView screenshots).
 * Reusable single source for charts; the CSS side lives in
 * src/styles/tv-tokens.css and must use the same values.
 */
export const TV = {
  background: "#000000",
  grid: "#303030",
  border: "#222222",
  separator: "#303030",
  text: "#dbdbdb",
  textStrong: "#dbdbdb",
  muted: "#9c9c9c",
  crosshair: "#9c9c9c",
  crosshairLabel: "#303030",
  up: "#089981",
  down: "#f23645",
  upVolume: "rgba(8,153,129,0.5)",
  downVolume: "rgba(242,54,69,0.5)",
  blue: "#2962ff",
  orange: "#ff9800",
  purple: "#7e57c2",
  teal: "#00bcd4",
  green: "#4caf50",
  font: 'Arial, "Helvetica Neue", Helvetica, sans-serif',
} as const;

/** Default plot colors of the matching TradingView built-in studies. */
export const TV_STUDY_COLORS = {
  atr: "#b71c1c",
  adx: "#ff5252",
  rsi: TV.purple,
} as const;

export const tvLayout = {
  background: { type: ColorType.Solid, color: TV.background },
  textColor: TV.text,
  fontSize: 12,
  fontFamily: TV.font,
  panes: {
    separatorColor: TV.separator,
    separatorHoverColor: "rgba(41,98,255,0.25)",
    enableResize: true,
  },
};

export const tvGrid = {
  vertLines: { visible: true, color: TV.grid, style: LineStyle.SparseDotted },
  horzLines: { visible: true, color: TV.grid, style: LineStyle.SparseDotted },
};

export const tvCrosshair = {
  mode: CrosshairMode.Normal,
  vertLine: {
    color: TV.crosshair,
    width: 1 as const,
    style: LineStyle.LargeDashed,
    labelBackgroundColor: TV.crosshairLabel,
  },
  horzLine: {
    color: TV.crosshair,
    width: 1 as const,
    style: LineStyle.LargeDashed,
    labelBackgroundColor: TV.crosshairLabel,
  },
};

/** Chart-level options: layout, grid, crosshair and scale borders. */
export const tvChartOptions = {
  layout: tvLayout,
  grid: tvGrid,
  crosshair: tvCrosshair,
  rightPriceScale: { borderVisible: false },
  leftPriceScale: { borderVisible: false },
};

export const tvTimeScaleOptions = { borderVisible: false };

export const tvCandleOptions = {
  upColor: TV.up,
  downColor: TV.down,
  borderVisible: true,
  borderUpColor: TV.up,
  borderDownColor: TV.down,
  wickUpColor: TV.up,
  wickDownColor: TV.down,
};

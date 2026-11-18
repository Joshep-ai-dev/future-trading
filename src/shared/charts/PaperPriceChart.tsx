import { BollingerOverlay } from "./BollingerOverlay";
import { chartBollingerBands } from "./bollingerBands";
import { SupertrendOverlay } from "./SupertrendOverlay";
import { chartSupertrend } from "./supertrend";
import { indicatorColor } from "./indicatorColors";
import IndicatorHeader from "./IndicatorHeader";
import IndicatorSettings, {
  alpha,
  useIndicatorSettings,
  type IndicatorConfig,
  type IndicatorKind,
  type OverlayKind,
  type SettingsKind,
} from "./IndicatorSettings";
import { AdxVisualizer, adxColor, adxLevels, diColors, levelColor } from "./adxDisplay";
import { PaneBand } from "./PaneBand";
import ChartLegend, {
  legendData,
  overlayLegends,
  type LegendData,
  type StudyValue,
} from "./ChartLegend";
import DrawingToolbar from "./DrawingToolbar";
import { useChartDrawings } from "./drawings";
import { trackPriceAxis } from "./priceAxisCountdown";
import {
  chartTripleMa,
  TRIPLE_MA_OPACITY,
  tripleMaColors,
} from "./tripleMa";
import type { ChartIndicatorSelection } from "./chartIndicatorSelection";
import {
  TV,
  tvCandleOptions,
  tvChartOptions,
  tvTimeScaleOptions,
} from "./tvTheme";
import { chartOscillators } from "./chartOscillators";
import {
  chartTimeOptions,
  useChartTimeZone,
} from "./chartTimeZone";
import { TIMEFRAMES } from "./chartTimeframe";
import { StopOverlay } from "./StopOverlay";
import { api } from "../api/api";
import { mergeHistory, canAppendCandles } from "./candleHistory";
import {
  candleLogical,
  captureViewport,
  restoreViewport,
} from "./chartViewport";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type AutoscaleInfo,
  type ISeriesApi,
  type IChartApi,
  type UTCTimestamp,
  type SeriesMarker,
} from "lightweight-charts";
import { fillMarker, FillLabels } from "./fillMarkers";
import ChartTools, {
  chartInteraction,
  resizeChart,
  ScrollToLatest,
} from "./ChartTools";
import {
  useChartIndicatorSelection,
  toggleChartIndicator,
} from "./chartIndicatorSelection";
import type { Analysis } from "../types/types";
import type { PaperTrade, Position } from "../../features/trading/PaperTrading";
import { chartVolume } from "./chartVolume";
import PatternRangeAnalyzer from "./PatternRangeAnalyzer";
import ChartTimeNavigator from "./ChartTimeNavigator";

type Point = {
  time: number;
  bbBasis: number | null;
  bbUpper: number | null;
  bbLower: number | null;
  trendSma: number | null;
};
type Data = {
  livePositions?:
    | { side: string; quantity: number; entryPrice: number | null }[]
    | null;
  candles: Analysis["candles"];
  indicators: Point[];
  stops: { time: number; price: number | null }[];
  trades: PaperTrade[];
  position: Position | null;
  indicatorClock: number;
};
type HistoryPage = { candles: Analysis["candles"]; hasMore: boolean };
type Props = Data & {
  header?: ReactNode;
  toolbarEnd?: ReactNode;
  sessionId: number;
  showSma: boolean;
  timeframe: string;
  atrLength: number;
  adxLength: number;
  allowLocalHistory?: boolean;
  loadHistory?: (before: number) => Promise<HistoryPage>;
  historyLabel?: string;
  symbol?: string;
  /** Scroll to this moment (e.g. an economic release); ``key`` changes on every request. */
  focus?: ChartFocus | null;
};
export type ChartFocus = { time: number; label: string; key: number };

export default function PaperPriceChart(props: Props) {
  const [patternSelecting, setPatternSelecting] = useState(false);
  const patternCandles = useRef<Analysis['candles']>([]);
  const container = useRef<HTMLDivElement>(null),
    chartRef = useRef<IChartApi | null>(null);
  const update = useRef<(data: Data) => void>(() => {});
  const selectedIndicators = useChartIndicatorSelection();
  const [indicatorConfig, setIndicatorConfig] = useIndicatorSettings();
  const [settingsOpen, setSettingsOpen] = useState<SettingsKind | null>(
    null,
  );
  const drawing = useChartDrawings(props.symbol ?? "XAGUSDT");
  const [hiddenOverlays, setHiddenOverlays] = useState<
    Record<OverlayKind, boolean>
  >({ bollinger: false, supertrend: false, triplema: false });
  const hiddenOverlaysRef = useRef(hiddenOverlays);
  hiddenOverlaysRef.current = hiddenOverlays;
  const timeZone = useChartTimeZone();
  const timeZoneRef = useRef(timeZone);
  timeZoneRef.current = timeZone;
  const configRef = useRef(indicatorConfig);
  configRef.current = indicatorConfig;
  function applyIndicatorConfig(config: IndicatorConfig) {
    setIndicatorConfig(config);
  }
  const changePanels = useRef<
    (
      selection: ChartIndicatorSelection,
      config: IndicatorConfig,
    ) => void
  >(() => {});
  function toggleIndicator(key: keyof ChartIndicatorSelection) {
    if (key in hiddenOverlaysRef.current)
      setHiddenOverlays((old) => ({ ...old, [key]: false }));
    toggleChartIndicator(key);
  }
  const [paneHeaders, setPaneHeaders] = useState<
    { kind: IndicatorKind; top: number }[]
  >([]);
  const [paneValues, setPaneValues] = useState<{
    atr: number | null;
    adx: number | null;
    rsi: number | null;
  }>({ atr: null, adx: null, rsi: null });
  const [diValues, setDiValues] = useState<{
    pdi: number | null;
    mdi: number | null;
  }>({ pdi: null, mdi: null });
  const [hiddenIndicators, setHiddenIndicators] = useState({
    atr: false,
    adx: false,
    rsi: false,
  });
  const [strategyVisible, setStrategyVisible] = useState(false);
  const [maHidden, setMaHidden] = useState(false);
  const strategyVisibleRef = useRef(strategyVisible);
  strategyVisibleRef.current = strategyVisible && !maHidden;
  const hiddenRef = useRef(hiddenIndicators);
  hiddenRef.current = hiddenIndicators;
  const updateVisibility = useRef<() => void>(() => {});
  const updateStrategyVisibility = useRef<() => void>(() => {});
  const loadEarlier = useRef<() => void>(() => {});
  const clearFocus = useRef<() => void>(() => {});
  const focusRequest = useRef(0);
  const focusOn = useRef<(focus: ChartFocus) => Promise<void>>(async () => {});
  const [loading, setLoading] = useState(false),
    [hasMore, setHasMore] = useState(true),
    [historyError, setHistoryError] = useState("");
  const following = useRef(true),
    lastTime = useRef<number | undefined>(undefined);
  const [follow, setFollow] = useState(true),
    [legend, setLegend] = useState<LegendData | null>(null);
  function holdView() {
    following.current = false;
    setFollow(false);
  }
  function latest() {
    following.current = true;
    setFollow(true);
    const chart = chartRef.current;
    if (!chart) return;
    const index = candleLogical(chart, lastTime.current);
    if (index === null) return;
    const range = chart.timeScale().getVisibleLogicalRange(),
      span = range ? range.to - range.from : 155;
    chart
      .timeScale()
      .setVisibleLogicalRange({ from: index + 6 - span, to: index + 6 });
  }
  useEffect(() => {
    if (!container.current) return;
    following.current = true;
    setFollow(true);
    const chart = createChart(container.current, {
      autoSize: false,
      ...chartInteraction,
      localization: chartTimeOptions(timeZone).localization,
      ...tvChartOptions,
      timeScale: {
        ...tvTimeScaleOptions,
        timeVisible: true,
        minBarSpacing: 0.2,
        rightOffset: 6,
        fixRightEdge: false,
        lockVisibleTimeRangeOnResize: true,
        shiftVisibleRangeOnNewBar: false,
        allowShiftVisibleRangeOnWhitespaceReplacement: false,
        ...chartTimeOptions(timeZone).timeScale,
      },
    });
    chartRef.current = chart;
    const price = chart.addSeries(CandlestickSeries, {
      ...tvCandleOptions,
      priceFormat: { type: "price", precision: 4, minMove: 0.0001 },
    });
    price
      .priceScale()
      .applyOptions({ scaleMargins: { top: 0.06, bottom: 0.1 } });
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: "",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    const detachDrawings = drawing.attach(chart, price, container.current);
    const tripleSeries = [0, 1, 2].map(() =>
      chart.addSeries(LineSeries, {
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerVisible: false,
        visible: false,
        priceFormat: { type: "price", precision: 3, minMove: 0.001 },
      }),
    );
    let tripleSelected = false;
    let studyValues = new Map<number, Record<string, StudyValue[]>>();
    const supertrendOverlay = new SupertrendOverlay();
    price.attachPrimitive(supertrendOverlay);
    let supertrendVisible = false,
      bollingerVisible = false;
    const bollingerOverlay = new BollingerOverlay();
    price.attachPrimitive(bollingerOverlay);
    const markers = createSeriesMarkers(price, []);
    const focusMarker = createSeriesMarkers(price, []);
    const fillLabels = new FillLabels();
    price.attachPrimitive(fillLabels);
    const overlays = [
      {
        key: "trendSma" as const,
        series: chart.addSeries(LineSeries, {
          color: configRef.current.trendSmaColor,
          lineWidth: configRef.current.trendSmaWidth as 1 | 2 | 3 | 4,
          title: "",
          priceLineVisible: false,
          lastValueVisible: false,
          visible: strategyVisibleRef.current,
        }),
      },
    ];
    updateStrategyVisibility.current = () => {
      for (const { series } of overlays)
        series.applyOptions({ visible: strategyVisibleRef.current });
    };
    const stopOverlay = new StopOverlay();
    price.attachPrimitive(stopOverlay);
    let liveEntryLines: ReturnType<typeof price.createPriceLine>[] = [];
    let liveEntryKey = "";
    const entry = chart.addSeries(LineSeries, {
      color: TV.blue,
      lineWidth: 2,
      title: "Open entry",
      priceLineVisible: false,
    });
    let smaKey = "";
    let oscillatorData: ReturnType<typeof chartOscillators> = [],
      oscillatorKey = "",
      panelConfig = configRef.current;
    const oscillatorSeries = new Map<IndicatorKind, ISeriesApi<"Line">>();
    let adxDecoration: AdxVisualizer | null = null;
    let diSeries: ISeriesApi<"Line">[] = [];
    let rsiBand: PaneBand | null = null;
    let paneFrame = 0,
      paneResize: ResizeObserver | null = null;
    setPaneHeaders([]);
    function watchPaneLayout() {
      paneResize?.disconnect();
      cancelAnimationFrame(paneFrame);
      const measure = () => {
        const root = container.current;
        if (!root) return;
        const base = root.getBoundingClientRect().top;
        const headers = [...oscillatorSeries].flatMap(([kind, series]) => {
          const element = series.getPane().getHTMLElement();
          return element
            ? [{ kind, top: element.getBoundingClientRect().top - base + 6 }]
            : [];
        });
        setPaneHeaders((old) =>
          JSON.stringify(old) === JSON.stringify(headers) ? old : headers,
        );
      };
      paneFrame = requestAnimationFrame(() => {
        measure();
        paneResize = new ResizeObserver(measure);
        if (container.current) paneResize.observe(container.current);
        for (const series of oscillatorSeries.values()) {
          const element = series.getPane().getHTMLElement();
          if (element) paneResize.observe(element);
        }
      });
    }
    updateVisibility.current = () => {
      for (const [kind, series] of oscillatorSeries)
        series.applyOptions({ visible: !hiddenRef.current[kind] });
      adxDecoration?.setVisible(!hiddenRef.current.adx);
      for (const series of diSeries)
        series.applyOptions({
          visible: !hiddenRef.current.adx && panelConfig.showDi,
        });
      rsiBand?.setVisible(!hiddenRef.current.rsi);
      const hiddenOverlay = hiddenOverlaysRef.current;
      bollingerOverlay.setVisible(bollingerVisible && !hiddenOverlay.bollinger);
      supertrendOverlay.setVisible(
        supertrendVisible && !hiddenOverlay.supertrend,
      );
      for (const series of tripleSeries)
        series.applyOptions({
          visible: tripleSelected && !hiddenOverlay.triplema,
        });
    };
    function paintOscillators() {
      const last = oscillatorData.at(-1);
      setPaneValues({
        atr: last?.atr ?? null,
        adx: last?.adx ?? null,
        rsi: last?.rsi ?? null,
      });
      setDiValues({ pdi: last?.pdi ?? null, mdi: last?.mdi ?? null });
      for (const [key, series] of oscillatorSeries) {
        if (key !== "adx")
          series.setData(
            oscillatorData.map((p) =>
              p[key] === null
                ? { time: p.time as UTCTimestamp }
                : {
                    time: p.time as UTCTimestamp,
                    value: p[key],
                    color: indicatorColor(key, p[key], panelConfig),
                  },
            ),
          );
        else {
          series.setData(
            oscillatorData.map((p) =>
              p.adx === null
                ? { time: p.time as UTCTimestamp }
                : {
                    time: p.time as UTCTimestamp,
                    value: p.adx,
                    color: adxColor(p.adx, panelConfig),
                  },
            ),
          );
          (["pdi", "mdi"] as const).forEach((field, index) =>
            diSeries[index]?.setData(
              oscillatorData.map((p) =>
                p[field] === null
                  ? { time: p.time as UTCTimestamp }
                  : { time: p.time as UTCTimestamp, value: p[field]! },
              ),
            ),
          );
          adxDecoration?.setData(oscillatorData);
        }
      }
    }
    changePanels.current = (selection, config) => {
      const viewport = captureViewport(chart, lastTime.current);
      panelConfig = config;
      oscillatorKey = "";
      smaKey = "";
      for (const { series } of overlays)
        series.applyOptions({
          color: config.trendSmaColor,
          lineWidth: config.trendSmaWidth as 1 | 2 | 3 | 4,
        });
      bollingerVisible = selection.bollinger;
      supertrendVisible = selection.supertrend;
      tripleSelected = selection.triplema;
      bollingerOverlay.setStyle({
        basis: config.bbBasisColor,
        upper: config.bbUpperColor,
        lower: config.bbLowerColor,
        width: config.bbWidth,
      });
      supertrendOverlay.setStyle({
        up: config.stUpColor,
        down: config.stDownColor,
        width: config.stWidth,
      });
      tripleMaColors(config).forEach((color, index) =>
        tripleSeries[index].applyOptions({
          color: alpha(color, TRIPLE_MA_OPACITY),
          lineWidth: config.maWidth as 1 | 2 | 3 | 4,
        }),
      );
      adxDecoration = null;
      rsiBand = null;
      for (const series of diSeries) chart.removeSeries(series);
      diSeries = [];
      for (const series of oscillatorSeries.values())
        chart.removeSeries(series);
      oscillatorSeries.clear();
      for (const key of ["atr", "adx", "rsi"] as const)
        if (selection[key]) {
          const pane = chart.panes().length;
          const series = chart.addSeries(
            LineSeries,
            {
              color:
                key === "adx"
                  ? adxColor(null, config)
                  : key === "atr"
                    ? config.atrColor
                    : config.rsiColor,
              lineWidth: (key === "adx"
                ? config.adxWidth
                : key === "atr"
                  ? config.atrWidth
                  : config.rsiWidth) as 1 | 2 | 3 | 4,
              title: "",
              priceLineVisible: false,
              priceFormat: {
                type: "price",
                precision: key === "atr" ? 3 : 2,
                minMove: key === "atr" ? 0.001 : 0.01,
              },
            },
            pane,
          );
          series
            .priceScale()
            .applyOptions({
              scaleMargins:
                key === "rsi"
                  ? { top: 0.04, bottom: 0.04 }
                  : { top: 0.12, bottom: 0.08 },
            });
          oscillatorSeries.set(key, series);
          if (key === "adx") {
            // Threshold values (default 20 / 25 / 50 / 75) with their price-scale labels.
            if (config.showAdxLevels)
              for (const value of adxLevels(config))
                series.createPriceLine({
                  price: value,
                  color: levelColor(value, config),
                  lineWidth: 1,
                  lineStyle: LineStyle.Dotted,
                  axisLabelVisible: true,
                  title: "",
                });
            diSeries = [config.diPlusColor, config.diMinusColor].map((color) =>
              chart.addSeries(
                LineSeries,
                {
                  color,
                  lineWidth: 1,
                  title: "",
                  priceLineVisible: false,
                  lastValueVisible: config.showDi,
                  crosshairMarkerVisible: config.showDi,
                  visible: config.showDi,
                  priceFormat: { type: "price", precision: 2, minMove: 0.01 },
                },
                series.getPane().paneIndex(),
              ),
            );
            adxDecoration = new AdxVisualizer(config.showStatus, config);
            series.attachPrimitive(adxDecoration);
          }
          if (key === "atr") {
            series.createPriceLine({
              price: config.atrThreshold,
              color: TV.orange,
              title: "",
              lineStyle: LineStyle.Dashed,
              lineWidth: 1,
              axisLabelVisible: false,
            });
            series.applyOptions({
              autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
                const info = original();
                return info?.priceRange
                  ? {
                      ...info,
                      priceRange: {
                        minValue: Math.min(
                          info.priceRange.minValue,
                          config.atrThreshold,
                        ),
                        maxValue: Math.max(
                          info.priceRange.maxValue,
                          config.atrThreshold,
                        ),
                      },
                    }
                  : null;
              },
            });
          }
          if (key === "rsi") {
            series.applyOptions({
              autoscaleInfoProvider: () => ({
                priceRange: { minValue: 0, maxValue: 100 },
                margins: { above: 2, below: 2 },
              }),
            });
            rsiBand = new PaneBand(
              config.rsiLower,
              config.rsiUpper,
              "rgba(126,87,194,0.1)",
            );
            series.attachPrimitive(rsiBand);
            for (const [value, color, style] of [
              [config.rsiUpper, TV.muted, LineStyle.Dashed],
              [50, "rgba(156,156,156,0.5)", LineStyle.Dotted],
              [config.rsiLower, TV.muted, LineStyle.Dashed],
            ] as const)
              series.createPriceLine({
                price: value,
                color,
                title: "",
                lineStyle: style,
                lineWidth: 1,
                axisLabelVisible: false,
              });
          }
        }
      chart
        .panes()
        .forEach((pane, index) => pane.setStretchFactor(index === 0 ? 3 : 1));
      if (latestData) update.current(latestData);
      else paintOscillators();
      updateVisibility.current();
      watchPaneLayout();
      restoreViewport(chart, viewport, lastTime.current, false);
    };
    let hoverTime: number | null = null,
      indexByTime = new Map<number, number>();
    let byTime = new Map<number, Analysis["candles"][number]>(),
      previousTime: number | undefined,
      previous: Data | null = null;
    let cached: Data["candles"] = [],
      indicators: Point[] = [],
      latestData: Data | null = null;
    let pending = false,
      more = props.allowLocalHistory !== false || !!props.loadHistory,
      failed = false,
      disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    setLoading(false);
    setHasMore(more);
    setHistoryError("");
    async function earlier() {
      const before = cached[0]?.time;
      if (pending || !more || before === undefined || !latestData) return;
      pending = true;
      failed = false;
      setLoading(true);
      setHistoryError("");
      try {
        const page = props.loadHistory
          ? await props.loadHistory(before)
          : await api<HistoryPage>("/api/candles", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              signal: abort.signal,
              body: JSON.stringify({
                timeframe: props.timeframe,
                before,
                limit: 1000,
              }),
            });
        if (disposed) return;
        const older = page.candles.filter((c) => c.time < before);
        cached = mergeHistory(older, cached);
        more = page.hasMore && older.length > 0;
        setHasMore(more);
        update.current(latestData);
        chart.timeScale().applyOptions({ fixLeftEdge: !more });
      } catch (error) {
        if (!disposed) {
          failed = true;
          setHistoryError(`Could not load earlier candles: ${String(error)}`);
        }
      } finally {
        pending = false;
        if (!disposed) {
          setLoading(false);
          scheduleHistory();
        }
      }
    }
    function scheduleHistory() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (disposed || pending || !more || failed) return;
        const range = chart.timeScale().getVisibleLogicalRange();
        // Logical index zero is the oldest loaded candle. Prefetch before the
        // user reaches the edge so wheel zooming and drag-panning stay fluid.
        if (range && range.from < 150) void earlier();
      }, 150);
    }
    loadEarlier.current = () => {
      void earlier();
    };
    clearFocus.current = () => { focusRequest.current++; focusMarker.setMarkers([]); };
    focusOn.current = async (focus) => {
      const request = ++focusRequest.current;
      // Load contiguous history back to a little before the focus time (large pages), then centre it.
      const duration = TIMEFRAMES[props.timeframe as keyof typeof TIMEFRAMES];
      following.current = false;
      setFollow(false);
      setLoading(true);
      setHistoryError("");
      try {
        while (!disposed && request === focusRequest.current && cached.length && cached[0].time > focus.time - 120 * duration && more && (props.allowLocalHistory !== false || props.loadHistory)) {
          const before = cached[0].time;
          const page = props.loadHistory ? await props.loadHistory(before) : await api<HistoryPage>("/api/candles", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: abort.signal,
            body: JSON.stringify({ timeframe: props.timeframe, before, limit: 5000 }),
          });
          const older = page.candles.filter((c) => c.time < before);
          cached = mergeHistory(older, cached);
          more = page.hasMore && older.length > 0;
        }
        if (disposed || request !== focusRequest.current || !latestData) return;
        setHasMore(more);
        update.current(latestData);
        const bucket = Math.floor(focus.time / duration) * duration;
        const index = cached.findIndex((c) => c.time >= bucket);
        if (index < 0 || cached[0].time > focus.time || cached[index].time !== bucket) {
          setHistoryError("No candles are available for that date.");
          return;
        }
        focusMarker.setMarkers([{ time: cached[index].time as UTCTimestamp, position: "aboveBar", shape: "arrowDown", color: TV.orange, text: focus.label }]);
        const span = Math.max(80, Math.round(5 * 3600 / duration));
        chart.timeScale().setVisibleLogicalRange({ from: index - span / 2, to: index + span / 2 });
      } catch (error) {
        if (!disposed) setHistoryError(`Could not load candles for that date: ${String(error)}`);
      } finally {
        if (!disposed) setLoading(false);
      }
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(scheduleHistory);
    let fillReadouts = new Map<number, string[]>();
    update.current = (data) => {
      latestData = data;
      const viewport = captureViewport(chart, previousTime);
      cached = mergeHistory(cached, data.candles);
      patternCandles.current = cached;
      indicators = mergeHistory(indicators, data.indicators);
      data = { ...data, candles: cached, indicators };
      byTime = new Map(data.candles.map((c) => [c.time, c]));
      indexByTime = new Map(data.candles.map((c, index) => [c.time, index]));
      const stamp = data.candles.at(-1)?.time;
      // Append live candles without rebuilding the time scale. History prepends
      // still need setData, followed by restoration against a visible candle.
      const appendOnly =
        previous && canAppendCandles(previous.candles, data.candles);
      if (appendOnly && previous) {
        for (const candle of data.candles.slice(previous.candles.length - 1))
          price.update({ ...candle, time: candle.time as UTCTimestamp });
      } else
        price.setData(
          data.candles.map((c) => ({ ...c, time: c.time as UTCTimestamp })),
        );
      volume.setData(chartVolume(data.candles));

      // Trend SMA of closes, period from the chart's Trend SMA settings (display only).
      const smaLast = data.candles.at(-1);
      const nextSmaKey = `${panelConfig.trendSmaLength}:${data.candles.length}:${data.candles[0]?.time}:${smaLast?.time}:${smaLast?.close}`;
      if (overlays.length && nextSmaKey !== smaKey) {
        smaKey = nextSmaKey;
        const length = panelConfig.trendSmaLength;
        let sum = 0;
        const points = data.candles.map((c, index) => {
          sum += c.close;
          if (index >= length) sum -= data.candles[index - length].close;
          return index + 1 >= length
            ? { time: c.time as UTCTimestamp, value: sum / length }
            : { time: c.time as UTCTimestamp };
        });
        for (const { series } of overlays) series.setData(points);
      }
      const duration = TIMEFRAMES[props.timeframe as keyof typeof TIMEFRAMES];
      const completed = data.candles.filter(
        (c) => c.time + duration <= data.indicatorClock,
      );
      const lastCompleted = completed.at(-1);
      if (!appendOnly) oscillatorKey = "";
      const nextKey = `${completed.length}:${completed[0]?.time}:${lastCompleted?.time}:${lastCompleted?.open}:${lastCompleted?.high}:${lastCompleted?.low}:${lastCompleted?.close}`;
      if (nextKey !== oscillatorKey) {
        oscillatorKey = nextKey;
        oscillatorData = chartOscillators(
          completed,
          duration,
          panelConfig.atrLength,
          panelConfig.adxLength,
          panelConfig.atrSmoothing,
          panelConfig.rsiLength,
          panelConfig.diLength,
        );
        paintOscillators();
      }
      // Both Pine overlays use the same corrected OHLCV, including the live bar.
      const current = data.candles.filter((c) => c.time <= data.indicatorClock);
      drawing.setCandles(data.candles, duration);
      studyValues = new Map();
      const addStudy = (time: number, key: string, values: StudyValue[]) => {
        const row = studyValues.get(time) ?? {};
        row[key] = values;
        studyValues.set(time, row);
      };
      if (bollingerVisible) {
        const bands = chartBollingerBands(current, {
          length: panelConfig.bbLength,
          maType: panelConfig.bbMaType,
          source: panelConfig.bbSource,
          multiplier: panelConfig.bbMultiplier,
          offset: panelConfig.bbOffset,
        });
        bollingerOverlay.setData(bands, panelConfig.bbOffset);
        for (const point of bands)
          if (point.basis !== null)
            addStudy(point.time, "bollinger", [
              { text: point.basis.toFixed(3), color: panelConfig.bbBasisColor },
              { text: point.upper!.toFixed(3), color: panelConfig.bbUpperColor },
              { text: point.lower!.toFixed(3), color: panelConfig.bbLowerColor },
            ]);
      }
      if (supertrendVisible) {
        const trend = chartSupertrend(
          current,
          duration,
          panelConfig.supertrendLength,
          panelConfig.supertrendMultiplier,
        );
        supertrendOverlay.setData(trend);
        for (const point of trend)
          if (point.value !== null)
            addStudy(point.time, "supertrend", [
              {
                text: point.value.toFixed(3),
                color:
                  point.direction === "down"
                    ? panelConfig.stDownColor
                    : panelConfig.stUpColor,
              },
            ]);
      }
      if (tripleSelected) {
        const averages = chartTripleMa(
          current,
          [panelConfig.maFast, panelConfig.maMid, panelConfig.maSlow],
          panelConfig.maType,
        );
        tripleSeries.forEach((series, index) =>
          series.setData(
            averages.map((point) =>
              point.values[index] === null
                ? { time: point.time as UTCTimestamp }
                : {
                    time: point.time as UTCTimestamp,
                    value: point.values[index]!,
                  },
            ),
          ),
        );
        for (const point of averages)
          addStudy(
            point.time,
            "triplema",
            point.values.map((value, index) => ({
              text: value === null ? "∅" : value.toFixed(3),
              color: tripleMaColors(panelConfig)[index],
            })),
          );
      } else for (const series of tripleSeries) series.setData([]);
      const nextLiveEntryKey = JSON.stringify(data.livePositions ?? []);
      if (nextLiveEntryKey !== liveEntryKey) {
        liveEntryKey = nextLiveEntryKey;
        liveEntryLines.forEach((line) => price.removePriceLine(line));
        liveEntryLines = (data.livePositions ?? [])
          .filter(
            (position) =>
              position.entryPrice != null &&
              Number.isFinite(position.entryPrice) &&
              position.entryPrice > 0,
          )
          .map((position) =>
            price.createPriceLine({
              price: position.entryPrice!,
              color: position.side === "long" ? TV.up : TV.down,
              lineWidth: 2,
              lineStyle: LineStyle.Dashed,
              axisLabelVisible: true,
              title: `${position.side.toUpperCase()} ${position.quantity} entry`,
            }),
          );
      }
      const p = data.position,
        first = data.candles[0]?.time;
      if (p && stamp !== undefined && first !== undefined) {
        const from = Math.max(first, p.entry_time);
        entry.setData(
          (from === stamp ? [from] : [from, stamp]).map((time) => ({
            time: time as UTCTimestamp,
            value: p.entry_price,
          })),
        );
      } else entry.setData([]);
      stopOverlay.setPaths(
        [...data.trades, ...(p ? [p] : [])].map((t) => {
          const to =
            "exit_time" in t ? Number(t.exit_time) : (stamp ?? t.entry_time);
          const initial = t.initial_stop ?? t.stop;
          const fallback = [
            { time: t.entry_time, price: initial, reason: "initial" },
            ...data.stops
              .filter(
                (h) => h.time > t.entry_time && h.time < to && h.price !== null,
              )
              .map((h) => ({
                time: h.time,
                price: h.price!,
                reason: h.price === initial ? "initial" : "trailing",
              })),
          ];
          return {
            from: t.entry_time,
            to,
            history: t.stop_history ?? fallback,
          };
        }),
        first,
        stamp,
      );
      const points: SeriesMarker<UTCTimestamp>[] = [];
      const addEntry = (position: Position, label: string, id: string) => {
        if (byTime.has(position.entry_time))
          points.push(
            fillMarker(
              position.entry_time,
              position.entry_price,
              label,
              "entry",
              position.direction,
              id,
              position.quantity,
            ),
          );
      };
      for (const t of data.trades) {
        addEntry(
          t,
          `${t.direction === 1 ? "BUY" : "SELL"} #${t.id}`,
          `entry-${t.id}`,
        );
        if (byTime.has(t.exit_time))
          points.push(
            fillMarker(
              t.exit_time,
              t.exit_price,
              `CLOSE #${t.id}`,
              "close",
              t.direction,
              `close-${t.id}`,
              t.quantity,
              t.pnl,
            ),
          );
      }
      if (p)
        addEntry(p, `${p.direction === 1 ? "BUY" : "SELL"} OPEN`, "entry-open");
      fillReadouts = new Map();
      for (const point of points) {
        const time = Number(point.time);
        fillReadouts.set(time, [
          ...(fillReadouts.get(time) ?? []),
          point.text!.replaceAll("\n", " "),
        ]);
      }
      fillLabels.setMarkers(points, data.candles);
      markers.setMarkers(
        points
          .sort((a, b) => Number(a.time) - Number(b.time))
          .map((m) => ({ ...m, text: undefined, size: 0 })),
      );
      lastTime.current = stamp;
      if (hoverTime === null) {
        const lastCandle = cached.at(-1);
        setLegend(
          legendData(
            cached,
            cached.length - 1,
            undefined,
            lastCandle && studyValues.get(lastCandle.time),
          ),
        );
      }
      if (previousTime === undefined && stamp !== undefined) {
        const index = candleLogical(chart, stamp);
        if (index !== null)
          chart
            .timeScale()
            .setVisibleLogicalRange({
              from: Math.max(0, index - 149),
              to: index + 6,
            });
      } else restoreViewport(chart, viewport, stamp, following.current);
      previousTime = stamp;
      previous = data;
    };
    chart.subscribeCrosshairMove((event) => {
      const c =
        typeof event.time === "number" ? byTime.get(event.time) : undefined;
      const oscillator = c
        ? oscillatorData.find((p) => p.time === c.time)
        : undefined;
      const value = oscillator ?? oscillatorData.at(-1);
      setPaneValues({
        atr: value?.atr ?? null,
        adx: value?.adx ?? null,
        rsi: value?.rsi ?? null,
      });
      setDiValues({ pdi: value?.pdi ?? null, mdi: value?.mdi ?? null });
      hoverTime = c ? c.time : null;
      setLegend(
        c
          ? legendData(
              cached,
              indexByTime.get(c.time) ?? -1,
              fillReadouts.get(c.time),
              studyValues.get(c.time),
            )
          : legendData(
              cached,
              cached.length - 1,
              undefined,
              studyValues.get(cached.at(-1)?.time ?? -1),
            ),
      );
    });
    const stopResize = resizeChart(chart, container.current, () => {
      if (following.current) latest();
    });
    const stopAxis = trackPriceAxis(
      chart,
      price,
      container.current.parentElement ?? container.current,
      () => {
        const last = cached.at(-1);
        const seconds =
          TIMEFRAMES[props.timeframe as keyof typeof TIMEFRAMES] ?? 60;
        return last
          ? {
              price: last.close,
              closeTime: last.time + seconds,
              up: last.close >= last.open,
            }
          : null;
      },
    );
    return () => {
      stopAxis();
      detachDrawings();
      paneResize?.disconnect();
      cancelAnimationFrame(paneFrame);
      updateVisibility.current = () => {};
      updateStrategyVisibility.current = () => {};
      disposed = true;
      abort.abort();
      if (timer) clearTimeout(timer);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(scheduleHistory);
      stopResize();
      changePanels.current = () => {};
      loadEarlier.current = () => {};
      focusOn.current = async () => {};
      update.current = () => {};
      chartRef.current = null;
      patternCandles.current = [];
      chart.remove();
    };
  }, [
    props.sessionId,
    props.showSma,
    props.timeframe,
    props.allowLocalHistory,
    props.loadHistory,
  ]);
  useEffect(() => {
    chartRef.current?.applyOptions({
      localization: chartTimeOptions(timeZone).localization,
      timeScale: chartTimeOptions(timeZone).timeScale,
    });
  }, [timeZone]);
  useEffect(() => {
    update.current(props);
  }, [props]);
  useEffect(() => {
    if (props.focus) void focusOn.current(props.focus);
  }, [props.focus?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    updateVisibility.current();
  }, [hiddenIndicators, hiddenOverlays]);
  useEffect(() => {
    updateStrategyVisibility.current();
  }, [strategyVisible, maHidden]);
  useEffect(() => {
    changePanels.current(selectedIndicators, indicatorConfig);
  }, [
    selectedIndicators,
    indicatorConfig,
    props.sessionId,
    props.showSma,
    props.timeframe,
  ]);
  const canLoadHistory =
    props.allowLocalHistory !== false || !!props.loadHistory;
  return (
    <>

      <ChartTools
        header={props.header}
        endActions={props.toolbarEnd}
        actions={<ChartTimeNavigator timeZone={timeZone} getLatest={()=>props.candles.at(-1)?.time??Date.now()/1000} onSelect={selection=>void focusOn.current(selection)} onCancel={()=>{clearFocus.current();latest();}} busy={loading}/>}
        onAnalyzePattern={() => { holdView(); setPatternSelecting(value => !value); }}
        patternSelecting={patternSelecting}
        chartRef={chartRef}
        onLatest={latest}
        onNavigate={holdView}
        onEarlier={canLoadHistory ? () => loadEarlier.current() : undefined}
        loading={loading}
        hasMore={hasMore}
        showEarlier={canLoadHistory}
        indicators={selectedIndicators}
        onToggleIndicator={toggleIndicator}
        strategyVisible={strategyVisible}
        onToggleStrategy={() => { setMaHidden(false); setStrategyVisible((value) => !value); }}
        follow={follow}
        onFollowChange={setFollow}
      />
      {settingsOpen && (
        <IndicatorSettings
          key={settingsOpen}
          kind={settingsOpen}
          value={indicatorConfig}
          onApply={applyIndicatorConfig}
          onClose={() => setSettingsOpen(null)}
        />
      )}
      {historyError && (
        <p className='chart-history-status error' role='alert'>
          {historyError}{" "}
          <button
            type='button'
            className='text-button'
            onClick={() => loadEarlier.current()}
          >
            Retry
          </button>
        </p>
      )}
      <div className='chart-history-status' role='status'>
        {loading
          ? "Loading earlier candles..."
          : hasMore
            ? (props.historyLabel ?? "Scroll or drag left to load history")
            : "Beginning of available history"}
        <span>
          Pan right for newer candles · Latest returns to the current price
        </span>
      </div>
      <div className='chart-resize with-tools'>
        <PatternRangeAnalyzer active={patternSelecting} onFinish={() => setPatternSelecting(false)} chartRef={chartRef} containerRef={container} getCandles={() => patternCandles.current} timeframe={props.timeframe} symbol={props.symbol ?? 'XAGUSDT'} clock={() => props.indicatorClock}/>
        <DrawingToolbar {...drawing.toolbar} />
        <ChartLegend
          title={`${props.symbol ?? "XAGUSDT"} · ${props.timeframe}`}
          data={legend}
          overlays={[
            ...(strategyVisible
              ? [
                  {
                    key: "trend-sma",
                    name: "MA",
                    params: String(indicatorConfig.trendSmaLength),
                    color: indicatorConfig.trendSmaColor,
                    hidden: maHidden,
                    onToggleVisible: () => setMaHidden((v) => !v),
                    onRemove: () => setStrategyVisible(false),
                    onSettings: () => setSettingsOpen("trendsma"),
                  },
                ]
              : []),
            ...overlayLegends(
              selectedIndicators,
              indicatorConfig,
              hiddenOverlays,
              (kind) => setSettingsOpen(kind),
              toggleIndicator,
              (kind) =>
                setHiddenOverlays((old) => ({ ...old, [kind]: !old[kind] })),
            ),
          ]}
        />
        {!follow && <ScrollToLatest onClick={latest} />}
        {paneHeaders.map(({ kind, top }) => (
          <IndicatorHeader
            key={kind}
            kind={kind}
            top={top}
            config={indicatorConfig}
            value={paneValues[kind]}
            extra={
              kind === "adx" && indicatorConfig.showDi
                ? [
                    { value: diValues.pdi, color: diColors(indicatorConfig).plus },
                    { value: diValues.mdi, color: diColors(indicatorConfig).minus },
                  ]
                : undefined
            }
            hidden={hiddenIndicators[kind]}
            onSettings={() => setSettingsOpen(kind)}
            onVisibility={() =>
              setHiddenIndicators((old) => ({ ...old, [kind]: !old[kind] }))
            }
            onRemove={() => {
              setHiddenIndicators((old) => ({ ...old, [kind]: false }));
              toggleIndicator(kind);
            }}
          />
        ))}
        <div
          ref={container}
          onWheelCapture={holdView}
          onPointerDownCapture={holdView}
          className='chart-container position-chart'
          aria-label={
            props.allowLocalHistory === false
              ? "Live exchange price chart"
              : "Virtual bot price chart with buys, sells, exits and trailing stops"
          }
        />
      </div>
    </>
  );
}

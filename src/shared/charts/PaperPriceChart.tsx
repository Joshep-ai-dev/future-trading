import PriceInsightModal from "./PriceInsightModal";
import {displaySymbol} from './displaySymbol';
import IndicatorHeader from "./IndicatorHeader";
import IndicatorSettings from "./IndicatorSettings";
import { isPaneStudy, settingsKind, useChartStudies, addChartStudy, removeChartStudy, updateChartStudy, type ChartStudy } from "./chartStudies";
import { StudyRenderer, studyLegends, type PaneValue } from "./studyRenderer";
import ChartLegend, {
  legendData,
  type LegendData,
  type StudyValue,
} from "./ChartLegend";
import DrawingToolbar from "./DrawingToolbar";
import { useChartDrawings } from "./drawings";
import { trackPriceAxis } from "./priceAxisCountdown";
import {
  TV,
  tvCandleOptions,
  tvChartOptions,
  tvTimeScaleOptions,
} from "./tvTheme";
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
  LineSeries,
  LineStyle,
  type IChartApi,
  type LogicalRange,
  type UTCTimestamp,
  type SeriesMarker,
} from "lightweight-charts";
import { fillMarker, FillLabels } from "./fillMarkers";
import ChartTools, {
  chartInteraction,
  resizeChart,
  ScrollToLatest,
} from "./ChartTools";
import type { Analysis } from "../types/types";
import type { PaperTrade, Position } from "../../features/trading/PaperTrading";
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
  toolbarActions?: ReactNode;
  sessionId: number;
  showSma: boolean;
  timeframe: string;
  atrLength: number;
  adxLength: number;
  allowLocalHistory?: boolean;
  loadHistory?: (before: number) => Promise<HistoryPage>;
  historyLabel?: string;
  symbol?: string;
  market?: string;
  /** Scroll to this moment (e.g. an economic release); ``key`` changes on every request. */
  focus?: ChartFocus | null;
};
export type ChartFocus = { time: number; label: string; key: number };

const HISTORY_PAGE_SIZE = 2000;

export default function PaperPriceChart(props: Props) {
  const [showingHistoryWindow, setShowingHistoryWindow] = useState(false);
  const [insightOpen, setInsightOpen] = useState(false);
  const [patternSelecting, setPatternSelecting] = useState(false);
  const patternCandles = useRef<Analysis['candles']>([]);
  const container = useRef<HTMLDivElement>(null),
    chartRef = useRef<IChartApi | null>(null);
  const update = useRef<(data: Data) => void>(() => {});
  const studies = useChartStudies();
  const [settingsOpen, setSettingsOpen] = useState<string | null>(null);
  const drawing = useChartDrawings(props.symbol ?? "XAGUSDT");
  const timeZone = useChartTimeZone();
  const timeZoneRef = useRef(timeZone);
  timeZoneRef.current = timeZone;
  const changeStudies = useRef<(list: readonly ChartStudy[]) => void>(() => {});
  const [paneHeaders, setPaneHeaders] = useState<{ id: string; top: number }[]>([]);
  const [paneValues, setPaneValues] = useState<Record<string, PaneValue>>({});
  const retryHistory = useRef<() => void>(() => {});
  const loadEarlier = useRef<() => void>(() => {});
  const restoreLive = useRef<() => void>(() => {});
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
    restoreLive.current();
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
    const detachDrawings = drawing.attach(chart, price, container.current);
    const renderer = new StudyRenderer(chart, price);
    let studyValues = new Map<number, Record<string, StudyValue[]>>();
    const markers = createSeriesMarkers(price, []);
    const focusMarker = createSeriesMarkers(price, []);
    const fillLabels = new FillLabels();
    price.attachPrimitive(fillLabels);
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
        const headers = renderer.panes().flatMap(({ id, series }) => {
          const element = series.getPane().getHTMLElement();
          return element
            ? [{ id, top: element.getBoundingClientRect().top - base + 6 }]
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
        for (const { series } of renderer.panes()) {
          const element = series.getPane().getHTMLElement();
          if (element) paneResize.observe(element);
        }
      });
    }
    const showPaneValues = (time: number | null) => {
      const next = renderer.paneValues(time);
      setPaneValues((old) =>
        JSON.stringify(old) === JSON.stringify(next) ? old : next,
      );
    };
    let studiesDirty = true;
    changeStudies.current = (list) => {
      const viewport = captureViewport(chart, lastTime.current);
      if (!renderer.setStudies(list)) return;
      studiesDirty = true;
      if (latestData) update.current(latestData);
      else showPaneValues(null);
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
    let liveView: { candles: Data["candles"]; indicators: Point[]; more: boolean } | null = null;
    let pending: "earlier" | "later" | null = null;
    let focusing = false,
      more = props.allowLocalHistory !== false || !!props.loadHistory,
      failed = false,
      disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    let previousRange: LogicalRange | null = null;
    let panDirection: "earlier" | "later" | null = null;
    const chartElement = container.current;
    let dragPointer: number | null = null;
    let finishDrag: (() => void) | undefined;
    function startDrag(event: PointerEvent) {
      if (event.isPrimary && event.button === 0) dragPointer = event.pointerId;
    }
    function endDrag(event?: PointerEvent) {
      if (event && event.pointerId !== dragPointer) return;
      dragPointer = null;
      finishDrag?.();
      finishDrag = undefined;
    }
    const cancelDrag = () => endDrag();
    chartElement.addEventListener("pointerdown", startDrag);
    window.addEventListener("pointerup", endDrag, true);
    window.addEventListener("pointercancel", endDrag, true);
    window.addEventListener("blur", cancelDrag);
    const abort = new AbortController();
    setLoading(false);
    setShowingHistoryWindow(false);
    setHasMore(more);
    setHistoryError("");
    function updateLoading(range = chart.timeScale().getVisibleLogicalRange()) {
      const waitingAtEdge = !finishDrag && range && (
        (pending === "earlier" && range.from <= 0) ||
        (pending === "later" && range.to >= cached.length + 5)
      );
      setLoading(focusing || !!waitingAtEdge);
    }
    function waitForDragEnd() {
      return new Promise<void>((resolve) => {
        finishDrag = resolve;
        updateLoading();
      });
    }
    async function earlier() {
      const before = cached[0]?.time;
      if (pending || focusing || !more || before === undefined || !latestData) return;
      const request = focusRequest.current;
      pending = "earlier";
      failed = false;
      updateLoading();
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
                ...(props.market&&props.market!=='xag'?{market:props.market}:{}),
                before,
                limit: HISTORY_PAGE_SIZE,
              }),
            });
        if (dragPointer !== null && !disposed && request === focusRequest.current)
          await waitForDragEnd();
        if (disposed || request !== focusRequest.current || cached[0]?.time !== before) return;
        const older = page.candles.filter((c) => c.time < before);
        cached = older.concat(cached);
        more = page.hasMore && older.length > 0;
        setHasMore(more);
        update.current(latestData);
      } catch (error) {
        if (!disposed && request === focusRequest.current) {
          failed = true;
          retryHistory.current = () => void earlier();
          setHistoryError(`Could not load earlier candles: ${String(error)}`);
        }
      } finally {
        pending = null;
        if (!disposed) {
          updateLoading();
          scheduleHistory();
        }
      }
    }
    async function later() {
      const after = cached.at(-1)?.time;
      const bridge = liveView;
      const before = bridge?.candles[0]?.time ?? latestData?.candles[0]?.time;
      if (pending || focusing || !bridge || after === undefined || before === undefined) return;
      const request = focusRequest.current;
      pending = "later";
      failed = false;
      updateLoading();
      setHistoryError("");
      try {
        const page = await api<HistoryPage>("/api/candles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: abort.signal,
          body: JSON.stringify({
            timeframe: props.timeframe,
            market: props.market ?? "xag",
            after,
            before,
            limit: HISTORY_PAGE_SIZE,
          }),
        });
        if (dragPointer !== null && !disposed && request === focusRequest.current)
          await waitForDragEnd();
        if (disposed || request !== focusRequest.current || !latestData) return;
        cached = cached.concat(page.candles);
        if (!page.hasMore) {
          cached = mergeHistory(cached, bridge.candles);
          indicators = bridge.indicators;
          liveView = null;
          setShowingHistoryWindow(false);
        }
        update.current(latestData);
      } catch (error) {
        if (!disposed && request === focusRequest.current) {
          failed = true;
          retryHistory.current = () => void later();
          setHistoryError(`Could not load newer candles: ${String(error)}`);
        }
      } finally {
        pending = null;
        if (!disposed) {
          updateLoading();
          scheduleHistory();
        }
      }
    }
    function scheduleHistory() {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (disposed || pending || focusing || failed) return;
        const range = chart.timeScale().getVisibleLogicalRange();
        // Logical index zero is the oldest loaded candle. Prefetch before the
        // user reaches the edge so wheel zooming and drag-panning stay fluid.
        if (!range) return;
        const buffer = Math.min(500, Math.max(150, Math.ceil((range.to - range.from) / 2)));
        // Keep another page ready on the side the user is moving toward.
        const nearStart = more &&
          range.from < (panDirection === "earlier" ? HISTORY_PAGE_SIZE : buffer);
        const nearEnd = liveView !== null &&
          range.to >= cached.length - (panDirection === "later" ? HISTORY_PAGE_SIZE : buffer);
        if (nearEnd && (panDirection === "later" || !nearStart)) void later();
        else if (nearStart) void earlier();
      }, 0);
    }
    function onVisibleRangeChange(range: LogicalRange | null) {
      if (range && previousRange && !pending && !focusing && !following.current) {
        const startShift = range.from - previousRange.from;
        const endShift = range.to - previousRange.to;
        if (Math.abs(startShift - endShift) < 0.01 && Math.abs(startShift) > 0.01) {
          panDirection = startShift > 0 ? "later" : "earlier";
        }
      }
      previousRange = range;
      if (pending) updateLoading(range);
      scheduleHistory();
    }
    loadEarlier.current = () => {
      void earlier();
    };
    clearFocus.current = () => { focusRequest.current++; focusMarker.setMarkers([]); };
    restoreLive.current = () => {
      focusRequest.current++;
      panDirection = null;
      focusing = false;
      updateLoading();
      if (!liveView || !latestData) return;
      focusMarker.setMarkers([]);
      ({ candles: cached, indicators, more } = liveView);
      liveView = null;
      setShowingHistoryWindow(false);
      setHasMore(more);
      setHistoryError("");
      chart.timeScale().applyOptions({ fixLeftEdge: !more });
      update.current(latestData);
    };
    focusOn.current = async (focus) => {
      const request = ++focusRequest.current;
      panDirection = null;
      // Capture zoom before loading history, which can change logical indexes.
      const visibleRange = chart.timeScale().getVisibleLogicalRange();
      const span = visibleRange ? visibleRange.to - visibleRange.from : 155;
      const duration = TIMEFRAMES[props.timeframe as keyof typeof TIMEFRAMES];
      const bucket = Math.floor(focus.time / duration) * duration;
      const localHistory = props.allowLocalHistory !== false && !props.loadHistory;
      const needsWindow = localHistory && (bucket < cached[0]?.time ||
        (liveView !== null && bucket > (cached.at(-1)?.time ?? 0)));
      following.current = false;
      setFollow(false);
      failed = false;
      retryHistory.current = () => void focusOn.current(focus);
      focusing = true;
      setLoading(true);
      setHistoryError("");
      try {
        if (needsWindow) {
          const afterBars = Math.min(3000, Math.max(2000, Math.ceil(span / 2)));
          const page = await api<HistoryPage>("/api/candles", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: abort.signal,
            body: JSON.stringify({
              timeframe: props.timeframe,
              market: props.market ?? "xag",
              before: Math.min(
                bucket + (afterBars + 1) * duration,
                (latestData?.candles.at(-1)?.time ?? bucket) + 1,
              ),
              limit: 2000 + afterBars,
            }),
          });
          if (disposed || request !== focusRequest.current) return;
          if (!page.candles.some((c) => c.time === bucket)) {
            setHistoryError("No candles are available for that date.");
            return;
          }
          liveView ??= { candles: cached, indicators, more };
          setShowingHistoryWindow(true);
          cached = page.candles;
          indicators = [];
          more = page.hasMore;
          chart.timeScale().applyOptions({ fixLeftEdge: !more });
        }
        while (props.loadHistory && !disposed && request === focusRequest.current &&
          cached.length && cached[0].time > focus.time - 120 * duration && more) {
          const before = cached[0].time;
          const page = await props.loadHistory(before);
          if (disposed || request !== focusRequest.current) return;
          const older = page.candles.filter((c) => c.time < before);
          cached = mergeHistory(older, cached);
          more = page.hasMore && older.length > 0;
        }
        if (disposed || request !== focusRequest.current || !latestData) return;
        setHasMore(more);
        update.current(latestData);
        const index = cached.findIndex((c) => c.time >= bucket);
        if (index < 0 || cached[0].time > focus.time || cached[index].time !== bucket) {
          setHistoryError("No candles are available for that date.");
          return;
        }
        focusMarker.setMarkers([{ time: cached[index].time as UTCTimestamp, position: "aboveBar", shape: "arrowDown", color: TV.orange, text: focus.label }]);
        chart.timeScale().setVisibleLogicalRange({ from: index - span / 2, to: index + span / 2 });
      } catch (error) {
        if (!disposed && request === focusRequest.current) setHistoryError(`Could not load candles for that date: ${String(error)}`);
      } finally {
        if (!disposed && request === focusRequest.current) {
          focusing = false;
          updateLoading();
          scheduleHistory();
        }
      }
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onVisibleRangeChange);
    let fillReadouts = new Map<number, string[]>();
    update.current = (data) => {
      latestData = data;
      const viewport = captureViewport(chart, previousTime);
      if (!liveView) {
        cached = mergeHistory(cached, data.candles);
        indicators = mergeHistory(indicators, data.indicators);
      }
      patternCandles.current = cached;
      data = { ...data, candles: cached, indicators };
      const stamp = data.candles.at(-1)?.time;
      const duration = TIMEFRAMES[props.timeframe as keyof typeof TIMEFRAMES];
      const candlesChanged = previous?.candles !== data.candles;
      if (candlesChanged) {
        byTime = new Map(data.candles.map((c) => [c.time, c]));
        indexByTime = new Map(data.candles.map((c, index) => [c.time, index]));
        // Live ticks update a bar or two. Apply a history page in one redraw.
        if (previous && data.candles.length <= previous.candles.length + 1 &&
          canAppendCandles(previous.candles, data.candles)) {
          for (const candle of data.candles.slice(previous.candles.length - 1))
            price.update({ ...candle, time: candle.time as UTCTimestamp });
        } else {
          price.setData(data.candles.map((c) => ({ ...c, time: c.time as UTCTimestamp })));
        }
        drawing.setCandles(data.candles, duration);
      }
      const historicalEnd = (stamp ?? 0) + duration;
      if (studiesDirty || candlesChanged || !previous ||
        Math.min(previous.indicatorClock, historicalEnd) !== Math.min(data.indicatorClock, historicalEnd)) {
        const completed = data.candles.filter((c) => c.time + duration <= data.indicatorClock);
        const current = data.candles.filter((c) => c.time <= data.indicatorClock);
        studyValues = renderer.paint({ all: data.candles, current, completed, duration });
        studiesDirty = false;
      }
      if (hoverTime === null) showPaneValues(null);
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
      const timeScale = chart.timeScale();
      if (timeScale.options().fixLeftEdge === more)
        timeScale.applyOptions({ fixLeftEdge: !more });
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
      showPaneValues(c ? c.time : null);
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
      () => setInsightOpen(true),
    );
    return () => {
      stopAxis();
      detachDrawings();
      paneResize?.disconnect();
      cancelAnimationFrame(paneFrame);
      disposed = true;
      chartElement.removeEventListener("pointerdown", startDrag);
      window.removeEventListener("pointerup", endDrag, true);
      window.removeEventListener("pointercancel", endDrag, true);
      window.removeEventListener("blur", cancelDrag);
      endDrag();
      abort.abort();
      if (timer) clearTimeout(timer);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onVisibleRangeChange);
      stopResize();
      changeStudies.current = () => {};
      loadEarlier.current = () => {};
      restoreLive.current = () => {};
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
    changeStudies.current(studies);
  }, [studies, props.sessionId, props.showSma, props.timeframe]);
  const settingsStudy = studies.find((study) => study.id === settingsOpen);
  const canLoadHistory =
    props.allowLocalHistory !== false || !!props.loadHistory;
  return (
    <>
      {insightOpen&&<PriceInsightModal symbol={props.symbol??"XAGUSDT"} timeframe={props.timeframe} getCandles={()=>patternCandles.current} clock={props.indicatorClock} onClose={()=>setInsightOpen(false)}/>}
      <ChartTools
        header={props.header}
        endActions={props.toolbarEnd}
        patternActions={props.toolbarActions}
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
        onAddStudy={addChartStudy}
        follow={follow}
        onFollowChange={setFollow}
      />
      {settingsStudy && (
        <IndicatorSettings
          key={settingsStudy.id}
          kind={settingsKind(settingsStudy.kind)}
          value={settingsStudy.config}
          onApply={(config) => updateChartStudy(settingsStudy.id, { config })}
          onClose={() => setSettingsOpen(null)}
        />
      )}
      {historyError && (
        <p className='chart-history-status error' role='alert'>
          {historyError}{" "}
          <button
            type='button'
            className='text-button'
            onClick={() => retryHistory.current()}
          >
            Retry
          </button>
        </p>
      )}
      <div className='chart-history-status' role='status'>
        {loading
          ? "Loading candles..."
          : hasMore
            ? (props.historyLabel ?? "Scroll or drag left to load history")
            : "Beginning of available history"}
        <span>
          {showingHistoryWindow
            ? "Pan right to load newer candles or turn on Follow to return to the current chart"
            : "Pan right for newer candles or turn on Follow to return to the current chart"}
        </span>
      </div>
      <div className='chart-resize with-tools'>
        <div className='chart-loading-status' role='status'>
          {loading && (
            <div className='chart-loading-badge'>
              <span className='chart-loading-spinner' aria-hidden='true' />
              Loading candles…
            </div>
          )}
        </div>
        <PatternRangeAnalyzer active={patternSelecting} onFinish={() => setPatternSelecting(false)} chartRef={chartRef} containerRef={container} getCandles={() => patternCandles.current} timeframe={props.timeframe} symbol={props.symbol ?? 'XAGUSDT'} clock={() => props.indicatorClock}/>
        <DrawingToolbar {...drawing.toolbar} />
        <ChartLegend
          title={`${displaySymbol(props.symbol ?? "XAGUSDT")} · ${props.timeframe}`}
          data={legend}
          overlays={studyLegends(studies, {
            onSettings: setSettingsOpen,
            onToggleHidden: (id) =>
              updateChartStudy(id, {
                hidden: !studies.find((study) => study.id === id)?.hidden,
              }),
            onRemove: removeChartStudy,
          })}
        />
        {!follow && <ScrollToLatest onClick={latest} />}
        {paneHeaders.map(({ id, top }) => {
          const study = studies.find((item) => item.id === id);
          if (!study || !isPaneStudy(study.kind)) return null;
          const value = paneValues[id];
          return (
            <IndicatorHeader
              key={id}
              kind={study.kind}
              top={top}
              config={study.config}
              value={value?.value ?? null}
              extra={value?.extra}
              hidden={study.hidden}
              onSettings={() => setSettingsOpen(id)}
              onVisibility={() => updateChartStudy(id, { hidden: !study.hidden })}
              onRemove={() => removeChartStudy(id)}
            />
          );
        })}
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

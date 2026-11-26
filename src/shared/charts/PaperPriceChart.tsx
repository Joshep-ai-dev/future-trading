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

export default function PaperPriceChart(props: Props) {
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
    changeStudies.current = (list) => {
      const viewport = captureViewport(chart, lastTime.current);
      if (!renderer.setStudies(list)) return;
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
                ...(props.market&&props.market!=='xag'?{market:props.market}:{}),
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
      // Capture zoom before loading history, which can change logical indexes.
      const visibleRange = chart.timeScale().getVisibleLogicalRange();
      const span = visibleRange ? visibleRange.to - visibleRange.from : 155;
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
            body: JSON.stringify({ timeframe: props.timeframe,
                ...(props.market&&props.market!=='xag'?{market:props.market}:{}), before, limit: 5000 }),
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

      const duration = TIMEFRAMES[props.timeframe as keyof typeof TIMEFRAMES];
      const completed = data.candles.filter(
        (c) => c.time + duration <= data.indicatorClock,
      );
      // Both Pine overlays use the same corrected OHLCV, including the live bar.
      const current = data.candles.filter((c) => c.time <= data.indicatorClock);
      drawing.setCandles(data.candles, duration);
      studyValues = renderer.paint({ all: data.candles, current, completed, duration });
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
      abort.abort();
      if (timer) clearTimeout(timer);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(scheduleHistory);
      stopResize();
      changeStudies.current = () => {};
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

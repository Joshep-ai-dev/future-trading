import {displaySymbol} from './displaySymbol';
import { StopOverlay } from "./StopOverlay";
import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineSeries,
  BaselineSeries,
  LineStyle,
  LineType,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  type SeriesMarker,
} from "lightweight-charts";
import { fillMarker, FillLabels } from "./fillMarkers";
import ChartTools, {
  chartInteraction,
  resizeChart,
  ScrollToLatest,
} from "./ChartTools";
import { captureViewport, restoreViewport } from "./chartViewport";
import {
  chartTimeOptions,
  readChartTimeZone,
  useChartTimeZone,
} from "./chartTimeZone";
import IndicatorSettings from "./IndicatorSettings";
import { isPaneStudy, settingsKind, useChartStudies, addChartStudy, removeChartStudy, updateChartStudy } from "./chartStudies";
import { StudyRenderer, studyLegends, type PaneValue } from "./studyRenderer";
import {
  fmt,
  type Analysis,
  type PeriodResult,
  type Trade,
  type IndicatorPoint,
  type BacktestSettings,
} from "../types/types";
import { chartVolume } from "./chartVolume";
import ChartLegend, {
  legendData,
  type LegendData,
  type LegendOverlay,
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
import IndicatorHeader from "./IndicatorHeader";

export function EquityChart({
  period,
  initialValue = 0,
  trades,
}: {
  period: Pick<PeriodResult, "name">;
  initialValue?: number;
  trades: { pnl: number }[];
}) {
  const fullscreenRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState("");
  async function toggleFullscreen() {
    setFullscreenError("");
    try {
      if (document.fullscreenElement === fullscreenRef.current)
        await document.exitFullscreen();
      else if (fullscreenRef.current?.requestFullscreen)
        await fullscreenRef.current.requestFullscreen();
      else setFullscreenError("Fullscreen is unavailable in this browser.");
    } catch {
      setFullscreenError(
        "The browser blocked fullscreen. Try opening the app in a browser tab.",
      );
    }
  }
  useEffect(() => {
    const changed = () =>
      setFullscreen(document.fullscreenElement === fullscreenRef.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      chartRef.current?.timeScale().fitContent(),
    );
    return () => cancelAnimationFrame(frame);
  }, [fullscreen]);
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const lineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const hasData = useRef(false);
  const tradeLabel = (time: unknown) =>
    Number(time) === 86400
      ? "Start"
      : `Trade #${Math.round(Number(time) / 86400) - 1}`;
  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      autoSize: false,
      ...chartInteraction,
      localization: { timeFormatter: tradeLabel },
      ...tvChartOptions,
      rightPriceScale: {
        scaleMargins: { top: 0.16, bottom: 0.16 },
        borderVisible: false,
      },
      timeScale: {
        ...tvTimeScaleOptions,
        timeVisible: false,
        minBarSpacing: 0.2,
        lockVisibleTimeRangeOnResize: true,
        tickMarkMaxCharacterLength: 5,
        tickMarkFormatter: (time: unknown) =>
          Number(time) === 86400
            ? "Start"
            : `#${Math.round(Number(time) / 86400) - 1}`,
      },
    });
    chartRef.current = chart;
    lineRef.current = chart.addSeries(LineSeries, {
      color: TV.blue,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: true,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
      title: "",
    });
    const stopResize = resizeChart(chart, ref.current, () =>
      chart.timeScale().fitContent(),
    );
    return () => {
      stopResize();
      lineRef.current = null;
      chartRef.current = null;
      hasData.current = false;
      chart.remove();
    };
  }, []);
  useEffect(() => {
    let balance = initialValue;
    const points = [
      { time: 86400 as UTCTimestamp, value: balance },
      ...trades.map((trade, index) => {
        balance += trade.pnl;
        return { time: ((index + 2) * 86400) as UTCTimestamp, value: balance };
      }),
    ];
    lineRef.current?.setData(points);
    if (!hasData.current && trades.length) {
      chartRef.current?.timeScale().fitContent();
      hasData.current = true;
    }
  }, [trades, initialValue]);
  return (
    <div className='balance-chart-shell' ref={fullscreenRef}>
      {fullscreen && (
        <div className='balance-fullscreen-heading'>
          <h2>Balance by trade</h2>
          <span>Press Esc to return</span>
        </div>
      )}
      <ChartTools
        chartRef={chartRef}
        valueLabel='Amount'
        horizontalLabel='Trades'
        fullscreen={fullscreen}
        onFullscreen={() => void toggleFullscreen()}
      />
      {fullscreenError && <p role='alert'>{fullscreenError}</p>}
      <div className='chart-resize equity-resize'>
        <div
          ref={ref}
          className='chart-container equity-chart'
          aria-label={`${period.name} account balance after each closed trade, including trading costs`}
        />
      </div>
    </div>
  );
}

export default function BacktestChart({
  symbol="XAG/USDT",
  candles,
  trades,
  selected,
  onSelect,
  indicators,
  barSeconds,
  timeframe,
  indicatorSettings,
}: {
  symbol?: string;
  indicatorSettings: BacktestSettings;
  indicators: IndicatorPoint[];
  barSeconds: number;
  timeframe: string;
  candles: Analysis["candles"];
  trades: Trade[];
  selected: Trade | null;
  onSelect: (trade: Trade) => void;
}) {
  const timeZone = useChartTimeZone();
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const viewportRef = useRef<{
    dataKey: string;
    selectedId: number | null;
    viewport: ReturnType<typeof captureViewport>;
  } | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const [legend, setLegend] = useState<LegendData | null>(null);
  const studies = useChartStudies();
  const [follow, setFollow] = useState(true);
  const [strategyVisible, setStrategyVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState<string | null>(null);
  const drawing = useChartDrawings(symbol);
  const [paneHeaders, setPaneHeaders] = useState<{ id: string; top: number }[]>([]);
  const [paneValues, setPaneValues] = useState<Record<string, PaneValue>>({});
  function latest() {
    setFollow(true);
    chartRef.current
      ?.timeScale()
      .setVisibleLogicalRange({
        from: Math.max(0, candles.length - 180),
        to: candles.length + 5,
      });
  }
  function holdView() {
    setFollow(false);
  }
  useEffect(() => {
    if (!ref.current || !candles.length) return;
    const dataKey = `${candles.length}:${candles[0]?.time}:${candles.at(-1)?.time}`;
    const saved =
      viewportRef.current?.dataKey === dataKey ? viewportRef.current : null;
    const newlySelected =
      selected !== null && selected.id !== saved?.selectedId;
    const focus = selected
      ? candles.findIndex((c) => c.time >= selected.signalTime)
      : -1;
    const exit = selected
      ? candles.findIndex((c) => c.time >= selected.exitTime)
      : -1;
    const view = candles;
    const chart = createChart(ref.current, {
      autoSize: false,
      ...chartInteraction,
      localization: chartTimeOptions(readChartTimeZone()).localization,
      ...tvChartOptions,
      timeScale: {
        ...tvTimeScaleOptions,
        timeVisible: true,
        minBarSpacing: 0.2,
        lockVisibleTimeRangeOnResize: true,
        ...chartTimeOptions(readChartTimeZone()).timeScale,
      },
    });
    chartRef.current = chart;
    const price = chart.addSeries(CandlestickSeries, {
      ...tvCandleOptions,
      priceFormat: { type: "price", precision: 3, minMove: 0.001 },
    });
    price
      .priceScale()
      .applyOptions({ scaleMargins: { top: 0.06, bottom: 0.1 } });
    price.setData(view.map((c) => ({ ...c, time: c.time as UTCTimestamp })));
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: "",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    volume.setData(chartVolume(view));
    const detachDrawings = drawing.attach(chart, price, ref.current);
    drawing.setCandles(view, barSeconds);
    const renderer = new StudyRenderer(chart, price);
    renderer.setStudies(studies);
    const studyValues = renderer.paint({ all: view, current: view, completed: view, duration: barSeconds });
    setPaneValues(renderer.paneValues(null));
    let paneResize: ResizeObserver | null = null,
      paneFrame = 0;
    const measurePanes = () => {
      const root = ref.current;
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
      measurePanes();
      paneResize = new ResizeObserver(measurePanes);
      if (ref.current) paneResize.observe(ref.current);
      for (const { series } of renderer.panes()) {
        const element = series.getPane().getHTMLElement();
        if (element) paneResize.observe(element);
      }
    });
    if (indicators.length) {
      if (
        !(
          indicatorSettings.strategy === "chartart_v12" ||
          indicatorSettings.strategy === "bb_outer_reversal" ||
          indicatorSettings.strategy === "ml_ensemble" ||
          indicatorSettings.strategy === "ml_directional"
        )
      ) {
        for (const [key, color, title] of [
          ["ema20", "#e0c278", `EMA ${indicatorSettings.ema_fast}`],
          ["ema50", "#88bfff", `EMA ${indicatorSettings.ema_slow}`],
        ] as const) {
          chart
            .addSeries(LineSeries, {
              color,
              lineWidth: 1,
              title,
              visible: strategyVisible,
              priceLineVisible: false,
              lastValueVisible: false,
            })
            .setData(
              indicators.map((p) =>
                p[key] === null
                  ? { time: p.time as UTCTimestamp }
                  : { time: p.time as UTCTimestamp, value: p[key] },
              ),
            );
        }
      }
      if (
        (indicatorSettings.strategy === "bb_outer_reversal" &&
          indicatorSettings.bb_reversal.use_sma_trend_adjustment !== false) ||
        indicatorSettings.strategy === "ml_ensemble" ||
        indicatorSettings.strategy === "ml_directional"
      ) {
        chart
          .addSeries(LineSeries, {
            color: TV.orange,
            lineWidth: 2,
            title:
              indicatorSettings.strategy === "ml_ensemble"
                ? "EMA 50"
                : indicatorSettings.strategy === "ml_directional"
                  ? "EMA 200"
                  : "Trend SMA",
            visible: strategyVisible,
            priceLineVisible: false,
            lastValueVisible: false,
          })
          .setData(
            indicators.map((p) =>
              p.trendSma == null
                ? { time: p.time as UTCTimestamp }
                : { time: p.time as UTCTimestamp, value: p.trendSma },
            ),
          );
      }
      // Legacy strategy RSI pane: only when the run produced RSI values (ADX + Supertrend does not).
      if (
        indicatorSettings.strategy !== "bb_outer_reversal" &&
        indicatorSettings.strategy !== "ml_ensemble" &&
        indicatorSettings.strategy !== "ml_directional" &&
        (indicatorSettings.strategy !== "mtf" || indicatorSettings.rsi_active) &&
        indicators.some((p) => p.rsi20 != null)
      ) {
        const rsi = chart.addSeries(
          LineSeries,
          {
            color: TV.purple,
            lineWidth: 1,
            title: `RSI ${indicatorSettings.rsi_period}`,
            priceLineVisible: false,
            autoscaleInfoProvider: () => ({
              priceRange: { minValue: 0, maxValue: 100 },
            }),
          },
          chart.panes().length,
        );
        rsi.setData(
          indicators.map((p) =>
            p.rsi20 === null
              ? { time: p.time as UTCTimestamp }
              : { time: p.time as UTCTimestamp, value: p.rsi20 },
          ),
        );
        rsi.createPriceLine({
          price: indicatorSettings.rsi_threshold,
          color: TV.muted,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: String(indicatorSettings.rsi_threshold),
        });
        chart.panes().forEach((pane, index) => pane.setStretchFactor(index === 0 ? 3 : 1));
        rsi
          .priceScale()
          .applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } });
      }
    }
    const present = new Set(view.map((c) => c.time));
    const visibleTrades = trades.filter(
      (t) => present.has(t.entryTime) || present.has(t.exitTime),
    );
    const markers: SeriesMarker<UTCTimestamp>[] = [];
    for (const t of visibleTrades) {
      if (present.has(t.entryTime))
        markers.push(
          fillMarker(
            t.entryTime,
            t.entry,
            `${t.direction === 1 ? "BUY" : "SELL"} #${t.id}`,
            "entry",
            t.direction,
            `entry-${t.id}`,
            t.quantity,
          ),
        );
      if (present.has(t.exitTime))
        markers.push(
          fillMarker(
            t.exitTime,
            t.exit,
            `CLOSE #${t.id}`,
            "close",
            t.direction,
            `close-${t.id}`,
            t.quantity,
            t.netPnl,
          ),
        );
    }
    if (selected && present.has(selected.signalTime))
      markers.push({
        time: selected.signalTime as UTCTimestamp,
        position: selected.direction === 1 ? "belowBar" : "aboveBar",
        shape: "square",
        color: "#e0c278",
        text: selected.signalLabel ? "SIGNAL" : "SWEEP",
      });
    if (selected?.exitSignal && present.has(selected.exitSignal.time))
      markers.push({
        time: selected.exitSignal.time as UTCTimestamp,
        position: "aboveBar",
        shape: "square",
        color: "#be9bf3",
        text: "CLOSE SIGNAL",
      });
    const fillLabels = new FillLabels();
    price.attachPrimitive(fillLabels);
    fillLabels.setMarkers(markers, view);
    createSeriesMarkers(
      price,
      markers
        .sort((a, b) => Number(a.time) - Number(b.time))
        .map((m) =>
          m.price === undefined ? m : { ...m, text: undefined, size: 0 },
        ),
    );
    if (
      selected &&
      selected.stop !== null &&
      selected.target !== null &&
      present.has(selected.entryTime)
    ) {
      const from = selected.entryTime as UTCTimestamp;
      const to = Math.max(
        selected.exitTime,
        selected.entryTime + barSeconds,
      ) as UTCTimestamp;
      for (const [label, value, color] of [
        ["Entry", selected.entry, TV.blue],
        ["Target 2R", selected.target, TV.up],
      ] as const) {
        const line = chart.addSeries(LineSeries, {
          color,
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          title: label,
          priceLineVisible: false,
          lastValueVisible: true,
          priceFormat: { type: "price", precision: 3, minMove: 0.001 },
        });
        line.setData([
          { time: from, value },
          { time: to, value },
        ]);
      }
      const history = selected.stopHistory?.length
        ? selected.stopHistory
        : [
            {
              time: selected.entryTime,
              price: selected.stop,
              reason: "initial",
            },
          ];
      const stopPoints = new Map(
        history
          .filter((h) => h.time <= selected.exitTime)
          .map((h) => [h.time, h.price]),
      );
      stopPoints.set(Number(to), selected.finalStop ?? selected.stop);
      chart
        .addSeries(LineSeries, {
          color: TV.down,
          lineWidth: 2,
          lineType: LineType.WithSteps,
          title: "Active stop",
          priceLineVisible: false,
          priceFormat: { type: "price", precision: 3, minMove: 0.001 },
        })
        .setData(
          [...stopPoints]
            .sort((a, b) => a[0] - b[0])
            .map(([time, value]) => ({ time: time as UTCTimestamp, value })),
        );
      for (const [value, color] of [
        [selected.target, "rgba(8,153,129,0.16)"],
        [selected.stop, "rgba(242,54,69,0.16)"],
      ] as const) {
        chart
          .addSeries(BaselineSeries, {
            baseValue: { type: "price", price: selected.entry },
            topFillColor1: color,
            topFillColor2: color,
            bottomFillColor1: color,
            bottomFillColor2: color,
            topLineColor: "transparent",
            bottomLineColor: "transparent",
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          })
          .setData([
            { time: from, value },
            { time: to, value },
          ]);
      }
      if (selected.sweepLevel !== null) {
        const sweep = chart.addSeries(LineSeries, {
          color: "#e0c278",
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          title: "Swept level",
          priceLineVisible: false,
          lastValueVisible: false,
        });
        sweep.setData([
          {
            time: selected.signalTime as UTCTimestamp,
            value: selected.sweepLevel,
          },
          { time: to, value: selected.sweepLevel },
        ]);
      }
    }
    if (
      selected &&
      selected.target === null &&
      present.has(selected.entryTime)
    ) {
      chart
        .addSeries(LineSeries, {
          color: TV.blue,
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          title: "Entry",
          priceLineVisible: false,
        })
        .setData([
          { time: selected.entryTime as UTCTimestamp, value: selected.entry },
          {
            time: Math.max(
              selected.exitTime,
              selected.entryTime + barSeconds,
            ) as UTCTimestamp,
            value: selected.entry,
          },
        ]);
    }
    const stopOverlay = new StopOverlay();
    price.attachPrimitive(stopOverlay);
    stopOverlay.setPaths(
      visibleTrades
        .filter((t) => t.target === null && t.stop !== null)
        .map((t) => ({
          from: t.entryTime,
          to: t.exitTime,
          history: t.stopHistory ?? [
            { time: t.entryTime, price: t.stop!, reason: "initial" },
          ],
        })),
      view[0]?.time,
      view.at(-1)?.time,
    );
    const fillReadouts = new Map<number, string[]>();
    for (const marker of markers.filter((m) => m.price !== undefined)) {
      const time = Number(marker.time);
      fillReadouts.set(time, [
        ...(fillReadouts.get(time) ?? []),
        marker.text!.replaceAll("\n", " "),
      ]);
    }
    const byTime = new Map(view.map((c) => [c.time, c]));
    const indicatorByTime = new Map(indicators.map((p) => [p.time, p]));
    const indexByTime = new Map(view.map((c, index) => [c.time, index]));
    const extrasFor = (time: number) => {
      const indicator = indicatorByTime.get(time);
      return [
        ...(indicatorSettings.strategy === "bb_outer_reversal" && indicator
          ? [
              `ADX ${fmt(indicator.adx ?? null)} · ATR ${fmt(indicator.atr ?? null, 3)} · BB width ${fmt(indicator.bbWidthPct ?? null)}%`,
            ]
          : []),
        ...(fillReadouts.get(time) ?? []),
      ];
    };
    const lastTime = view.at(-1)!.time;
    setLegend(
      legendData(view, view.length - 1, extrasFor(lastTime), studyValues.get(lastTime)),
    );
    chart.subscribeCrosshairMove((p) => {
      const c = typeof p.time === "number" ? byTime.get(p.time) : undefined;
      const hovered = c ? c.time : null;
      setPaneValues(renderer.paneValues(hovered));
      const time = c ? c.time : view.at(-1)!.time;
      setLegend(
        legendData(
          view,
          indexByTime.get(time) ?? -1,
          extrasFor(time),
          studyValues.get(time),
        ),
      );
    });
    chart.subscribeClick((p) => {
      const trade =
        visibleTrades.find(
          (t) =>
            p.hoveredObjectId === `entry-${t.id}` ||
            p.hoveredObjectId === `close-${t.id}`,
        ) ??
        visibleTrades.find(
          (t) => t.entryTime === p.time || t.exitTime === p.time,
        );
      if (trade) onSelectRef.current(trade);
    });
    const stopResize = resizeChart(chart, ref.current, () => {
      if (newlySelected && focus >= 0)
        chart
          .timeScale()
          .setVisibleLogicalRange({
            from: Math.max(0, focus - 70),
            to: Math.min(candles.length + 5, Math.max(focus + 100, exit + 35)),
          });
      else if (saved)
        restoreViewport(chart, saved.viewport, view.at(-1)?.time, false);
      else
        chart
          .timeScale()
          .setVisibleLogicalRange({
            from: Math.max(0, view.length - 180),
            to: view.length + 5,
          });
    });
    const stopAxis = trackPriceAxis(
      chart,
      price,
      ref.current.parentElement ?? ref.current,
    );
    return () => {
      viewportRef.current = {
        dataKey,
        selectedId: selected?.id ?? null,
        viewport: captureViewport(chart, view.at(-1)?.time),
      };
      paneResize?.disconnect();
      cancelAnimationFrame(paneFrame);
      setPaneHeaders([]);
      stopResize();
      stopAxis();
      detachDrawings();
      chartRef.current = null;
      chart.remove();
    };
  }, [
    candles,
    trades,
    selected,
    indicators,
    barSeconds,
    indicatorSettings,
    studies,
    strategyVisible,
  ]);
  useEffect(() => {
    const options = chartTimeOptions(timeZone);
    chartRef.current?.applyOptions({
      localization: options.localization,
      timeScale: options.timeScale,
    });
  }, [timeZone]);
  const settingsStudy = studies.find((study) => study.id === settingsOpen);
  const trendOverlayName =
    indicatorSettings.strategy === "ml_directional"
      ? "EMA 200"
      : indicatorSettings.strategy === "ml_ensemble"
        ? "EMA 50"
        : indicatorSettings.strategy === "bb_outer_reversal" &&
            indicatorSettings.bb_reversal.use_sma_trend_adjustment !== false
          ? "Trend SMA"
          : "";
  return (
    <>
      <ChartTools
        chartRef={chartRef}
        endLabel='Latest'
        onLatest={latest}
        onNavigate={holdView}
        showEarlier
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
      <div className='chart-history-status' role='status'>
        All candles in this backtest are loaded
        <span>Latest returns to the end of the test period</span>
      </div>
      <div className='chart-resize with-tools'>
        <DrawingToolbar {...drawing.toolbar} />
        <ChartLegend
          title={`${displaySymbol(symbol)} · ${timeframe}`}
          data={legend}
          overlays={[
            ...(trendOverlayName
              ? [
                  {
                    key: "trend",
                    name: trendOverlayName,
                    params: "",
                    color: TV.orange,
                    hidden: !strategyVisible,
                    onToggleVisible: () => setStrategyVisible((v) => !v),
                  } satisfies LegendOverlay,
                ]
              : []),
            ...studyLegends(studies, {
              onSettings: setSettingsOpen,
              onToggleHidden: (id) =>
                updateChartStudy(id, {
                  hidden: !studies.find((study) => study.id === id)?.hidden,
                }),
              onRemove: removeChartStudy,
            }),
          ]}
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
          ref={ref}
          className='chart-container position-chart'
          aria-label={`${timeframe} trade positions, indicators, entries, exits, stop and target zones`}
        />
      </div>
    </>
  );
}

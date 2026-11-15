import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  IChartApi,
  IPrimitivePaneRenderer,
  ISeriesApi,
  ISeriesPrimitive,
  ISeriesPrimitiveAxisView,
  Logical,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";
import { TV } from "./tvTheme";

export type DrawingTool =
  | "cursor"
  | "trend"
  | "ray"
  | "hline"
  | "hray"
  | "vline"
  | "rect"
  | "fib"
  | "measure";
export type Anchor = { time: number; price: number };
export type Drawing = {
  id: string;
  tool: Exclude<DrawingTool, "cursor">;
  points: Anchor[];
  color: string;
};
type Candle = { time: number; open: number; high: number; low: number; close: number };

const ONE_POINT = new Set<DrawingTool>(["hline", "hray", "vline"]);
const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIB_COLORS = ["#787b86", "#f23645", "#ff9800", "#4caf50", "#089981", "#00bcd4", "#787b86"];
const DRAW_COLOR = TV.blue;
// randomUUID needs a secure context; LAN (http) access does not have one.
const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/* ---------- persistence: one drawing list per symbol ------------------- */
const storageKey = (symbol: string) => `silver.chart.drawings.${symbol}`;
const changed = "silver:chart-drawings-changed";
const cache = new Map<string, Drawing[]>();
function readDrawings(symbol: string): Drawing[] {
  const hit = cache.get(symbol);
  if (hit) return hit;
  let list: Drawing[] = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(symbol)) ?? "[]");
    if (Array.isArray(parsed))
      list = parsed.filter(
        (d) =>
          d &&
          typeof d.id === "string" &&
          Array.isArray(d.points) &&
          d.points.every(
            (p: Anchor) => Number.isFinite(p?.time) && Number.isFinite(p?.price),
          ),
      );
  } catch {
    /* Corrupt or blocked storage: start with no drawings. */
  }
  cache.set(symbol, list);
  return list;
}
function writeDrawings(symbol: string, list: Drawing[]) {
  cache.set(symbol, list);
  try {
    localStorage.setItem(storageKey(symbol), JSON.stringify(list));
  } catch {
    /* Keep drawings for this session. */
  }
  window.dispatchEvent(new Event(changed));
}
function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key?.startsWith("silver.chart.drawings.") || event.key === null) {
      cache.clear();
      listener();
    }
  };
  window.addEventListener(changed, listener);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(changed, listener);
    window.removeEventListener("storage", storage);
  };
}

/* ---------- geometry helpers ------------------------------------------ */
function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax,
    dy = by - ay,
    length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function extend(ax: number, ay: number, bx: number, by: number, width: number) {
  if (bx === ax) return { x: bx, y: by > ay ? 1e5 : -1e5 };
  const direction = bx > ax ? 1 : -1,
    x = direction > 0 ? width : 0;
  return { x, y: ay + ((by - ay) * (x - ax)) / (bx - ax) };
}

/* ---------- canvas layer ------------------------------------------------ */
export class DrawingLayer implements ISeriesPrimitive<Time> {
  private host: SeriesAttachedParameter<Time> | null = null;
  drawings: Drawing[] = [];
  preview: Drawing | null = null;
  selected: string | null = null;
  hidden = false;
  private times: number[] = [];
  private bar = 60;
  candles: Candle[] = [];

  attached(host: SeriesAttachedParameter<Time>) {
    this.host = host;
  }
  detached() {
    this.host = null;
  }
  update() {
    this.host?.requestUpdate();
  }
  setCandles(candles: Candle[], barSeconds: number) {
    this.candles = candles;
    this.times = candles.map((c) => c.time);
    this.bar = barSeconds;
    this.update();
  }
  timeToLogical(time: number): number | null {
    const t = this.times;
    if (!t.length) return null;
    if (time <= t[0]) return (time - t[0]) / this.bar;
    const last = t.length - 1;
    if (time >= t[last]) return last + (time - t[last]) / this.bar;
    let lo = 0,
      hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (t[mid] <= time) lo = mid;
      else hi = mid;
    }
    return lo + (time - t[lo]) / (t[hi] - t[lo]);
  }
  logicalToTime(logical: number): number | null {
    const t = this.times;
    if (!t.length) return null;
    const last = t.length - 1;
    if (logical <= 0) return t[0] + logical * this.bar;
    if (logical >= last) return t[last] + (logical - last) * this.bar;
    const lo = Math.floor(logical);
    return t[lo] + (logical - lo) * (t[lo + 1] - t[lo]);
  }
  x(time: number) {
    const logical = this.timeToLogical(time);
    return logical === null || !this.host
      ? null
      : this.host.chart.timeScale().logicalToCoordinate(logical as Logical);
  }
  y(price: number) {
    return this.host?.series.priceToCoordinate(price) ?? null;
  }
  toAnchor(x: number, y: number, magnet: boolean): Anchor | null {
    const host = this.host;
    if (!host) return null;
    const logical = host.chart.timeScale().coordinateToLogical(x);
    const price = host.series.coordinateToPrice(y);
    if (logical === null || price === null) return null;
    const index = Math.round(logical);
    const candle = this.candles[index];
    if (magnet && candle) {
      const prices = [candle.open, candle.high, candle.low, candle.close];
      const nearest = prices.reduce((a, b) => (Math.abs(b - price) < Math.abs(a - price) ? b : a));
      return { time: candle.time, price: nearest };
    }
    const snapped = Math.abs(logical - index) < 0.5 ? index : logical;
    const time = this.logicalToTime(snapped);
    return time === null ? null : { time, price };
  }
  /** Returns the drawing id under the point and which anchor (or -1 for the body). */
  hit(px: number, py: number, width: number, height: number): { id: string; anchor: number } | null {
    if (this.hidden) return null;
    for (const d of [...this.drawings].reverse()) {
      const pts = d.points.map((p) => ({ x: this.x(p.time), y: this.y(p.price) }));
      if (pts.some((p) => p.x === null || p.y === null)) continue;
      const p = pts as { x: number; y: number }[];
      const anchor = p.findIndex((a) => Math.hypot(a.x - px, a.y - py) < 7);
      if (anchor >= 0 && d.id === this.selected) return { id: d.id, anchor };
      let distance = Infinity;
      if (d.tool === "hline") distance = Math.abs(py - p[0].y);
      else if (d.tool === "hray") distance = px >= p[0].x - 4 ? Math.abs(py - p[0].y) : Infinity;
      else if (d.tool === "vline") distance = Math.abs(px - p[0].x);
      else if (d.tool === "trend") distance = segmentDistance(px, py, p[0].x, p[0].y, p[1].x, p[1].y);
      else if (d.tool === "ray") {
        const end = extend(p[0].x, p[0].y, p[1].x, p[1].y, width);
        distance = segmentDistance(px, py, p[0].x, p[0].y, end.x, end.y);
      } else {
        const left = Math.min(p[0].x, p[1].x),
          right = Math.max(p[0].x, p[1].x),
          top = Math.min(p[0].y, p[1].y),
          bottom = Math.max(p[0].y, p[1].y);
        const inside = px >= left - 4 && px <= right + 4 && py >= top - 4 && py <= bottom + 4;
        distance = inside ? 0 : Infinity;
      }
      if (distance < 6 && py <= height) return { id: d.id, anchor: -1 };
    }
    return null;
  }

  private renderer: IPrimitivePaneRenderer = {
    draw: (target) =>
      target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
        if (this.hidden && !this.preview) return;
        const list = [...(this.hidden ? [] : this.drawings), ...(this.preview ? [this.preview] : [])];
        ctx.save();
        ctx.font = `12px ${TV.font}`;
        for (const d of list) this.paint(ctx, d, mediaSize.width, mediaSize.height);
        ctx.restore();
      }),
  };
  private paint(ctx: CanvasRenderingContext2D, d: Drawing, width: number, height: number) {
    const pts = d.points.map((p) => ({ x: this.x(p.time), y: this.y(p.price) }));
    if (pts.some((p) => p.x === null || p.y === null)) return;
    const p = pts as { x: number; y: number }[];
    const selected = d.id === this.selected || d === this.preview;
    ctx.strokeStyle = d.color;
    ctx.fillStyle = d.color;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    const line = (ax: number, ay: number, bx: number, by: number) => {
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    };
    switch (d.tool) {
      case "hline":
        line(0, p[0].y, width, p[0].y);
        break;
      case "hray":
        line(p[0].x, p[0].y, width, p[0].y);
        break;
      case "vline":
        line(p[0].x, 0, p[0].x, height);
        break;
      case "trend":
        if (p[1]) line(p[0].x, p[0].y, p[1].x, p[1].y);
        break;
      case "ray":
        if (p[1]) {
          const end = extend(p[0].x, p[0].y, p[1].x, p[1].y, width);
          line(p[0].x, p[0].y, end.x, end.y);
        }
        break;
      case "rect":
        if (p[1]) {
          ctx.globalAlpha = 0.2;
          ctx.fillRect(p[0].x, p[0].y, p[1].x - p[0].x, p[1].y - p[0].y);
          ctx.globalAlpha = 1;
          ctx.strokeRect(p[0].x, p[0].y, p[1].x - p[0].x, p[1].y - p[0].y);
        }
        break;
      case "fib":
        if (p[1]) {
          const left = Math.min(p[0].x, p[1].x),
            right = Math.max(p[0].x, p[1].x);
          const [a, b] = d.points;
          FIB_LEVELS.forEach((level, index) => {
            const price = b.price + (a.price - b.price) * level;
            const y = this.y(price);
            if (y === null) return;
            const next = FIB_LEVELS[index + 1];
            const nextY = next === undefined ? null : this.y(b.price + (a.price - b.price) * next);
            if (nextY !== null) {
              ctx.globalAlpha = 0.12;
              ctx.fillStyle = FIB_COLORS[index + 1];
              ctx.fillRect(left, y, right - left, nextY - y);
              ctx.globalAlpha = 1;
            }
            ctx.strokeStyle = ctx.fillStyle = FIB_COLORS[index];
            line(left, y, right, y);
            ctx.textAlign = "right";
            ctx.textBaseline = "middle";
            ctx.fillText(`${level} (${price.toFixed(3)})`, left - 4, y);
          });
          ctx.strokeStyle = "#787b86";
          ctx.setLineDash([4, 4]);
          line(p[0].x, p[0].y, p[1].x, p[1].y);
          ctx.setLineDash([]);
        }
        break;
      case "measure":
        if (p[1]) {
          const [a, b] = d.points;
          const up = b.price >= a.price;
          const color = up ? TV.blue : TV.down;
          ctx.fillStyle = color;
          ctx.globalAlpha = 0.2;
          ctx.fillRect(p[0].x, p[0].y, p[1].x - p[0].x, p[1].y - p[0].y);
          ctx.globalAlpha = 1;
          ctx.strokeStyle = color;
          const midX = (p[0].x + p[1].x) / 2,
            midY = (p[0].y + p[1].y) / 2;
          line(midX, p[0].y, midX, p[1].y);
          line(p[0].x, midY, p[1].x, midY);
          const la = this.timeToLogical(a.time) ?? 0,
            lb = this.timeToLogical(b.time) ?? 0;
          const change = b.price - a.price;
          const text = [
            `${change >= 0 ? "" : "−"}${Math.abs(change).toFixed(3)} (${((change / a.price) * 100).toFixed(2)}%)`,
            `${Math.round(lb - la)} bars, ${duration(Math.abs(b.time - a.time))}`,
          ];
          const boxWidth = Math.max(...text.map((t) => ctx.measureText(t).width)) + 16;
          const boxY = up ? Math.min(p[0].y, p[1].y) - 44 : Math.max(p[0].y, p[1].y) + 6;
          ctx.fillStyle = color;
          ctx.fillRect(midX - boxWidth / 2, boxY, boxWidth, 38);
          ctx.fillStyle = "#fff";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          text.forEach((t, i) => ctx.fillText(t, midX, boxY + 11 + i * 16));
        }
        break;
    }
    if (selected)
      for (const point of p) {
        ctx.beginPath();
        ctx.arc(point.x, point.y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = TV.background;
        ctx.fill();
        ctx.strokeStyle = d.color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
  }
  private view = { renderer: () => this.renderer };
  paneViews() {
    return [this.view];
  }
  /** Horizontal lines and rays show their price on the axis, like TradingView. */
  priceAxisViews(): ISeriesPrimitiveAxisView[] {
    if (this.hidden) return [];
    return [...this.drawings, ...(this.preview ? [this.preview] : [])]
      .filter((d) => d.tool === "hline" || d.tool === "hray")
      .map((d) => ({
        coordinate: () => this.y(d.points[0].price) ?? -100,
        text: () => d.points[0].price.toFixed(3),
        textColor: () => "#ffffff",
        backColor: () => d.color,
        visible: () => this.y(d.points[0].price) !== null,
      }));
  }
}

function duration(seconds: number) {
  const d = Math.floor(seconds / 86400),
    h = Math.floor((seconds % 86400) / 3600),
    m = Math.round((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

/* ---------- React hook: state + chart wiring ------------------------- */
export function useChartDrawings(symbol: string) {
  const drawings = useSyncExternalStore(
    subscribe,
    () => readDrawings(symbol),
    () => [] as Drawing[],
  );
  const [tool, setToolState] = useState<DrawingTool>("cursor");
  const [magnet, setMagnet] = useState(false);
  const [locked, setLocked] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const layerRef = useRef<DrawingLayer | null>(null);
  const state = useRef({ tool, magnet, locked, hidden, selected, drawings, symbol });
  state.current = { tool, magnet, locked, hidden, selected, drawings, symbol };
  const chartRef = useRef<IChartApi | null>(null);

  const setTool = useCallback((next: DrawingTool) => {
    setToolState(next);
    const layer = layerRef.current;
    if (layer) {
      layer.preview = null;
      layer.update();
    }
    chartRef.current?.applyOptions({
      handleScroll: { pressedMouseMove: next === "cursor" },
    });
  }, []);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.drawings = drawings;
    layer.hidden = hidden;
    layer.selected = selected;
    layer.update();
  }, [drawings, hidden, selected]);

  const save = useCallback((list: Drawing[]) => writeDrawings(state.current.symbol, list), []);
  const removeSelected = useCallback(() => {
    const id = state.current.selected;
    if (!id || state.current.locked) return;
    save(state.current.drawings.filter((d) => d.id !== id));
    setSelected(null);
  }, [save]);
  const clear = useCallback(() => {
    save([]);
    setSelected(null);
  }, [save]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const shortcut = event.altKey ? ({ t: "trend", h: "hline", v: "vline" } as const)[event.key.toLowerCase() as "t" | "h" | "v"] : undefined;
      if (shortcut) {
        event.preventDefault();
        setTool(shortcut);
      } else if (event.key === "Escape") {
        setSelected(null);
        setTool("cursor");
      } else if ((event.key === "Delete" || event.key === "Backspace") && state.current.selected) {
        event.preventDefault();
        removeSelected();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [removeSelected, setTool]);

  /** Call inside the chart effect; returns the cleanup. */
  const attach = useCallback(
    (chart: IChartApi, series: ISeriesApi<SeriesType>, element: HTMLElement) => {
      const layer = new DrawingLayer();
      layer.drawings = state.current.drawings;
      layer.hidden = state.current.hidden;
      layer.selected = state.current.selected;
      series.attachPrimitive(layer);
      layerRef.current = layer;
      chartRef.current = chart;
      chart.applyOptions({ handleScroll: { pressedMouseMove: state.current.tool === "cursor" } });
      let drag: { id: string; anchor: number; start: Anchor; original: Anchor[] } | null = null;
      const local = (event: PointerEvent) => {
        const rect = element.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
      };
      const mainHeight = () => chart.panes()[0]?.getHeight() ?? element.clientHeight;
      const plotWidth = () => element.clientWidth - chart.priceScale("right").width();
      const finish = (drawing: Drawing) => {
        save([...state.current.drawings, drawing]);
        layer.preview = null;
        setSelected(drawing.id);
        setTool("cursor");
      };
      const down = (event: PointerEvent) => {
        if (event.button !== 0) return;
        const { x, y } = local(event);
        if (y > mainHeight() || x > plotWidth()) return;
        const s = state.current;
        if (s.tool !== "cursor") {
          const anchor = layer.toAnchor(x, y, s.magnet);
          if (!anchor) return;
          event.stopPropagation();
          if (ONE_POINT.has(s.tool)) {
            finish({ id: newId(), tool: s.tool as Drawing["tool"], points: [anchor], color: DRAW_COLOR });
          } else if (!layer.preview) {
            layer.preview = { id: "preview", tool: s.tool as Drawing["tool"], points: [anchor, anchor], color: DRAW_COLOR };
            layer.update();
          } else {
            finish({ ...layer.preview, id: newId(), points: [layer.preview.points[0], anchor] });
          }
          return;
        }
        const hit = layer.hit(x, y, plotWidth(), mainHeight());
        setSelected(hit?.id ?? null);
        layer.selected = hit?.id ?? null;
        layer.update();
        if (!hit || s.locked) return;
        const start = layer.toAnchor(x, y, false);
        const drawing = s.drawings.find((d) => d.id === hit.id);
        if (!start || !drawing) return;
        drag = { id: hit.id, anchor: hit.anchor, start, original: drawing.points };
        chart.applyOptions({ handleScroll: false, handleScale: false });
        element.setPointerCapture(event.pointerId);
        event.stopPropagation();
      };
      const move = (event: PointerEvent) => {
        const { x, y } = local(event);
        const s = state.current;
        if (layer.preview) {
          const anchor = layer.toAnchor(x, y, s.magnet);
          if (anchor) {
            layer.preview = { ...layer.preview, points: [layer.preview.points[0], anchor] };
            layer.update();
          }
          return;
        }
        if (!drag) {
          const over = s.tool === "cursor" && layer.hit(x, y, plotWidth(), mainHeight());
          element.style.cursor = s.tool !== "cursor" ? "crosshair" : over ? "pointer" : "";
          return;
        }
        const now = layer.toAnchor(x, y, s.magnet && drag.anchor >= 0);
        if (!now) return;
        const startLogical = layer.timeToLogical(drag.start.time) ?? 0;
        const nowLogical = layer.timeToLogical(now.time) ?? 0;
        const shift = (p: Anchor) => {
          const l = layer.timeToLogical(p.time) ?? 0;
          return { time: layer.logicalToTime(l + nowLogical - startLogical) ?? p.time, price: p.price + now.price - drag!.start.price };
        };
        const points = drag.anchor >= 0
          ? drag.original.map((p, i) => (i === drag!.anchor ? now : p))
          : drag.original.map(shift);
        layer.drawings = layer.drawings.map((d) => (d.id === drag!.id ? { ...d, points } : d));
        layer.update();
      };
      const up = (event: PointerEvent) => {
        if (!drag) return;
        if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
        drag = null;
        save(layer.drawings);
        chart.applyOptions({
          handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
          handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: { time: true, price: true }, axisDoubleClickReset: { time: true, price: true } },
        });
      };
      element.addEventListener("pointerdown", down, true);
      element.addEventListener("pointermove", move);
      element.addEventListener("pointerup", up);
      element.addEventListener("pointercancel", up);
      return () => {
        element.removeEventListener("pointerdown", down, true);
        element.removeEventListener("pointermove", move);
        element.removeEventListener("pointerup", up);
        element.removeEventListener("pointercancel", up);
        if (layerRef.current === layer) layerRef.current = null;
        if (chartRef.current === chart) chartRef.current = null;
      };
    },
    [save, setTool],
  );
  const setCandles = useCallback((candles: Candle[], barSeconds: number) => {
    layerRef.current?.setCandles(candles, barSeconds);
  }, []);

  return {
    attach,
    setCandles,
    toolbar: {
      tool,
      setTool,
      magnet,
      setMagnet,
      locked,
      setLocked,
      hidden,
      setHidden,
      count: drawings.length,
      selected,
      removeSelected,
      clear,
    },
  };
}
export type DrawingToolbarProps = ReturnType<typeof useChartDrawings>["toolbar"];

import type { IChartApi, ISeriesApi, SeriesType } from "lightweight-charts";
import { TV } from "./tvTheme";

export type CountdownSource = () => {
  price: number;
  closeTime: number;
  up: boolean;
} | null;

export function formatCountdown(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400),
    h = Math.floor((s % 86400) / 3600),
    m = Math.floor((s % 3600) / 60),
    sec = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  if (d) return `${d}d ${h}h`;
  return h ? `${h}:${two(m)}:${two(sec)}` : `${two(m)}:${two(sec)}`;
}

/**
 * Keeps `--tv-scale-width` on the chart wrapper in sync with the right price
 * scale, and draws a compact, unified current-price/countdown badge.
 */
export function trackPriceAxis(
  chart: IChartApi,
  series: ISeriesApi<SeriesType>,
  wrapper: HTMLElement,
  source?: CountdownSource,
) {
  const box = document.createElement("div");
  box.className = "tv-countdown";
  const price = document.createElement("strong");
  const countdown = document.createElement("span");
  box.append(price, countdown);
  const originalLastValueVisible = series.options().lastValueVisible;
  let nativeLabelVisible = originalLastValueVisible;
  box.hidden = true;
  if (source) wrapper.appendChild(box);
  let frame = 0,
    width = -1,
    last = "";
  const offsetTop = () => {
    const container = wrapper.querySelector<HTMLElement>(".chart-container");
    return container ? container.offsetTop : 0;
  };
  const tick = () => {
    frame = requestAnimationFrame(tick);
    const scale = chart.priceScale("right").width();
    if (scale !== width) {
      width = scale;
      wrapper.style.setProperty("--tv-scale-width", `${scale}px`);
    }
    if (!source) return;
    const info = source();
    const now = Date.now() / 1000;
    const remaining = info ? info.closeTime - now : -1;
    const y = info ? series.priceToCoordinate(info.price) : null;
    const paneHeight = chart.panes()[0]?.getHeight() ?? 0;
    const visible = info && y !== null && remaining > 0 && y > 0 && y + 30 < paneHeight;
    const showNative = visible ? false : originalLastValueVisible;
    if (showNative !== nativeLabelVisible) {
      series.applyOptions({lastValueVisible: showNative});
      nativeLabelVisible = showNative;
    }
    const formattedPrice = info ? series.priceFormatter().format(info.price) : '';
    const key = visible
      ? `${Math.round(y!)}|${formattedPrice}|${formatCountdown(remaining)}|${info!.up}|${scale}`
      : "hidden";
    if (key === last) return;
    last = key;
    box.hidden = !visible;
    if (!visible) return;
    price.textContent = formattedPrice;
    countdown.textContent = formatCountdown(remaining);
    box.style.top = `${offsetTop() + y! - 8}px`;
    box.style.right = `${scale}px`;
    box.style.background = info!.up ? TV.up : TV.down;
  };
  frame = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(frame);
    if (nativeLabelVisible !== originalLastValueVisible) series.applyOptions({lastValueVisible: originalLastValueVisible});
    box.remove();
  };
}

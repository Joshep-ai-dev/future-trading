import type { IChartApi, ISeriesApi, MouseEventParams, SeriesType } from "lightweight-charts";
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
  onInspect?: () => void,
) {
  const box = document.createElement(onInspect ? "button" : "div");
  if (onInspect) {
    box.setAttribute("type", "button");
    box.setAttribute("aria-label", "Show price prediction, support and resistance");
    box.title = "Price prediction, support and resistance";
    box.classList.add("tv-countdown-interactive");
    box.addEventListener("click", onInspect);
  }
  box.classList.add("tv-countdown");
  const mousePrice = document.createElement("div");
  mousePrice.className = "tv-mouse-price";
  mousePrice.hidden = true;
  const price = document.createElement("strong");
  const countdown = document.createElement("span");
  box.append(price, countdown);
  const originalLastValueVisible = series.options().lastValueVisible;
  let nativeLabelVisible = originalLastValueVisible;
  const originalCrosshairLabelVisible = chart.options().crosshair.horzLine.labelVisible;
  let crosshairLabelVisible = originalCrosshairLabelVisible;
  box.hidden = true;
  if (source) wrapper.append(box, mousePrice);
  let crosshairY: number | null = null;
  const crosshairMoved = (event: MouseEventParams) => {
    crosshairY = event.point && (event.paneIndex ?? 0) === 0 ? event.point.y : null;
  };
  if (source) chart.subscribeCrosshairMove(crosshairMoved);
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
    const visible = info && y !== null && (remaining > 0 || !!onInspect) && y > 0 && y + 30 < paneHeight;
    const showNative = visible ? false : originalLastValueVisible;
    if (showNative !== nativeLabelVisible) {
      series.applyOptions({lastValueVisible: showNative});
      nativeLabelVisible = showNative;
    }
    const formattedPrice = info ? series.priceFormatter().format(info.price) : '';
    const top = y === null ? 0 : y - 8;
    const chartTop = offsetTop();
    const key = visible
      ? `${Math.round(y!)}|${formattedPrice}|${formatCountdown(remaining)}|${info!.up}|${scale}|${chartTop}`
      : "hidden";
    if (key !== last) {
      last = key;
      box.hidden = !visible;
      if (visible) {
        price.textContent = formattedPrice;
        countdown.textContent = remaining > 0 ? formatCountdown(remaining) : 'View analysis';
        box.style.top = `${chartTop + top}px`;
        box.style.right = `${scale}px`;
        box.style.background = info!.up ? TV.up : TV.down;
      }
    }
    // Measure the rendered badge: font and browser scaling can change its
    // height. The mouse readout must clear the whole price/countdown block.
    const badgeHeight = box.offsetHeight;
    const mouseHeight = Math.ceil(chart.options().layout.fontSize * 1.5) + 4;
    const gap = 5;
    const overlapping = !!visible && crosshairY !== null
      && crosshairY + mouseHeight / 2 + gap > top
      && crosshairY - mouseHeight / 2 - gap < top + badgeHeight;
    const mouseValue = overlapping ? series.coordinateToPrice(crosshairY!) : null;
    const showMousePrice = overlapping && mouseValue !== null && originalCrosshairLabelVisible;
    const showCrosshairLabel = showMousePrice ? false : originalCrosshairLabelVisible;
    if (showCrosshairLabel !== crosshairLabelVisible) {
      chart.applyOptions({crosshair: {horzLine: {labelVisible: showCrosshairLabel}}});
      crosshairLabelVisible = showCrosshairLabel;
    }
    mousePrice.hidden = !showMousePrice;
    if (showMousePrice) {
      const above = top - mouseHeight - gap;
      const below = top + badgeHeight + gap;
      const preferAbove = crosshairY! < top + badgeHeight / 2;
      const mouseTop = preferAbove && above >= 0 ? above
        : below + mouseHeight <= paneHeight ? below : Math.max(0, above);
      mousePrice.textContent = series.priceFormatter().format(mouseValue!);
      mousePrice.style.top = `${chartTop + mouseTop}px`;
      mousePrice.style.right = `${scale}px`;
      mousePrice.style.minHeight = `${mouseHeight}px`;
    }
  };
  frame = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(frame);
    if (source) chart.unsubscribeCrosshairMove(crosshairMoved);
    if (nativeLabelVisible !== originalLastValueVisible) series.applyOptions({lastValueVisible: originalLastValueVisible});
    if (crosshairLabelVisible !== originalCrosshairLabelVisible) chart.applyOptions({crosshair: {horzLine: {labelVisible: originalCrosshairLabelVisible}}});
    if (onInspect) box.removeEventListener("click", onInspect);
    box.remove();
    mousePrice.remove();
  };
}

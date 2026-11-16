import { useEffect, useState } from "react";
import { api } from "../../shared/api/api";
import { fmt } from "../../shared/types/types";
import { useChartTimeZone } from "../../shared/charts/chartTimeZone";
import { formatTradingTime } from "../../shared/charts/tradingTime";
import { shortName } from "./EconomicCalendar";

export type LiveRelease = {
  id: string;
  name: string;
  group: string;
  core: boolean;
  released: number;
  actual: number | null;
  forecast: number | null;
  previous: number | null;
  potency: string;
  surprise: number | null;
  surpriseZ: number | null;
  silverBias: number | null;
};
type Minute = { time: number; close: number; high: number; low: number };

export const JUST_RELEASED_SECONDS = 60 * 60; // card stays for an hour after a release
export const COMING_SECONDS = 10 * 60; // and appears ten minutes before one
/** Text-only events (FOMC minutes, press conference) never get an actual value. */
const NO_NUMBER = new Set(["FOMC Minutes", "FOMC Press Conference"]);

const value = (row: LiveRelease, number: number | null) => (number == null ? "—" : `${fmt(number, 2)}${row.potency === "K" ? "K" : "%"}`);
const signed = (number: number | null, digits = 2, suffix = "") => (number == null ? "—" : `${number > 0 ? "+" : ""}${fmt(number, digits)}${suffix}`);

function clock(seconds: number) {
  const s = Math.max(0, Math.round(Math.abs(seconds)));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Silver since the release from the live 1-minute feed: change from the last close before it, and the range since. */
function silverSince(minutes: Minute[], released: number) {
  const before = [...minutes].reverse().find((m) => m.time + 60 <= released);
  const after = minutes.filter((m) => m.time + 60 > released);
  if (!before || !after.length) return null;
  const last = after.at(-1)!;
  return {
    move: (last.close / before.close - 1) * 100,
    high: (Math.max(...after.map((m) => m.high)) / before.close - 1) * 100,
    low: (Math.min(...after.map((m) => m.low)) / before.close - 1) * 100,
    price: last.close,
  };
}

/** Releases due in the next ten minutes or out in the last hour: the number, the surprise and silver's live reaction. */
export default function JustReleased({ rows, onOpen }: { rows: LiveRelease[]; onOpen?: (row: LiveRelease) => void }) {
  const zone = useChartTimeZone();
  const [now, setNow] = useState(() => Date.now() / 1000);
  const [minutes, setMinutes] = useState<Minute[]>([]);
  const live = rows.filter((row) => row.released >= now - JUST_RELEASED_SECONDS && row.released <= now + COMING_SECONDS);
  const anyOut = live.some((row) => row.released <= now);
  useEffect(() => {
    if (!live.length) return;
    const timer = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(timer);
  }, [live.length]);
  useEffect(() => {
    if (!anyOut) return;
    const load = () =>
      api<{ candles: Minute[] }>("/api/market/live-candles")
        .then((value) => setMinutes(value.candles))
        .catch(() => {});
    void load();
    const timer = setInterval(load, 10000);
    return () => clearInterval(timer);
  }, [anyOut]);
  if (!live.length) return null;

  const moments = [...new Set(live.map((row) => row.released))].sort((a, b) => a - b);
  return (
    <section className='just-released' aria-label='Releases out now' aria-live='polite'>
      {moments.map((released) => {
        const group = live.filter((row) => row.released === released).sort((a, b) => Number(b.core) - Number(a.core));
        const out = released <= now;
        const silver = out ? silverSince(minutes, released) : null;
        return (
          <article key={released} className={out ? "is-out" : "is-coming"}>
            <header>
              <span className='just-badge'>{out ? "Just released" : "Coming up"}</span>
              <b>{formatTradingTime(released, zone).slice(11, 16)}</b>
              <small>{out ? `${clock(now - released)} ago` : `in ${clock(released - now)}`}</small>
              {out && (
                <span className='just-silver'>
                  Silver since release{" "}
                  {silver ? (
                    <>
                      <b className={silver.move > 0 ? "positive" : silver.move < 0 ? "negative" : ""}>{signed(silver.move, 2, "%")}</b>
                      <small>
                        range {signed(silver.low, 2, "%")} / {signed(silver.high, 2, "%")} · {fmt(silver.price, 3)}
                      </small>
                    </>
                  ) : (
                    <small>waiting for the first candle…</small>
                  )}
                </span>
              )}
            </header>
            <ul>
              {group.map((row) => {
                const waiting = out && row.actual == null && !NO_NUMBER.has(row.name);
                const bias = row.silverBias;
                return (
                  <li key={row.id} className={row.core ? "is-core" : ""}>
                    <button type='button' disabled={!out || !onOpen} onClick={() => onOpen?.(row)} title={out ? "Open the chart around this release" : undefined}>
                      <span className='just-name'>{shortName(row.name)}</span>
                      <span className='just-actual'>
                        {waiting ? <i className='just-waiting'>waiting for the number…</i> : NO_NUMBER.has(row.name) ? "Text release" : value(row, row.actual)}
                      </span>
                      <span className='just-forecast'>fcst {value(row, row.forecast)}</span>
                      <span className={`just-surprise ${row.surprise == null ? "" : row.surprise > 0 ? "positive" : row.surprise < 0 ? "negative" : ""}`}>
                        {row.surprise == null ? "" : `${signed(row.surprise, 2, row.potency === "K" ? "K" : "%")} (${signed(row.surpriseZ)}σ)`}
                      </span>
                      {bias != null && Math.abs(bias) >= 0.25 && (
                        <span className={`news-pill ${bias > 0 ? "is-bullish" : "is-bearish"}`}>{bias > 0 ? "Silver +" : "Silver −"}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </article>
        );
      })}
    </section>
  );
}

import { useEffect, useState } from "react";
import { api } from "../../shared/api/api";
import { fmt } from "../../shared/types/types";
import { useChartTimeZone } from "../../shared/charts/chartTimeZone";
import { formatTradingTime } from "../../shared/charts/tradingTime";

type Reaction = { m15: number | null; m60: number | null; m240: number | null } | null;
type Release = {
  id: string;
  name: string;
  group: string;
  core: boolean;
  released: number;
  period: string;
  periodType: string;
  actual: number | null;
  forecast: number | null;
  previous: number | null;
  revised: number | null;
  potency: string;
  surprise: number | null;
  surpriseZ: number | null;
  silverBias: number | null;
  reaction: Reaction;
};
type GroupStats = {
  group: string;
  label: string;
  releases: number;
  measured: number;
  averageAbsMove: number | null;
  biasHitRate: number | null;
  surpriseCorrelation: number | null;
  last: Release | null;
  next: Release | null;
};
type Calendar = { groups: { key: string; label: string }[]; stats: GroupStats[]; past: Release[]; upcoming: Release[] };

const unit = (release: Release) => (release.potency === "K" ? "K" : "%");
const value = (release: Release, number: number | null) => (number == null ? "—" : `${fmt(number, 2)}${unit(release)}`);
const signed = (number: number | null | undefined, digits = 2, suffix = "") =>
  number == null ? "—" : `${number > 0 ? "+" : ""}${fmt(number, digits)}${suffix}`;
const tone = (number: number | null | undefined) => (number == null || Math.abs(number) < 1e-9 ? "" : number > 0 ? "positive" : "negative");
const period = (release: Release) => {
  if (!release.period) return "";
  const date = new Date(`${release.period}T00:00:00Z`);
  if (release.periodType === "QUARTER") return `Q${Math.floor(date.getUTCMonth() / 3) + 1} ${date.getUTCFullYear()}`;
  if (release.periodType === "MONTH") return date.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  return "";
};

/** "Consumer Price Index ex Food & Energy (MoM)" -> "Core CPI m/m". */
export function shortName(name: string) {
  return name
    .replace("Consumer Price Index ex Food & Energy", "Core CPI")
    .replace("Producer Price Index ex Food & Energy", "Core PPI")
    .replace("Core Personal Consumption Expenditures - Price Index", "Core PCE")
    .replace("Gross Domestic Product Annualized", "GDP (annualized)")
    .replace("Fed Interest Rate Decision", "Fed rate decision")
    .replace(" (MoM)", " m/m")
    .replace(" (YoY)", " y/y");
}
function until(seconds: number) {
  const diff = seconds - Date.now() / 1000;
  if (diff <= 0) return "now";
  if (diff < 3600) return `in ${Math.ceil(diff / 60)}m`;
  if (diff < 86400) return `in ${Math.round(diff / 3600)}h`;
  return `in ${Math.round(diff / 86400)}d`;
}

/** Silver's typical first reaction to the surprise, from the release's silver bias. */
function BiasPill({ bias }: { bias: number | null }) {
  if (bias == null || Math.abs(bias) < 0.25) return <span className='news-pill is-neutral'>In line</span>;
  return <span className={`news-pill ${bias > 0 ? "is-bullish" : "is-bearish"}`}>{bias > 0 ? "Silver +" : "Silver −"}</span>;
}

/** US releases that move silver: forecast vs actual, the surprise, and how silver really reacted. */
export default function EconomicCalendar({ visible }: { visible: boolean }) {
  const zone = useChartTimeZone();
  const [data, setData] = useState<Calendar | null>(null),
    [error, setError] = useState("");
  const [view, setView] = useState<"past" | "upcoming">("past"),
    [group, setGroup] = useState(""),
    [coreOnly, setCoreOnly] = useState(true);
  useEffect(() => {
    if (!visible) return;
    const load = () =>
      api<Calendar>(`/api/news/calendar?days_back=120&days_ahead=45${group ? `&group=${group}` : ""}`)
        .then((value) => {
          setData(value);
          setError("");
        })
        .catch((reason) => setError(String(reason)));
    void load();
    const timer = setInterval(load, 60000);
    return () => clearInterval(timer);
  }, [visible, group]);

  const rows = (view === "past" ? data?.past : data?.upcoming)?.filter((row) => !coreOnly || row.core) ?? [];
  return (
    <section className='news-panel econ' aria-label='US economic calendar'>
      <header>
        <div>
          <h2>US economic calendar</h2>
          <p>
            Forecast (consensus) vs actual for the releases that move silver, using core figures: core CPI, core PPI and core PCE m/m, retail sales ex autos, payrolls, GDP and the FOMC events. <b>Surprise</b> = actual − forecast; σ compares it with
            that release&apos;s past surprises. <b>Silver 15m / 1h / 4h</b> is the real move after the release, from your market data.
          </p>
        </div>
      </header>
      {error && (
        <p className='error' role='alert'>
          {error}
        </p>
      )}

      <div className='econ-cards'>
        {data?.stats.map((item) => {
          const last = item.last;
          return (
            <button
              key={item.group}
              type='button'
              className='econ-card'
              aria-pressed={group === item.group}
              onClick={() => setGroup(group === item.group ? "" : item.group)}
            >
              <span className='econ-card-title'>{item.label}</span>
              {last && last.actual != null ? (
                <span className='econ-card-last'>
                  <b>{value(last, last.actual)}</b>
                  <small>vs {value(last, last.forecast)} forecast</small>
                  <BiasPill bias={last.silverBias} />
                </span>
              ) : (
                <span className='econ-card-last'>
                  <small>{last ? `Last: ${formatTradingTime(last.released, zone).slice(0, 10)}` : "No releases yet"}</small>
                </span>
              )}
              <span className='econ-card-stats'>
                {item.averageAbsMove == null ? (
                  "No silver data for past releases"
                ) : (
                  <>
                    Silver 1h ±{fmt(item.averageAbsMove, 2)}%
                    {item.biasHitRate != null && ` · as expected ${fmt(item.biasHitRate * 100, 0)}%`}
                    {` · ${item.measured} rel.`}
                  </>
                )}
              </span>
              <span className='econ-card-next'>
                {item.next
                  ? `Next ${until(item.next.released)} · ${item.next.forecast == null ? "forecast pending" : `fcst ${value(item.next, item.next.forecast)}`}`
                  : "No date scheduled yet"}
              </span>
            </button>
          );
        })}
      </div>

      <div className='econ-toolbar'>
        <div className='news-segment' role='group' aria-label='Releases'>
          <button type='button' aria-pressed={view === "past"} onClick={() => setView("past")}>
            Released
          </button>
          <button type='button' aria-pressed={view === "upcoming"} onClick={() => setView("upcoming")}>
            Upcoming ({data?.upcoming.filter((row) => !coreOnly || row.core).length ?? 0})
          </button>
        </div>
        <label className='econ-check'>
          <input type='checkbox' checked={coreOnly} onChange={(event) => setCoreOnly(event.target.checked)} />
          Core figures only
        </label>
        {group && (
          <button type='button' className='text-button' onClick={() => setGroup("")}>
            Show all releases
          </button>
        )}
      </div>

      {rows.length ? (
        <div className='table-scroll econ-table-wrap'>
          <table className='econ-table'>
            <thead>
              <tr>
                <th>Time</th>
                <th>Release</th>
                <th>Period</th>
                <th>Actual</th>
                <th>Forecast</th>
                <th>Previous</th>
                <th>Surprise</th>
                <th>σ</th>
                <th>Expected</th>
                <th>Silver 15m</th>
                <th>Silver 1h</th>
                <th>Silver 4h</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className={row.core ? "is-core" : ""}>
                  <td title={formatTradingTime(row.released, zone)}>
                    {formatTradingTime(row.released, zone).slice(0, 16)}
                    {view === "upcoming" && <small> {until(row.released)}</small>}
                  </td>
                  <td title={row.name}>{shortName(row.name)}</td>
                  <td>{period(row)}</td>
                  <td className='econ-actual'>{value(row, row.actual)}</td>
                  <td>{value(row, row.forecast)}</td>
                  <td>{value(row, row.revised ?? row.previous)}</td>
                  <td className={tone(row.surprise)}>{row.surprise == null ? "—" : signed(row.surprise, 2, unit(row))}</td>
                  <td>{signed(row.surpriseZ)}</td>
                  <td>{row.actual == null ? "" : <BiasPill bias={row.silverBias} />}</td>
                  <td className={tone(row.reaction?.m15)}>{signed(row.reaction?.m15, 2, "%")}</td>
                  <td className={tone(row.reaction?.m60)}>{signed(row.reaction?.m60, 2, "%")}</td>
                  <td className={tone(row.reaction?.m240)}>{signed(row.reaction?.m240, 2, "%")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className='news-empty is-compact'>
          <p>{data ? (view === "past" ? "No releases in the last 120 days." : "No scheduled releases in the next 45 days.") : "Loading the calendar…"}</p>
        </div>
      )}
      <p className='news-caption'>
        &quot;Expected&quot; is the textbook first reaction: hotter inflation, stronger growth or a higher rate than forecast lifts yields and the
        dollar, which usually pushes silver down. The cards show how often silver really moved that way within an hour. FOMC minutes and the press
        conference have no forecast, and rate decisions rarely differ from it, so for those the silver move is what matters. Source: FXStreet economic calendar.
      </p>
    </section>
  );
}

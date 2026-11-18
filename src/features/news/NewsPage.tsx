import { useCallback, useEffect, useRef, useState } from "react";
import { createChart, HistogramSeries, LineSeries, type IChartApi, type UTCTimestamp } from "lightweight-charts";
import { api } from "../../shared/api/api";
import { fmt } from "../../shared/types/types";
import { TV, tvChartOptions, tvTimeScaleOptions } from "../../shared/charts/tvTheme";
import { chartTimeOptions, useChartTimeZone } from "../../shared/charts/chartTimeZone";
import { formatTradingTime } from "../../shared/charts/tradingTime";
import PatternPanel from "../trading/PatternPanel";
import EconomicCalendar, { shortName } from "./EconomicCalendar";
import JustReleased, { COMING_SECONDS, JUST_RELEASED_SECONDS, type LiveRelease } from "./JustReleased";
import ReleaseChart, { type ChartRelease } from "./ReleaseChart";
import { markNewsSeen, readNewsSeen } from "./newsBadge";

type Article = {
  id: string;
  published: number;
  provider: string;
  source: string;
  title: string;
  url: string;
  summary: string;
  sentiment: number;
  relevance: number;
  topics: string[];
};
type Feed = { total: number; articles: Article[]; topics: string[] };
type Outlook = {
  label: string;
  score: number | null;
  headlineSentiment: number | null;
  headlines: number;
  tone24h: number | null;
  tone7d: number | null;
  toneShift: number | null;
  volume24h: number;
  volumeRatio: number | null;
  topics: { topic: string; count: number; sentiment: number }[];
  drivers: Article[];
};
type Bucket = { time: number; volume: number; tone: number | null; headlines: number; sentiment: number | null };
type Status = {
  running: boolean;
  enabled: boolean;
  lastRun: number | null;
  backfilling: boolean;
  errors: Record<string, string>;
  articles: number;
  timelineBuckets: number;
  timelineStart: number | null;
  timelineEnd: number | null;
  headlinesFrom: number | null;
  waiting?: Record<string, string>;
};

const PAGE = 30;
type NewsTab = "headlines" | "calendar" | "similar";
const NEWS_TABS: readonly [NewsTab, string][] = [
  ["headlines", "Headlines"],
  ["calendar", "Economic calendar"],
  ["similar", "Similar history"],
];
type Release = LiveRelease & { reaction: ChartRelease["reaction"] };
const releaseValue = (row: Release, value: number) => `${fmt(value, 2)}${row.potency === "K" ? "K" : "%"}`;
function until(seconds: number) {
  const diff = seconds - Date.now() / 1000;
  if (diff <= 0) return "now";
  if (diff < 3600) return `in ${Math.ceil(diff / 60)}m`;
  if (diff < 86400) return `in ${Math.round(diff / 3600)}h`;
  return `in ${Math.round(diff / 86400)}d`;
}
const RANGES = [
  { key: "24h", hours: 24, resolution: "15m" },
  { key: "7d", hours: 168, resolution: "1h" },
  { key: "30d", hours: 720, resolution: "4h" },
  { key: "All", hours: 24 * 400, resolution: "1d" },
] as const;
const signed = (value: number | null | undefined, digits = 2) => (value == null ? "—" : `${value >= 0 ? "+" : ""}${fmt(value, digits)}`);
const mood = (value: number) => (value > 0.15 ? "bullish" : value < -0.15 ? "bearish" : "neutral");
const MOOD_LABEL = { bullish: "Bullish", bearish: "Bearish", neutral: "Neutral" } as const;

function ago(seconds: number) {
  const diff = Math.max(0, Date.now() / 1000 - seconds);
  if (diff < 3600) return `${Math.max(1, Math.round(diff / 60))}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

/** GDELT article volume (bars) and average tone (line) for the chosen range. */
function TimelineChart({ buckets }: { buckets: Bucket[] }) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const zone = useChartTimeZone();
  useEffect(() => {
    if (!host.current) return;
    const instance = createChart(host.current, {
      ...tvChartOptions,
      autoSize: true,
      localization: chartTimeOptions(zone).localization,
      timeScale: { ...tvTimeScaleOptions, timeVisible: true, ...chartTimeOptions(zone).timeScale },
      leftPriceScale: { visible: true, borderVisible: false, scaleMargins: { top: 0.55, bottom: 0 } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.5 } },
      handleScroll: false,
      handleScale: false,
    });
    chart.current = instance;
    return () => {
      instance.remove();
      chart.current = null;
    };
  }, [zone]);
  useEffect(() => {
    const instance = chart.current;
    if (!instance) return;
    const volume = instance.addSeries(HistogramSeries, { priceScaleId: "left", priceLineVisible: false, lastValueVisible: false, title: "Articles" });
    const tone = instance.addSeries(LineSeries, { color: TV.orange, lineWidth: 2, priceLineVisible: false, title: "Tone" });
    volume.setData(
      buckets.map((b) => ({ time: b.time as UTCTimestamp, value: b.volume, color: (b.tone ?? 0) >= 0 ? "rgba(8,153,129,0.45)" : "rgba(242,54,69,0.45)" })),
    );
    tone.setData(buckets.map((b) => (b.tone == null ? { time: b.time as UTCTimestamp } : { time: b.time as UTCTimestamp, value: b.tone })));
    tone.createPriceLine({ price: 0, color: TV.grid, lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: "" });
    instance.timeScale().fitContent();
    return () => {
      instance.removeSeries(volume);
      instance.removeSeries(tone);
    };
  }, [buckets]);
  return <div className='news-timeline-chart' ref={host} />;
}

/** Browse silver news, see how the news flow is leaning, and find past moments with similar price and news. */
export default function NewsPage({ visible, onOpenChart }: { visible: boolean; onOpenChart?: (time: number, label: string) => void }) {
  const zone = useChartTimeZone();
  const [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [topic, setTopic] = useState(""),
    [sentiment, setSentiment] = useState<"" | "positive" | "negative" | "neutral">(""),
    [before, setBefore] = useState(""); // "YYYY-MM-DD": show headlines up to the end of that UTC day
  const [feed, setFeed] = useState<Feed | null>(null),
    [limit, setLimit] = useState(PAGE),
    [error, setError] = useState("");
  const [outlook, setOutlook] = useState<Outlook | null>(null),
    [status, setStatus] = useState<Status | null>(null);
  const [range, setRange] = useState<(typeof RANGES)[number]>(RANGES[1]),
    [buckets, setBuckets] = useState<Bucket[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  // Items newer than the last visit get a red dot; opening the page marks everything as seen.
  const [seenBefore, setSeenBefore] = useState(readNewsSeen);
  useEffect(() => {
    if (!visible) return;
    setSeenBefore(readNewsSeen());
    markNewsSeen();
  }, [visible]);
  const [tab, setTab] = useState<NewsTab>(() => {
    try {
      const saved = localStorage.getItem("silver.news.tab");
      return NEWS_TABS.some(([key]) => key === saved) ? (saved as NewsTab) : "headlines";
    } catch {
      return "headlines";
    }
  });
  const [opened, setOpened] = useState<NewsTab[]>([tab]);
  const [upcoming, setUpcoming] = useState<Release[]>([]),
    [recent, setRecent] = useState<Release[]>([]),
    [chart, setChart] = useState<ChartRelease | null>(null);
  // Around a release (10 min before to 30 min after) everything on the page refreshes every 10 s.
  const [clockNow, setClockNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const timer = setInterval(() => setClockNow(Date.now() / 1000), 15000);
    return () => clearInterval(timer);
  }, []);
  const hot = [...recent, ...upcoming].some((row) => row.released >= clockNow - 30 * 60 && row.released <= clockNow + COMING_SECONDS);
  const every = hot ? 10000 : 60000;
  function changeTab(next: NewsTab) {
    setTab(next);
    setOpened((old) => (old.includes(next) ? old : [...old, next]));
    try {
      localStorage.setItem("silver.news.tab", next);
    } catch {
      /* The tab is remembered for this visit only. */
    }
  }
  useEffect(() => {
    if (!visible) return;
    const load = () =>
      api<{ upcoming: Release[]; past: Release[] }>("/api/news/calendar?days_back=1&days_ahead=21")
        .then((value) => {
          setUpcoming(value.upcoming.filter((row) => row.core));
          // Every figure of releases from the last hour or due soon feeds the "Just released" card.
          const now = Date.now() / 1000;
          setRecent([...value.past, ...value.upcoming].filter((row) => row.released >= now - JUST_RELEASED_SECONDS && row.released <= now + COMING_SECONDS));
        })
        .catch(() => setUpcoming([]));
    void load();
    const timer = setInterval(load, hot ? 10000 : 120000);
    return () => clearInterval(timer);
  }, [visible, hot]);

  const loadFeed = useCallback(async () => {
    const params = new URLSearchParams({ q: search, topic, sentiment, limit: String(limit) });
    if (before) params.set("until", String(Date.parse(`${before}T00:00:00Z`) / 1000 + 86400));
    try {
      setFeed(await api<Feed>(`/api/news?${params}`));
      setError("");
      if (document.visibilityState === "visible") markNewsSeen();
    } catch (reason) {
      setError(String(reason));
    }
  }, [search, topic, sentiment, limit, before]);
  const loadSide = useCallback(async () => {
    const [nextOutlook, nextStatus] = await Promise.all([api<Outlook>("/api/news/outlook"), api<Status>("/api/news/status")]);
    setOutlook(nextOutlook);
    setStatus(nextStatus);
  }, []);
  useEffect(() => {
    if (!visible) return;
    void loadFeed();
    const timer = setInterval(() => void loadFeed(), every);
    return () => clearInterval(timer);
  }, [visible, loadFeed, every]);
  useEffect(() => {
    if (!visible) return;
    void loadSide().catch((reason) => setError(String(reason)));
    const timer = setInterval(() => void loadSide().catch(() => {}), every);
    return () => clearInterval(timer);
  }, [visible, loadSide, every]);
  useEffect(() => {
    if (!visible) return;
    void api<{ buckets: Bucket[] }>(`/api/news/timeline?hours=${range.hours}&resolution=${range.resolution}`)
      .then((value) => setBuckets(range.key === "All" ? value.buckets.slice(value.buckets.findIndex((b) => b.volume > 0)) : value.buckets))
      .catch((reason) => setError(String(reason)));
  }, [visible, range, status?.timelineEnd]);

  async function refresh() {
    setRefreshing(true);
    try {
      await api("/api/news/refresh", { method: "POST" });
      await Promise.all([loadFeed(), loadSide()]);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setRefreshing(false);
    }
  }

  const score = outlook?.score ?? null;
  const tone = score == null ? "neutral" : mood(score);
  const sourceErrors = Object.entries(status?.errors ?? {});
  const nowLocal = formatTradingTime(Date.now() / 1000, zone).slice(0, 10);
  const yesterdayLocal = formatTradingTime(Date.now() / 1000 - 86400, zone).slice(0, 10);
  const dayLabel = (day: string) => (day === nowLocal ? "Today" : day === yesterdayLocal ? "Yesterday" : day);
  const days: [string, Article[]][] = [];
  for (const article of feed?.articles ?? []) {
    const day = formatTradingTime(article.published, zone).slice(0, 10);
    if (days.at(-1)?.[0] === day) days.at(-1)![1].push(article);
    else days.push([day, [article]]);
  }
  const nextRelease = upcoming[0];
  return (
    <div id='page-news' role='tabpanel' aria-labelledby='tab-news' className='news-page'>
      <header className='news-head'>
        <div className='news-title'>
          <h1>News</h1>
          <div className='news-tabs' role='tablist' aria-label='News views'>
            {NEWS_TABS.map(([key, label]) => (
              <button key={key} type='button' role='tab' aria-selected={tab === key} onClick={() => changeTab(key)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className='news-head-meta'>
          <span className={`news-collector ${status?.running ? "is-on" : ""}`} title={status?.headlinesFrom ? `Headline history from ${new Date(status.headlinesFrom * 1000).toISOString().slice(0, 10)}` : undefined}>
            <i aria-hidden='true' />
            {!status
              ? "Loading…"
              : !status.enabled
                ? "Collector off (SILVER_NEWS=0)"
                : `${status.articles.toLocaleString()} headlines · ${status.lastRun ? `updated ${ago(status.lastRun)}` : "starting"}${status.backfilling ? " · backfilling history" : ""}${Object.values(status.waiting ?? {}).map((text) => ` · ${text}`).join("")}`}
          </span>
          <button type='button' className='secondary' disabled={refreshing} onClick={() => void refresh()}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      <section className='news-mood' aria-label='News flow in the last 24 hours'>
        <div className='news-mood-main'>
          <span className='news-mood-label'>News flow · 24h</span>
          <span className={`news-pill is-${tone}`}>{outlook?.label ?? "…"}</span>
          <div className='news-gauge' aria-hidden='true' title='Bearish ← → Bullish'>
            <i style={{ left: `${((Math.max(-1, Math.min(1, score ?? 0)) + 1) / 2) * 100}%` }} />
          </div>
        </div>
        <dl className='news-mood-stats'>
          <div>
            <dt>Headline sentiment</dt>
            <dd className={tone === "neutral" ? "" : (outlook?.headlineSentiment ?? 0) >= 0 ? "positive" : "negative"}>
              {signed(outlook?.headlineSentiment)} <small>{outlook?.headlines ?? 0} headlines</small>
            </dd>
          </div>
          <div>
            <dt>GDELT tone</dt>
            <dd>
              {signed(outlook?.tone24h)} <small>{outlook?.toneShift == null ? "no 7-day baseline" : `${signed(outlook.toneShift)} vs 7d`}</small>
            </dd>
          </div>
          <div>
            <dt>Coverage</dt>
            <dd>
              {outlook?.volumeRatio == null ? "—" : `${fmt(outlook.volumeRatio, 2)}×`} <small>vs daily avg</small>
            </dd>
          </div>
          <div className='news-mood-next'>
            <dt>Next release</dt>
            <dd>
              {nextRelease ? (
                <button type='button' className='text-button' onClick={() => changeTab("calendar")}>
                  {shortName(nextRelease.name)} <small>{until(nextRelease.released)}{nextRelease.forecast != null && ` · fcst ${releaseValue(nextRelease, nextRelease.forecast)}`}</small>
                </button>
              ) : (
                "—"
              )}
            </dd>
          </div>
        </dl>
      </section>

      <JustReleased
        rows={recent}
        onOpen={(row) =>
          setChart({
            name: row.name,
            label: shortName(row.name),
            released: row.released,
            actual: row.actual == null ? "—" : `${fmt(row.actual, 2)}${row.potency === "K" ? "K" : "%"}`,
            forecast: row.forecast == null ? "—" : `${fmt(row.forecast, 2)}${row.potency === "K" ? "K" : "%"}`,
            surprise: row.surprise == null ? "—" : `${row.surprise > 0 ? "+" : ""}${fmt(row.surprise, 2)}${row.potency === "K" ? "K" : "%"}`,
            reaction: (recent.find((item) => item.id === row.id) as Release | undefined)?.reaction ?? null,
          })
        }
      />
      {chart && (
        <ReleaseChart
          release={chart}
          onClose={() => setChart(null)}
          onOpenTrading={onOpenChart ? () => onOpenChart(chart.released, chart.label) : undefined}
        />
      )}

      {error && (
        <p className='error' role='alert'>
          {error}
        </p>
      )}
      {sourceErrors.length > 0 && (
        <p className='notice news-notice'>
          Some sources failed on the last run: {sourceErrors.map(([source, message]) => `${source} (${message})`).join(" · ")}
        </p>
      )}

      <div className='news-grid' hidden={tab !== "headlines"}>
        <section className='news-panel news-feed' aria-label='Headlines'>
          <form
            className='news-filters'
            onSubmit={(event) => {
              event.preventDefault();
              setLimit(PAGE);
              setSearch(query.trim());
            }}
          >
            <input type='search' placeholder='Search headlines and sources' aria-label='Search headlines' value={query} onChange={(e) => setQuery(e.target.value)} />
            <input
              type='date'
              className='news-date'
              aria-label='Show headlines up to this day (UTC)'
              title='Browse history: headlines up to this day (UTC)'
              max={new Date().toISOString().slice(0, 10)}
              value={before}
              onChange={(e) => {
                setLimit(PAGE);
                setBefore(e.target.value);
              }}
            />
            {before && (
              <button type='button' className='text-button' onClick={() => setBefore("")}>
                Back to latest
              </button>
            )}
            <div className='news-segment' role='group' aria-label='Sentiment'>
              {(["", "positive", "negative", "neutral"] as const).map((value) => (
                <button key={value || "all"} type='button' aria-pressed={sentiment === value} onClick={() => setSentiment(value)}>
                  {value === "" ? "All" : value === "positive" ? "Bullish" : value === "negative" ? "Bearish" : "Neutral"}
                </button>
              ))}
            </div>
          </form>
          <div className='news-topics' role='group' aria-label='Topic'>
            {["", ...(feed?.topics ?? [])].map((value) => (
              <button key={value || "all"} type='button' aria-pressed={topic === value} onClick={() => setTopic(value)}>
                {value || "All topics"}
              </button>
            ))}
            {feed && <span className='news-count'>{feed.total.toLocaleString()} results</span>}
          </div>
          {feed && !feed.articles.length ? (
            <div className='news-empty'>
              <h3>{status?.articles ? "No headlines match these filters" : "Collecting the first headlines"}</h3>
              <p>{status?.articles ? "Clear the search, pick another topic or date." : "The collector reads the feeds every 10 minutes. Press Refresh to fetch now."}</p>
            </div>
          ) : (
            <div className='news-list'>
              {days.map(([day, articles]) => (
                <section key={day} className='news-day' aria-label={dayLabel(day)}>
                  <h3>
                    {dayLabel(day)}
                    <small>{articles.length}</small>
                  </h3>
                  <ol>
                    {articles.map((article) => {
                      const kind = mood(article.sentiment);
                      return (
                        <li key={article.id} className={`is-${kind}${article.published > seenBefore ? " is-new" : ""}`}>
                          <time dateTime={new Date(article.published * 1000).toISOString()} title={formatTradingTime(article.published, zone)}>
                            {formatTradingTime(article.published, zone).slice(11, 16)}
                          </time>
                          <div className='news-item'>
                            <div className='news-item-meta'>
                              {article.published > seenBefore && <i className='news-new-dot' title='New since your last visit' />}
                              <span className='news-source'>{article.source}</span>
                              {article.topics.slice(0, 3).map((name) => (
                                <button key={name} type='button' className='news-tag' onClick={() => setTopic(name)}>
                                  {name}
                                </button>
                              ))}
                              <span className={`news-pill is-${kind}`}>
                                {MOOD_LABEL[kind]} {signed(article.sentiment)}
                              </span>
                            </div>
                            <a href={article.url} target='_blank' rel='noreferrer noopener'>
                              {article.title}
                            </a>
                            {article.summary && <p>{article.summary}</p>}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                </section>
              ))}
              {feed && feed.articles.length < feed.total && (
                <button type='button' className='secondary news-more' onClick={() => setLimit(limit + PAGE)}>
                  Load {Math.min(PAGE, feed.total - feed.articles.length)} more · {(feed.total - feed.articles.length).toLocaleString()} left
                </button>
              )}
            </div>
          )}
        </section>

        <aside className='news-side'>
          <section className='news-panel news-timeline' aria-label='News volume and tone'>
            <header>
              <h2>Volume &amp; tone</h2>
              <div className='news-segment' role='group' aria-label='Range'>
                {RANGES.map((item) => (
                  <button key={item.key} type='button' aria-pressed={range.key === item.key} onClick={() => setRange(item)}>
                    {item.key}
                  </button>
                ))}
              </div>
            </header>
            {buckets.some((b) => b.volume > 0) ? (
              <TimelineChart buckets={buckets} />
            ) : (
              <div className='news-empty is-compact'>
                <p>{status?.backfilling ? "GDELT history is still downloading." : "No GDELT coverage in this range yet."}</p>
              </div>
            )}
            <p className='news-caption'>Bars: silver-price articles per bucket (green = positive tone). Line: average tone.</p>
          </section>

          <section className='news-panel' aria-label='Topics in the last 24 hours'>
            <header>
              <h2>Topics · 24h</h2>
            </header>
            {outlook?.topics.length ? (
              <ul className='news-topic-bars'>
                {outlook.topics.map((item) => (
                  <li key={item.topic}>
                    <button type='button' onClick={() => setTopic(item.topic)}>
                      {item.topic}
                    </button>
                    <span className='news-topic-track'>
                      <i className={`is-${mood(item.sentiment)}`} style={{ width: `${Math.min(100, Math.abs(item.sentiment) * 100)}%` }} />
                    </span>
                    <small>
                      {item.count} · {signed(item.sentiment)}
                    </small>
                  </li>
                ))}
              </ul>
            ) : (
              <p className='news-caption'>No headlines in the last 24 hours.</p>
            )}
            <p className='news-caption'>Bar length = average sentiment for silver. Click a topic to filter the feed.</p>
          </section>

          <section className='news-panel' aria-label='Upcoming US releases'>
            <header>
              <h2>Upcoming releases</h2>
              <button type='button' className='text-button' onClick={() => changeTab("calendar")}>
                Calendar ↗
              </button>
            </header>
            {upcoming.length ? (
              <ol className='news-upcoming'>
                {upcoming.slice(0, 5).map((row) => (
                  <li key={row.id}>
                    <span>
                      <b>{shortName(row.name)}</b>
                      <small>{formatTradingTime(row.released, zone).slice(5, 16)}</small>
                    </span>
                    <span>
                      <b>{row.forecast == null ? "—" : releaseValue(row, row.forecast)}</b>
                      <small>{until(row.released)}</small>
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className='news-caption'>No core releases scheduled in the next three weeks.</p>
            )}
          </section>
        </aside>
      </div>

      <div hidden={tab !== "calendar"}>{opened.includes("calendar") && <EconomicCalendar visible={visible && tab === "calendar"} onOpenChart={onOpenChart} newSince={seenBefore} />}</div>

      <section className='news-panel news-similar' aria-label='Similar history' hidden={tab !== "similar"}>
        <header>
          <div>
            <h2>Similar history</h2>
            <p>
              Past moments whose candles (plus an optional model forecast), news flow and US release surprises looked like now, and what
              silver did next. News data from {status?.timelineStart != null ? formatTradingTime(status.timelineStart, zone).slice(0, 10) : "the start of collection"}.
            </p>
          </div>
        </header>
        {opened.includes("similar") && <PatternPanel defaultTimeframe='1h' newsControls />}
      </section>
    </div>
  );
}

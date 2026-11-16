import { useCallback, useEffect, useRef, useState } from "react";
import { createChart, HistogramSeries, LineSeries, type IChartApi, type UTCTimestamp } from "lightweight-charts";
import { api } from "../../shared/api/api";
import { fmt } from "../../shared/types/types";
import { TV, tvChartOptions, tvTimeScaleOptions } from "../../shared/charts/tvTheme";
import { chartTimeOptions, useChartTimeZone } from "../../shared/charts/chartTimeZone";
import { formatTradingTime } from "../../shared/charts/tradingTime";
import PatternPanel from "../trading/PatternPanel";
import EconomicCalendar from "./EconomicCalendar";

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
};

const PAGE = 30;
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
      leftPriceScale: { visible: true, borderColor: TV.border, scaleMargins: { top: 0.55, bottom: 0 } },
      rightPriceScale: { borderColor: TV.border, scaleMargins: { top: 0.08, bottom: 0.5 } },
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
export default function NewsPage({ visible }: { visible: boolean }) {
  const zone = useChartTimeZone();
  const [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [topic, setTopic] = useState(""),
    [sentiment, setSentiment] = useState<"" | "positive" | "negative" | "neutral">("");
  const [feed, setFeed] = useState<Feed | null>(null),
    [limit, setLimit] = useState(PAGE),
    [error, setError] = useState("");
  const [outlook, setOutlook] = useState<Outlook | null>(null),
    [status, setStatus] = useState<Status | null>(null);
  const [range, setRange] = useState<(typeof RANGES)[number]>(RANGES[1]),
    [buckets, setBuckets] = useState<Bucket[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const loadFeed = useCallback(async () => {
    const params = new URLSearchParams({ q: search, topic, sentiment, limit: String(limit) });
    try {
      setFeed(await api<Feed>(`/api/news?${params}`));
      setError("");
    } catch (reason) {
      setError(String(reason));
    }
  }, [search, topic, sentiment, limit]);
  const loadSide = useCallback(async () => {
    const [nextOutlook, nextStatus] = await Promise.all([api<Outlook>("/api/news/outlook"), api<Status>("/api/news/status")]);
    setOutlook(nextOutlook);
    setStatus(nextStatus);
  }, []);
  useEffect(() => {
    if (!visible) return;
    void loadFeed();
    const timer = setInterval(() => void loadFeed(), 60000);
    return () => clearInterval(timer);
  }, [visible, loadFeed]);
  useEffect(() => {
    if (!visible) return;
    void loadSide().catch((reason) => setError(String(reason)));
    const timer = setInterval(() => void loadSide().catch(() => {}), 60000);
    return () => clearInterval(timer);
  }, [visible, loadSide]);
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
  return (
    <div id='page-news' role='tabpanel' aria-labelledby='tab-news' className='news-page'>
      <header className='news-head'>
        <div>
          <h1>News</h1>
          <p>Silver, gold and macro drivers for XAG / USDT. Sentiment is scored from silver&apos;s point of view.</p>
        </div>
        <div className='news-head-meta'>
          <span className={`news-collector ${status?.running ? "is-on" : ""}`}>
            <i aria-hidden='true' />
            {!status
              ? "Loading…"
              : !status.enabled
                ? "Collector off (SILVER_NEWS=0)"
                : `${status.articles.toLocaleString()} headlines · ${status.lastRun ? `updated ${ago(status.lastRun)}` : "starting"}${status.backfilling ? " · backfilling history" : ""}`}
          </span>
          <button type='button' className='secondary' disabled={refreshing} onClick={() => void refresh()}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>
      {error && (
        <p className='error' role='alert'>
          {error}
        </p>
      )}
      {sourceErrors.length > 0 && (
        <p className='notice'>
          Some sources failed on the last run: {sourceErrors.map(([source, message]) => `${source} (${message})`).join(" · ")}
        </p>
      )}

      <div className='news-grid'>
        <section className='news-panel news-feed' aria-label='Headlines'>
          <form
            className='news-filters'
            onSubmit={(event) => {
              event.preventDefault();
              setLimit(PAGE);
              setSearch(query.trim());
            }}
          >
            <input type='search' placeholder='Search headlines' aria-label='Search headlines' value={query} onChange={(e) => setQuery(e.target.value)} />
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
          </div>
          {feed && !feed.articles.length ? (
            <div className='news-empty'>
              <h3>{status?.articles ? "No headlines match these filters" : "Collecting the first headlines"}</h3>
              <p>{status?.articles ? "Clear the search or pick another topic." : "The collector reads the feeds every 10 minutes. Press Refresh to fetch now."}</p>
            </div>
          ) : (
            <ol className='news-list'>
              {feed?.articles.map((article) => {
                const kind = mood(article.sentiment);
                return (
                  <li key={article.id}>
                    <div className='news-item-meta'>
                      <span className='news-source'>{article.source}</span>
                      <time dateTime={new Date(article.published * 1000).toISOString()} title={formatTradingTime(article.published, zone)}>
                        {ago(article.published)}
                      </time>
                      <span className={`news-pill is-${kind}`}>
                        {MOOD_LABEL[kind]} {signed(article.sentiment)}
                      </span>
                    </div>
                    <a href={article.url} target='_blank' rel='noreferrer noopener'>
                      {article.title}
                    </a>
                    {article.summary && <p>{article.summary}</p>}
                    {article.topics.length > 0 && (
                      <div className='news-item-topics'>
                        {article.topics.map((name) => (
                          <button key={name} type='button' onClick={() => setTopic(name)}>
                            {name}
                          </button>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {feed && feed.articles.length < feed.total && (
            <button type='button' className='secondary news-more' onClick={() => setLimit(limit + PAGE)}>
              Show more ({feed.total - feed.articles.length} left)
            </button>
          )}
        </section>

        <aside className='news-side'>
          <section className='news-panel news-outlook' aria-label='News flow'>
            <header>
              <h2>News flow · last 24h</h2>
              <span className={`news-pill is-${tone}`}>{outlook?.label ?? "…"}</span>
            </header>
            <div className='news-gauge' aria-hidden='true'>
              <i style={{ left: `${((Math.max(-1, Math.min(1, score ?? 0)) + 1) / 2) * 100}%` }} />
            </div>
            <div className='news-gauge-scale' aria-hidden='true'>
              <span>Bearish</span>
              <span>Neutral</span>
              <span>Bullish</span>
            </div>
            <dl className='news-stats'>
              <div>
                <dt>Headline sentiment</dt>
                <dd className={(outlook?.headlineSentiment ?? 0) >= 0 ? "positive" : "negative"}>{signed(outlook?.headlineSentiment)}</dd>
                <small>{outlook?.headlines ?? 0} headlines</small>
              </div>
              <div>
                <dt>GDELT tone</dt>
                <dd>{signed(outlook?.tone24h)}</dd>
                <small>
                  {outlook?.toneShift == null ? "no 7-day baseline yet" : `${signed(outlook.toneShift)} vs 7-day`}
                </small>
              </div>
              <div>
                <dt>Coverage</dt>
                <dd>{outlook?.volumeRatio == null ? "—" : `${fmt(outlook.volumeRatio, 2)}×`}</dd>
                <small>{fmt(outlook?.volume24h ?? 0, 0)} articles vs daily avg</small>
              </div>
            </dl>
            {!!outlook?.topics.length && (
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
            )}
            <p className='news-caption'>
              Describes the news, not the price. Use Similar history below to see how silver moved after comparable price and news.
            </p>
          </section>

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
            <p className='news-caption'>
              Bars: GDELT articles about silver prices per bucket (green when the average tone is positive). Line: average tone.
              {status?.timelineStart != null && ` History from ${formatTradingTime(status.timelineStart, zone).slice(0, 10)}.`}
            </p>
          </section>
        </aside>
      </div>

      <EconomicCalendar visible={visible} />

      <section className='news-panel news-similar' aria-label='Similar history'>
        <header>
          <div>
            <h2>Similar history</h2>
            <p>
              Past moments whose candles (plus an optional model forecast), news flow and US release surprises looked like now,
              and what silver did next. News data exists from {status?.timelineStart != null ? formatTradingTime(status.timelineStart, zone).slice(0, 10) : "the start of collection"}.
            </p>
          </div>
        </header>
        <PatternPanel defaultTimeframe='1h' newsControls />
      </section>
    </div>
  );
}

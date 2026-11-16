import { useEffect, useRef, useState } from "react";
import { api } from "../../shared/api/api";
import { fmt, type BacktestSettings } from "../../shared/types/types";

type Metrics = {
  trades: number;
  winRate: number | null;
  profitFactor: number | null;
  netProfit: number;
  expectancyR: number | null;
  maxDrawdownPct: number;
  sharpe?: number | null;
  maxConsecutiveLosses?: number;
};
type Breakdown = { key: string; trades: number; winRate: number; netProfit: number; expectancyR: number };
type Compare = {
  periods: Record<string, [string, string]>;
  variants: { key: string; label: string; periods: Record<"train" | "validation" | "test", Metrics>; all: Metrics }[];
  details: Record<string, Record<"session" | "regime" | "side" | "exit", Breakdown[]>>;
};
type Ranked = { params: Record<string, number>; train: Metrics; score: number; validation: Metrics; validationScore: number | null; neighbourScore: number | null; neighbours?: number };
type Optimize = { trials: number; feasible: number; ranked: Ranked[]; best: Ranked | null; bestTest?: Metrics; baseTest?: Metrics; baselineValidation: Metrics };
type WalkForward = { windows: { train: [string, string]; test: [string, string]; params: Record<string, number>; test_metrics: Metrics; default_metrics: Metrics }[]; summary: Metrics | null };
type Job<T> = { progress: number; result: T | null; error: string | null; finished: number | null };
type Space = Record<string, { kind: "int" | "float"; low: number; high: number; step: number }>;

const LABELS: Record<string, string> = {
  st_length: "SuperTrend ATR length",
  st_multiplier: "SuperTrend multiplier",
  adx_threshold: "ADX threshold",
  rsi_long_min: "RSI long minimum",
  rsi_short_max: "RSI short maximum",
  stop_atr: "Stop-loss × ATR",
  target_atr: "Take-profit × ATR",
  ema_fast_length: "EMA short period",
};
const pct = (value: number | null | undefined) => (value == null ? "—" : `${fmt(value * 100, 1)}%`);
const num = (value: number | null | undefined, digits = 2) => (value == null ? "—" : fmt(value, digits));
const signedR = (value: number | null | undefined) => (value == null ? "—" : `${value > 0 ? "+" : ""}${fmt(value, 3)}`);
const tone = (value: number | null | undefined) => (value == null || value === 0 ? "" : value > 0 ? "positive" : "negative");
const day = (value: string) => value.slice(0, 10);

function MetricCells({ m }: { m: Metrics | undefined }) {
  if (!m) return <td colSpan={4}>—</td>;
  return (
    <>
      <td>{m.trades}</td>
      <td>{pct(m.winRate)}</td>
      <td className={tone((m.profitFactor ?? 1) - 1)}>{num(m.profitFactor)}</td>
      <td className={tone(m.expectancyR)}>{signedR(m.expectancyR)}</td>
    </>
  );
}

function BreakdownTable({ title, rows }: { title: string; rows: Breakdown[] }) {
  return (
    <div className='lab-breakdown'>
      <h4>{title}</h4>
      <table>
        <thead>
          <tr>
            <th>{title}</th>
            <th>Trades</th>
            <th>Win</th>
            <th>Net</th>
            <th>Exp. R</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td>{row.key.replaceAll("_", " ")}</td>
              <td>{row.trades}</td>
              <td>{pct(row.winRate)}</td>
              <td className={tone(row.netProfit)}>{fmt(row.netProfit, 0)}</td>
              <td className={tone(row.expectancyR)}>{signedR(row.expectancyR)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Poll a background lab job until it finishes. */
function useJob<T>() {
  const [state, setState] = useState<Job<T> | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
  }, []);
  function follow(id: string) {
    if (timer.current) clearInterval(timer.current);
    setState({ progress: 0, result: null, error: null, finished: null });
    timer.current = setInterval(async () => {
      try {
        const value = await api<Job<T>>(`/api/lab/scalper/jobs/${id}`);
        setState(value);
        if (value.finished && timer.current) clearInterval(timer.current);
      } catch (reason) {
        setState({ progress: 1, result: null, error: String(reason), finished: Date.now() });
        if (timer.current) clearInterval(timer.current);
      }
    }, 1500);
  }
  return [state, follow] as const;
}

/** Research tools for the SuperTrend Scalper: step-by-step comparison, parameter search and walk-forward. */
export default function StrategyLab({ settings, onApply }: { settings: BacktestSettings; onApply: (params: Record<string, number>) => void }) {
  const [tab, setTab] = useState<"compare" | "search" | "walk">("compare");
  const [space, setSpace] = useState<Space>({});
  const [ranges, setRanges] = useState<Record<string, { on: boolean; low: number; high: number }>>({});
  const [trials, setTrials] = useState(100),
    [minTrades, setMinTrades] = useState(30),
    [maxDd, setMaxDd] = useState(30);
  const [trainDays, setTrainDays] = useState(60),
    [testDays, setTestDays] = useState(30),
    [wfTrials, setWfTrials] = useState(30);
  const [report, setReport] = useState<Compare | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [search, followSearch] = useJob<Optimize>();
  const [walk, followWalk] = useJob<WalkForward>();

  useEffect(() => {
    void api<{ space: Space }>("/api/lab/scalper/space")
      .then((value) => {
        setSpace(value.space);
        setRanges(Object.fromEntries(Object.entries(value.space).map(([key, item]) => [key, { on: true, low: item.low, high: item.high }])));
      })
      .catch((reason) => setError(String(reason)));
  }, []);

  const tf = ["5m", "15m", "30m", "1h"].includes(settings.entry_timeframe) ? settings.entry_timeframe : "5m";
  const base = {
    timeframe: tf,
    settings: settings.st_scalper,
    capital: settings.capital,
    leverage: settings.max_leverage,
    fee_bps: settings.fee_bps,
    spread: settings.spread,
    slippage: settings.slippage,
    funding_bps: settings.funding_bps,
  };
  const chosenRanges = Object.fromEntries(Object.entries(ranges).filter(([, r]) => r.on).map(([key, r]) => [key, [r.low, r.high]]));
  const post = <T,>(path: string, body: object) => api<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  async function runCompare() {
    setBusy(true);
    setError("");
    try {
      setReport(await post<Compare>("/api/lab/scalper/compare", base));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  async function runSearch() {
    setError("");
    try {
      const { job } = await post<{ job: string }>("/api/lab/scalper/optimize", { ...base, ranges: chosenRanges, trials, min_trades: minTrades, max_drawdown_pct: maxDd });
      followSearch(job);
    } catch (reason) {
      setError(String(reason));
    }
  }
  async function runWalk() {
    setError("");
    try {
      const { job } = await post<{ job: string }>("/api/lab/scalper/walk-forward", {
        ...base,
        ranges: chosenRanges,
        trials: wfTrials,
        train_days: trainDays,
        test_days: testDays,
        min_trades: Math.max(5, Math.round(minTrades / 2)),
        max_drawdown_pct: maxDd,
      });
      followWalk(job);
    } catch (reason) {
      setError(String(reason));
    }
  }

  const running = (job: Job<unknown> | null) => !!job && !job.finished;
  return (
    <section className='setup-card lab' aria-label='Strategy lab'>
      <header>
        <span className='setup-step'>6</span>
        <div>
          <h2>Strategy lab</h2>
          <p>
            Research on {tf} candles with your trading costs. Data is split by time: <b>train 60%</b> (search), <b>validation 20%</b> (choose),{" "}
            <b>test 20%</b> (final check, never used to choose). Scores reward a positive average trade backed by enough trades, not win rate alone.
          </p>
        </div>
      </header>
      <div className='news-segment lab-tabs' role='tablist' aria-label='Lab tools'>
        {(
          [
            ["compare", "Compare filters"],
            ["search", "Parameter search"],
            ["walk", "Walk-forward"],
          ] as const
        ).map(([key, label]) => (
          <button key={key} type='button' role='tab' aria-pressed={tab === key} aria-selected={tab === key} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>
      {error && (
        <p className='error' role='alert'>
          {error}
        </p>
      )}

      {tab === "compare" && (
        <div className='lab-body'>
          <div className='lab-actions'>
            <button type='button' className='secondary' disabled={busy} onClick={() => void runCompare()}>
              {busy ? "Running…" : "Run comparison"}
            </button>
            <small>Six steps from SuperTrend-only to the full strategy, each on train / validation / test.</small>
          </div>
          {report && (
            <>
              <div className='table-scroll'>
                <table className='lab-table'>
                  <thead>
                    <tr>
                      <th rowSpan={2}>Step</th>
                      {(["train", "validation", "test"] as const).map((period) => (
                        <th key={period} colSpan={4}>
                          {period} <small>{day(report.periods[period][0])} → {day(report.periods[period][1])}</small>
                        </th>
                      ))}
                      <th rowSpan={2}>Net (all)</th>
                      <th rowSpan={2}>Max DD</th>
                    </tr>
                    <tr>
                      {(["train", "validation", "test"] as const).flatMap((period) =>
                        ["Trades", "Win", "PF", "Exp. R"].map((label) => <th key={period + label}>{label}</th>),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {report.variants.map((row) => (
                      <tr key={row.key}>
                        <td>{row.label}</td>
                        <MetricCells m={row.periods.train} />
                        <MetricCells m={row.periods.validation} />
                        <MetricCells m={row.periods.test} />
                        <td className={tone(row.all.netProfit)}>{fmt(row.all.netProfit, 0)}</td>
                        <td>{fmt(row.all.maxDrawdownPct, 1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className='lab-details'>
                {(["baseline", "full"] as const)
                  .filter((key) => report.details[key])
                  .map((key) => (
                    <div key={key} className='lab-detail-group'>
                      <h3>{key === "baseline" ? "SuperTrend only" : "Full strategy"} · all data</h3>
                      <div className='lab-breakdowns'>
                        <BreakdownTable title='Session' rows={report.details[key].session} />
                        <BreakdownTable title='Regime' rows={report.details[key].regime} />
                        <BreakdownTable title='Side' rows={report.details[key].side} />
                        <BreakdownTable title='Exit' rows={report.details[key].exit} />
                      </div>
                    </div>
                  ))}
              </div>
            </>
          )}
        </div>
      )}

      {tab !== "compare" && (
        <div className='lab-body'>
          <div className='lab-ranges'>
            {Object.entries(space).map(([key, item]) => {
              const range = ranges[key];
              if (!range) return null;
              return (
                <label key={key} className={range.on ? "" : "is-off"}>
                  <input type='checkbox' checked={range.on} onChange={(e) => setRanges({ ...ranges, [key]: { ...range, on: e.target.checked } })} />
                  <span>{LABELS[key] ?? key}</span>
                  <input
                    type='number'
                    aria-label={`${LABELS[key]} minimum`}
                    min={item.low}
                    max={range.high}
                    step={item.step}
                    value={range.low}
                    disabled={!range.on}
                    onChange={(e) => setRanges({ ...ranges, [key]: { ...range, low: Number(e.target.value) } })}
                  />
                  <i>to</i>
                  <input
                    type='number'
                    aria-label={`${LABELS[key]} maximum`}
                    min={range.low}
                    max={item.high}
                    step={item.step}
                    value={range.high}
                    disabled={!range.on}
                    onChange={(e) => setRanges({ ...ranges, [key]: { ...range, high: Number(e.target.value) } })}
                  />
                  <small>step {item.step}</small>
                </label>
              );
            })}
          </div>
          <div className='lab-actions'>
            {tab === "search" ? (
              <>
                <label>
                  Trials <input type='number' min={5} max={600} value={trials} onChange={(e) => setTrials(Number(e.target.value))} />
                </label>
                <label>
                  Min trades (train) <input type='number' min={1} max={10000} value={minTrades} onChange={(e) => setMinTrades(Number(e.target.value))} />
                </label>
                <label>
                  Max drawdown % <input type='number' min={1} max={100} value={maxDd} onChange={(e) => setMaxDd(Number(e.target.value))} />
                </label>
                <button type='button' disabled={running(search)} onClick={() => void runSearch()}>
                  {running(search) ? `Searching… ${Math.round((search?.progress ?? 0) * 100)}%` : "Search parameters"}
                </button>
              </>
            ) : (
              <>
                <label>
                  Train days <input type='number' min={10} max={365} value={trainDays} onChange={(e) => setTrainDays(Number(e.target.value))} />
                </label>
                <label>
                  Test days <input type='number' min={5} max={180} value={testDays} onChange={(e) => setTestDays(Number(e.target.value))} />
                </label>
                <label>
                  Trials per window <input type='number' min={5} max={200} value={wfTrials} onChange={(e) => setWfTrials(Number(e.target.value))} />
                </label>
                <button type='button' disabled={running(walk)} onClick={() => void runWalk()}>
                  {running(walk) ? `Running… ${Math.round((walk?.progress ?? 0) * 100)}%` : "Run walk-forward"}
                </button>
              </>
            )}
          </div>
          {tab === "search" && search && (
            <div className='lab-progress' aria-hidden={!running(search)}>
              <i style={{ width: `${Math.round(search.progress * 100)}%` }} />
            </div>
          )}
          {tab === "walk" && walk && (
            <div className='lab-progress'>
              <i style={{ width: `${Math.round(walk.progress * 100)}%` }} />
            </div>
          )}
          {tab === "search" && search?.error && <p className='error'>{search.error}</p>}
          {tab === "walk" && walk?.error && <p className='error'>{walk.error}</p>}

          {tab === "search" && search?.result && (
            <>
              <p className='lab-note'>
                {search.result.feasible} of {search.result.trials} parameter sets met the minimum trades and drawdown limit on train. Top sets by train score,
                re-checked on validation. <b>Chosen</b> = best validation, then most stable neighbours.
                {search.result.best && search.result.bestTest && (
                  <>
                    {" "}
                    Test period: chosen <b className={tone(search.result.bestTest.expectancyR)}>{signedR(search.result.bestTest.expectancyR)} R</b> over{" "}
                    {search.result.bestTest.trades} trades vs your current settings{" "}
                    <b className={tone(search.result.baseTest?.expectancyR)}>{signedR(search.result.baseTest?.expectancyR)} R</b> over {search.result.baseTest?.trades ?? 0}.
                  </>
                )}
              </p>
              <div className='table-scroll'>
                <table className='lab-table'>
                  <thead>
                    <tr>
                      <th rowSpan={2}>#</th>
                      <th rowSpan={2}>Parameters</th>
                      <th colSpan={4}>Train</th>
                      <th colSpan={4}>Validation</th>
                      <th rowSpan={2}>Neighbours</th>
                      <th rowSpan={2} />
                    </tr>
                    <tr>
                      {["Trades", "Win", "PF", "Exp. R", "Trades", "Win", "PF", "Exp. R"].map((label, index) => (
                        <th key={index}>{label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {search.result.ranked.map((row, index) => (
                      <tr key={index} className={search.result?.best === row || JSON.stringify(search.result?.best?.params) === JSON.stringify(row.params) ? "is-chosen" : ""}>
                        <td>{index + 1}</td>
                        <td className='lab-params'>
                          {Object.entries(row.params)
                            .map(([key, value]) => `${(LABELS[key] ?? key).replace("SuperTrend ", "ST ")} ${value}`)
                            .join(" · ")}
                        </td>
                        <MetricCells m={row.train} />
                        <MetricCells m={row.validation} />
                        <td title={`${row.neighbours ?? 0} nearby sets`}>{num(row.neighbourScore)}</td>
                        <td>
                          <button type='button' className='text-button' onClick={() => onApply(row.params)}>
                            Apply
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!search.result.ranked.length && <p className='lab-note'>No set passed the limits. Lower the minimum trades or widen the drawdown limit.</p>}
            </>
          )}

          {tab === "walk" && walk?.result && (
            <>
              <p className='lab-note'>
                Each window searches its train days, then trades the next test days with the chosen set. Joined test results:{" "}
                {walk.result.summary ? (
                  <>
                    <b>{walk.result.summary.trades} trades</b>, win {pct(walk.result.summary.winRate)}, PF {num(walk.result.summary.profitFactor)},{" "}
                    <b className={tone(walk.result.summary.expectancyR)}>{signedR(walk.result.summary.expectancyR)} R</b> per trade, net{" "}
                    <b className={tone(walk.result.summary.netProfit)}>{fmt(walk.result.summary.netProfit, 0)}</b>.
                  </>
                ) : (
                  "no trades."
                )}
              </p>
              <div className='table-scroll'>
                <table className='lab-table'>
                  <thead>
                    <tr>
                      <th rowSpan={2}>Test window</th>
                      <th rowSpan={2}>Chosen parameters</th>
                      <th colSpan={4}>Chosen set</th>
                      <th colSpan={4}>Your settings</th>
                    </tr>
                    <tr>
                      {["Trades", "Win", "PF", "Exp. R", "Trades", "Win", "PF", "Exp. R"].map((label, index) => (
                        <th key={index}>{label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {walk.result.windows.map((row) => (
                      <tr key={row.test[0]}>
                        <td>
                          {day(row.test[0])} → {day(row.test[1])}
                        </td>
                        <td className='lab-params'>
                          {Object.keys(row.params).length
                            ? Object.entries(row.params)
                                .map(([key, value]) => `${(LABELS[key] ?? key).replace("SuperTrend ", "ST ")} ${value}`)
                                .join(" · ")
                            : "none passed — your settings"}
                        </td>
                        <MetricCells m={row.test_metrics} />
                        <MetricCells m={row.default_metrics} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

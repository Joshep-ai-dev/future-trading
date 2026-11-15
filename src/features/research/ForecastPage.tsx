import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../../shared/api/api";
import { TIMEFRAME_CHOICES } from "../strategy/BBReversalSettings";
import { fmt } from "../../shared/types/types";
import ForwardForecastPanel from "./ForwardForecastPanel";
import ForecastPriceChart from "./ForecastPriceChart";
import "../../styles/forecast.css";

export type SavedForecastModel = {
  id: string;
  name: string;
  createdAt: number;
  trainedThrough: string;
  trainStart: string;
  trainingRows: number;
  epochsTrained: number | null;
  version?: number;
  validation?: {
    closeMae: number;
    baselineMae: number;
    skillPct: number | null;
    beatsBaseline: boolean;
    stage: string;
    directionAccuracy?: number;
    intervalCoverage?: number;
    probabilityDirectionAccuracy?: number | null;
  };
  calibration?: {
    shrink: number;
    coverage: number;
    coreImportancePct?: number;
  } | null;
  config: {
    model: string;
    timeframe: string;
    horizon: number;
    lookback: number;
    epochs: number;
    train_bars: number;
  };
};
type TestPoint = {
  originTime: number;
  targetTime: number;
  originClose: number;
  predictedClose: number;
  actualClose: number;
  predictedHigh: number;
  predictedLow: number;
  actualHigh: number;
  actualLow: number;
  predictedLowerBand?: number;
  predictedUpperBand?: number;
  upProbability?: number;
};
type TestResult = {
  modelId: string;
  metrics: {
    samples: number;
    closeMae: number;
    baselineMae: number;
    closeRmse: number;
    directionAccuracy: number;
    highMae: number;
    lowMae: number;
    skillPct?: number | null;
    beatsBaseline?: boolean;
    meanError?: number;
    intervalCoverage?: number;
    intervalWidth?: number;
    probabilityDirectionAccuracy?: number;
    confidentDirectionAccuracy?: number | null;
    confidentSamples?: number;
    brierScore?: number;
  };
  predictions: TestPoint[];
  note: string;
};
type Step = "train" | "historical" | "live";

const ARCHITECTURES: [string, string, string][] = [
  ["boost", "Quantile Boost", "ADX + Supertrend core · calibrated band and direction (recommended)"],
  ["extra_trees", "Extra Trees", "Tree ensemble on general indicators"],
  ["gru", "GRU", "Recurrent network over recent candles"],
  ["lstm", "LSTM", "Recurrent network over recent candles"],
  ["rnn", "RNN", "Simple recurrent network"],
];
const architectureLabel = (model: string) =>
  ARCHITECTURES.find(([value]) => value === model)?.[1] ?? model.toUpperCase();
const dayAfter = (value: string) =>
  new Date(Math.ceil(Date.parse(value) / 86400000) * 86400000).toISOString().slice(0, 10);
const dayOffset = (value: string, n: number) =>
  new Date(Date.parse(value) + n * 86400000).toISOString().slice(0, 10);
const stamp = (time: number) => new Date(time * 1000).toISOString().replace("T", " ").slice(0, 16);
const pct = (value: number | null | undefined, digits = 1) =>
  value == null || !Number.isFinite(value) ? "—" : `${fmt(value, digits)}%`;

/** Best honest headline number for a saved model. */
function modelScore(model: SavedForecastModel): { text: string; tone: "up" | "down" | "flat"; title: string } {
  const v = model.validation;
  if (v?.probabilityDirectionAccuracy != null)
    return {
      text: `${fmt(v.probabilityDirectionAccuracy, 1)}%`,
      tone: v.probabilityDirectionAccuracy > 52 ? "up" : v.probabilityDirectionAccuracy < 50 ? "down" : "flat",
      title: "Holdout direction accuracy (calibrated probability)",
    };
  if (v?.skillPct != null)
    return {
      text: `${v.skillPct >= 0 ? "+" : ""}${fmt(v.skillPct, 1)}%`,
      tone: v.skillPct > 0.5 ? "up" : v.skillPct < 0 ? "down" : "flat",
      title: "Holdout error improvement vs no-change baseline",
    };
  return { text: "—", tone: "flat", title: "No holdout diagnostic" };
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className='fc-field'>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

function Kpi({ label, value, tone, hint }: { label: string; value: string; tone?: "up" | "down"; hint?: string }) {
  return (
    <div className='fc-kpi' title={hint}>
      <span>{label}</span>
      <strong className={tone ? `is-${tone}` : undefined}>{value}</strong>
    </div>
  );
}

export default function ForecastPage({ range }: { range: { startDate: string; endDate: string } }) {
  const [step, setStep] = useState<Step>("train"),
    [models, setModels] = useState<SavedForecastModel[]>([]),
    [selectedId, setSelectedId] = useState("");
  const [config, setConfig] = useState({
    name: "Silver Quantile Boost",
    model: "boost",
    timeframe: "15m",
    training_end: dayOffset(range.endDate, -3),
    train_bars: 8000,
    lookback: 100,
    horizon: 12,
    epochs: 30,
  });
  const [dates, setDates] = useState({ start_date: dayOffset(range.endDate, -2), end_date: range.endDate });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [result, setResult] = useState<TestResult | null>(null);
  const selected = models.find((m) => m.id === selectedId);
  useEffect(() => {
    void api<SavedForecastModel[]>("/api/forecast/models")
      .then((rows) => {
        setModels(rows);
        if (rows.length) {
          choose(rows[0]);
          setStep("historical");
        }
      })
      .catch((e) => setError(String(e)));
  }, []);
  function choose(model: SavedForecastModel) {
    setSelectedId(model.id);
    setResult(null);
    const start = dayAfter(model.trainedThrough);
    setDates({ start_date: start, end_date: start > range.endDate ? start : range.endDate });
  }
  async function remove(model: SavedForecastModel) {
    if (!window.confirm(`Delete model "${model.name}"? Saved predictions stay.`)) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/forecast/models/${model.id}`, { method: "DELETE" });
      const remaining = models.filter((item) => item.id !== model.id);
      setModels(remaining);
      if (selectedId === model.id) {
        setResult(null);
        if (remaining.length) choose(remaining[0]);
        else {
          setSelectedId("");
          setStep("train");
        }
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function train(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const model = await api<SavedForecastModel>("/api/forecast/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      setModels((current) => [model, ...current]);
      choose(model);
      setStep("historical");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function test(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      setResult(
        await api<TestResult>(`/api/forecast/models/${selected.id}/test`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(dates),
        }),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  function download() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify({ model: selected, result }, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "silver-forecast-test.json";
    a.click();
    URL.revokeObjectURL(url);
  }
  const number = (key: "train_bars" | "lookback" | "horizon" | "epochs", label: string, min: number, max: number, hint?: string) => (
    <Field key={key} label={label} hint={hint}>
      <input
        required
        type='number'
        min={min}
        max={max}
        step={1}
        value={config[key]}
        onChange={(e) => setConfig({ ...config, [key]: Number(e.target.value) })}
      />
    </Field>
  );
  const sequence = !["boost", "extra_trees"].includes(config.model);
  const m = result?.metrics;
  const hasBand = !!result?.predictions.some((p) => p.predictedLowerBand != null);
  const hasProbability = !!result?.predictions.some((p) => p.upProbability != null);
  const shrunk = selected?.calibration?.shrink === 0;

  return (
    <section id='page-forecast' role='tabpanel' aria-labelledby='tab-forecast' className='forecast-page fc'>
      <header className='fc-topbar'>
        <div className='fc-title'>
          <h1>Forecast</h1>
          <span>XAG/USDT perpetual · prediction lab</span>
        </div>
        <div className='fc-tabs' role='tablist' aria-label='Forecast workflow'>
          {(
            [
              ["train", "Train"],
              ["historical", "Backtest"],
              ["live", "Live"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type='button'
              role='tab'
              aria-selected={step === key}
              disabled={busy || (key !== "train" && !selected)}
              onClick={() => {
                setStep(key);
                setError("");
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      <div className='fc-layout'>
        <aside className='fc-models' aria-label='Saved models'>
          <div className='fc-panel-head'>
            <span>Models</span>
            <small>{models.length}</small>
            <button
              type='button'
              className='fc-icon-button'
              title='Train a new model'
              aria-label='Train a new model'
              disabled={busy}
              onClick={() => setStep("train")}
            >
              <svg viewBox='0 0 18 18' aria-hidden='true'>
                <path d='M9 4v10M4 9h10' />
              </svg>
            </button>
          </div>
          {!models.length && <p className='fc-empty'>No models yet. Train one to unlock Backtest and Live.</p>}
          <ul className='fc-model-list'>
            {models.map((model) => {
              const score = modelScore(model);
              return (
                <li key={model.id} className={model.id === selectedId ? "is-selected" : undefined}>
                  <button
                    type='button'
                    className='fc-model-row'
                    disabled={busy}
                    aria-pressed={model.id === selectedId}
                    onClick={() => {
                      choose(model);
                      if (step === "train") setStep("historical");
                    }}
                  >
                    <span className='fc-model-name'>{model.name}</span>
                    <span className={`fc-score is-${score.tone}`} title={score.title}>
                      {score.text}
                    </span>
                    <span className='fc-model-meta'>
                      {architectureLabel(model.config.model)} · {model.config.timeframe} · {model.config.horizon} bars
                    </span>
                    <span className='fc-model-meta'>Trained to {model.trainedThrough.slice(0, 10)}</span>
                  </button>
                  <button
                    type='button'
                    className='fc-model-remove'
                    disabled={busy}
                    aria-label={`Delete model ${model.name}`}
                    title='Delete model'
                    onClick={() => void remove(model)}
                  >
                    <svg viewBox='0 0 18 18' aria-hidden='true'>
                      <path d='M4.5 4.5l9 9M13.5 4.5l-9 9' />
                    </svg>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        <main className='fc-main'>
          {error && (
            <p className='fc-alert is-error' role='alert'>
              {error}
            </p>
          )}

          {selected && step !== "train" && (
            <div className='fc-summary'>
              <div className='fc-summary-name'>
                <strong>{selected.name}</strong>
                <span>
                  {architectureLabel(selected.config.model)} · {selected.config.timeframe} · {selected.config.horizon}-candle
                  horizon · {selected.trainingRows.toLocaleString()} samples
                </span>
              </div>
              <Kpi label='Trained through' value={`${selected.trainedThrough.slice(0, 16).replace("T", " ")}`} />
              <Kpi
                label='Holdout skill'
                value={
                  selected.validation?.skillPct == null
                    ? "—"
                    : `${selected.validation.skillPct >= 0 ? "+" : ""}${fmt(selected.validation.skillPct, 1)}%`
                }
                tone={selected.validation?.skillPct == null ? undefined : selected.validation.skillPct > 0 ? "up" : selected.validation.skillPct < 0 ? "down" : undefined}
                hint='Close-price error improvement vs predicting no change'
              />
              <Kpi
                label='Direction'
                value={pct(selected.validation?.probabilityDirectionAccuracy ?? selected.validation?.directionAccuracy)}
                hint='Holdout share of correct up/down calls'
              />
              {selected.validation?.intervalCoverage != null && (
                <Kpi label='80% band hit' value={pct(selected.validation.intervalCoverage)} hint='Holdout share of outcomes inside the 80% band' />
              )}
              {selected.calibration?.coreImportancePct != null && (
                <Kpi label='ADX + Supertrend' value={pct(selected.calibration.coreImportancePct, 0)} hint='Share of model gain from ADX/DMI and Supertrend features' />
              )}
            </div>
          )}

          {step === "train" && (
            <form className='fc-panel' onSubmit={(e) => void train(e)}>
              <div className='fc-panel-title'>
                <h2>New forecast model</h2>
                <p>
                  Trains on candles up to the cutoff date, checks itself on a held-back tail, then saves. Backtests and live
                  forecasts never retrain it.
                </p>
              </div>
              <fieldset disabled={busy} className='fc-grid'>
                <Field label='Model name'>
                  <input required maxLength={80} value={config.name} onChange={(e) => setConfig({ ...config, name: e.target.value })} />
                </Field>
                <Field label='Method' hint={ARCHITECTURES.find(([value]) => value === config.model)?.[2]}>
                  <select
                    value={config.model}
                    onChange={(e) => {
                      const model = e.target.value;
                      const auto = ARCHITECTURES.some(([, label]) => config.name === `Silver ${label}`);
                      setConfig({ ...config, model, name: auto ? `Silver ${architectureLabel(model)}` : config.name });
                    }}
                  >
                    {ARCHITECTURES.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                        {value === "boost" ? " (recommended)" : ""}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label='Timeframe'>
                  <select value={config.timeframe} onChange={(e) => setConfig({ ...config, timeframe: e.target.value })}>
                    {TIMEFRAME_CHOICES.map((tf) => (
                      <option key={tf}>{tf}</option>
                    ))}
                  </select>
                </Field>
                <Field label='Training cutoff (UTC)'>
                  <input
                    required
                    type='date'
                    min={range.startDate}
                    max={range.endDate}
                    value={config.training_end}
                    onChange={(e) => setConfig({ ...config, training_end: e.target.value })}
                  />
                </Field>
                {number("train_bars", "Training candles", 500, 50000, "More history usually helps boosting")}
                {number("horizon", "Horizon (candles)", 1, 100)}
                {sequence && number("lookback", "Observed candles", 1, 500)}
                {sequence && number("epochs", "Max epochs", 1, 100)}
              </fieldset>
              <div className='fc-actions'>
                <button type='submit' className='fc-primary' disabled={busy}>
                  {busy ? "Training…" : "Train & save"}
                </button>
                {busy && <span className='fc-muted'>Learning from past candles. Neural models can take several minutes.</span>}
              </div>
            </form>
          )}

          {step === "historical" && selected && (
            <>
              <form className='fc-panel fc-inline' onSubmit={(e) => void test(e)}>
                <fieldset disabled={busy} className='fc-grid fc-grid-tight'>
                  <Field label='Test start (UTC)'>
                    <input
                      type='date'
                      required
                      min={dayAfter(selected.trainedThrough)}
                      max={dates.end_date}
                      value={dates.start_date}
                      onChange={(e) => {
                        setDates({ ...dates, start_date: e.target.value });
                        setResult(null);
                      }}
                    />
                  </Field>
                  <Field label='Test end (UTC)'>
                    <input
                      type='date'
                      required
                      min={dates.start_date}
                      max={range.endDate}
                      value={dates.end_date}
                      onChange={(e) => {
                        setDates({ ...dates, end_date: e.target.value });
                        setResult(null);
                      }}
                    />
                  </Field>
                </fieldset>
                <div className='fc-actions'>
                  <button type='submit' className='fc-primary' disabled={busy}>
                    {busy ? "Running…" : "Run backtest"}
                  </button>
                  {result && (
                    <button type='button' className='fc-secondary' onClick={download}>
                      Export
                    </button>
                  )}
                </div>
              </form>
              {selected.version === 1 && (
                <p className='fc-alert'>Legacy model: train a new one for holdout diagnostics and multi-step paths.</p>
              )}
              {result && m && (
                <>
                  {shrunk && hasProbability && (
                    <p className='fc-alert'>
                      The held-back check found no reliable edge in move size, so the price estimate stays at “no change”. Use the
                      direction probability and the 80% band instead.
                    </p>
                  )}
                  {m.beatsBaseline === false && !shrunk && (
                    <p className='fc-alert is-error'>
                      No price-error advantage in this period: predicting “no change” had lower error.
                    </p>
                  )}
                  <div className='fc-kpis'>
                    <Kpi label='Predictions' value={m.samples.toLocaleString()} />
                    {hasProbability && (
                      <Kpi
                        label='Direction (probability)'
                        value={pct(m.probabilityDirectionAccuracy)}
                        tone={m.probabilityDirectionAccuracy != null && m.probabilityDirectionAccuracy > 52 ? "up" : undefined}
                      />
                    )}
                    {hasProbability && (
                      <Kpi
                        label={`Confident ${m.confidentSamples ?? ""}`}
                        value={pct(m.confidentDirectionAccuracy)}
                        tone={m.confidentDirectionAccuracy != null && m.confidentDirectionAccuracy > 52 ? "up" : undefined}
                        hint='Direction accuracy on the 30% most confident calls'
                      />
                    )}
                    {hasBand && <Kpi label='80% band hit' value={pct(m.intervalCoverage)} hint='Target is about 80%' />}
                    {!hasProbability && <Kpi label='Direction' value={pct(m.directionAccuracy)} />}
                    <Kpi
                      label='Skill vs no change'
                      value={m.skillPct == null ? "—" : `${m.skillPct >= 0 ? "+" : ""}${fmt(m.skillPct, 2)}%`}
                      tone={m.skillPct != null && m.skillPct > 0 ? "up" : m.skillPct != null && m.skillPct < 0 ? "down" : undefined}
                    />
                    <Kpi label='Close MAE' value={fmt(m.closeMae, 4)} />
                    <Kpi label='No-change MAE' value={fmt(m.baselineMae, 4)} />
                    {m.brierScore != null && <Kpi label='Brier score' value={fmt(m.brierScore, 3)} hint='Lower is better; 0.25 = coin flip' />}
                    <Kpi label='Bias' value={m.meanError == null ? "—" : fmt(m.meanError, 4)} />
                  </div>
                  <ForecastPriceChart
                    history={result.predictions.map((p) => ({ time: p.targetTime, close: p.actualClose }))}
                    predictions={result.predictions.map((p) => ({ time: p.targetTime, close: p.predictedClose }))}
                    band={
                      hasBand
                        ? result.predictions.map((p) => ({ time: p.targetTime, low: p.predictedLowerBand!, high: p.predictedUpperBand! }))
                        : []
                    }
                  />
                  <details className='fc-panel fc-details'>
                    <summary>Prediction table (latest 100)</summary>
                    <div className='table-scroll'>
                      <table className='fc-table'>
                        <thead>
                          <tr>
                            <th>Target (UTC)</th>
                            <th>Start</th>
                            <th>Predicted</th>
                            {hasBand && <th>80% band</th>}
                            {hasProbability && <th>P(up)</th>}
                            <th>Actual</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.predictions
                            .slice(-100)
                            .reverse()
                            .map((p) => (
                              <tr key={p.originTime}>
                                <td>{stamp(p.targetTime)}</td>
                                <td>{fmt(p.originClose, 3)}</td>
                                <td>{fmt(p.predictedClose, 3)}</td>
                                {hasBand && (
                                  <td>
                                    {fmt(p.predictedLowerBand ?? null, 3)} – {fmt(p.predictedUpperBand ?? null, 3)}
                                  </td>
                                )}
                                {hasProbability && (
                                  <td className={p.upProbability != null && p.upProbability >= 0.5 ? "is-up" : "is-down"}>
                                    {pct((p.upProbability ?? NaN) * 100, 0)}
                                  </td>
                                )}
                                <td className={p.actualClose >= p.originClose ? "is-up" : "is-down"}>{fmt(p.actualClose, 3)}</td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                  <p className='fc-muted fc-note'>{result.note}</p>
                </>
              )}
            </>
          )}

          {step === "live" && selected && <ForwardForecastPanel key={selected.id} selectedModel={selected} />}
        </main>
      </div>
    </section>
  );
}

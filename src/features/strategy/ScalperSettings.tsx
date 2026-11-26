import type { FormEvent, ReactNode } from "react";
import type { BacktestSettings } from "../../shared/types/types";
import { Field, SettingsCard, TIMEFRAME_CHOICES, Toggle } from "./BBReversalSettings";
import TradingCostsCard from "./TradingCostsCard";
import StrategyLab from "./StrategyLab";
import { stScalperDefaults } from "./strategyDefaults";

type Config = BacktestSettings["st_scalper"];
const SESSIONS: [Config["sessions"][number], string, string][] = [
  ["asia", "Asia", "00–07 UTC"],
  ["london", "London", "07–12 UTC"],
  ["overlap", "London–NY overlap", "12–16 UTC"],
  ["newyork", "New York", "16–21 UTC"],
  ["late", "Late US", "21–24 UTC"],
];
const PRESETS: [string, number | null][] = [["1M", 1], ["3M", 3], ["6M", 6], ["1Y", 12], ["All", null]];
function presetStart(range: { startDate: string; endDate: string }, months: number | null) {
  if (months === null) return range.startDate;
  const date = new Date(range.endDate + "T00:00:00Z");
  date.setUTCMonth(date.getUTCMonth() - months);
  const start = date.toISOString().slice(0, 10);
  return start < range.startDate ? range.startDate : start;
}

function Filter({ title, description, checked, onChange, children }: { title: string; description: string; checked: boolean; onChange: (value: boolean) => void; children?: ReactNode }) {
  return (
    <section className={checked ? "adx-st-filter" : "adx-st-filter is-off"}>
      <header>
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        <Toggle label={title} checked={checked} onChange={onChange} />
      </header>
      {checked && children && <div className='adx-st-filter-fields'>{children}</div>}
    </section>
  );
}

/** Bot settings for the SuperTrend Scalper (server/strategies/st_scalper.py) plus the strategy lab. */
export default function ScalperSettings({
  settings,
  onChange,
  onRun,
  busy,
  range,
}: {
  settings: BacktestSettings;
  onChange: (settings: BacktestSettings) => void;
  onRun: () => void;
  busy: boolean;
  range: { startDate: string; endDate: string };
}) {
  const config: Config = { ...stScalperDefaults, ...settings.st_scalper };
  const set = (patch: Partial<Config>) => onChange({ ...settings, st_scalper: { ...config, ...patch } });
  const num = (key: keyof Config, label: string, min: number, max: number, step: number | "any" = 1, unit?: string, hint?: string) => (
    <Field key={key} label={label} unit={unit} hint={hint}>
      <input type='number' required min={min} max={max} step={step} value={config[key] as number} onChange={(e) => set({ [key]: Number(e.target.value) } as Partial<Config>)} />
    </Field>
  );
  const days = Math.round((Date.parse(settings.end_date) - Date.parse(settings.start_date)) / 86400000);
  const filters = [config.use_trend_filter, config.use_adx_filter, config.use_rsi_filter, config.use_volatility_filter, config.use_session_filter, config.use_news_filter, config.use_regime_filter, config.use_volume_filter].filter(Boolean).length;
  function submit(event: FormEvent) {
    event.preventDefault();
    onRun();
  }
  return (
    <form className='setup-layout adx-st-settings' onSubmit={submit}>
      <div className='setup-main'>
        <SettingsCard
          step={1}
          title='Signal'
          description='Enter at the next open after a completed candle flips SuperTrend and ATR is above the minimum.'
        >
          <div className='setup-grid'>
            {num("st_length", "SuperTrend ATR length", 2, 200)}
            {num("st_multiplier", "SuperTrend multiplier", 0.1, 20, "any")}
            {num("atr_length", "ATR length", 2, 200)}
            <Field label='Minimum ATR' hint='The signal candle’s ATR must be strictly above this value in price units.'>
              <input type='number' required min={0} step='any' value={config.atr_min} onChange={(e) => set({ atr_min: Number(e.target.value) })} />
            </Field>
            <Field label='Trade direction'>
              <select value={config.trade_mode} onChange={(e) => set({ trade_mode: e.target.value as Config["trade_mode"] })}>
                <option>Both</option>
                <option>Long Only</option>
                <option>Short Only</option>
              </select>
            </Field>
            {num("risk_pct", "Risk per trade", 0.01, 10, "any", "%", "Equity lost if the initial stop is hit (capped by leverage).")}
            <Field label='Starting balance' unit='USDT'>
              <input type='number' required min={1} max={1e9} step='any' value={settings.capital} onChange={(e) => onChange({ ...settings, capital: Number(e.target.value) })} />
            </Field>
          </div>
        </SettingsCard>

        <SettingsCard step={2} title='Optional filters' description={`${filters} of 8 on.`}>
          <div className='adx-st-filters'>
            <Filter title='Trend' description='Compare the close with its EMA on the execution and higher timeframes.' checked={config.use_trend_filter} onChange={(v) => set({ use_trend_filter: v })}>
              {num("ema_fast_length", "Execution EMA", 2, 500)}
              {num("htf_ema_length", "Higher timeframe EMA", 2, 1000)}
              <Field label='Higher timeframe'>
                <select value={config.htf_timeframe} onChange={(e) => set({ htf_timeframe: e.target.value as Config["htf_timeframe"] })}>
                  {["15m", "30m", "1h"].map((tf) => <option key={tf}>{tf}</option>)}
                </select>
              </Field>
            </Filter>
            <Filter title='ADX' description='Trend strength above the threshold.' checked={config.use_adx_filter} onChange={(v) => set({ use_adx_filter: v })}>
              {num("adx_length", "ADX length", 2, 200)}
              {num("adx_threshold", "Threshold", 0, 100, 0.5)}
            </Filter>
            <Filter title='RSI' description='Momentum band: long 50–70, short 30–50 by default.' checked={config.use_rsi_filter} onChange={(v) => set({ use_rsi_filter: v })}>
              {num("rsi_long_min", "Long min", 0, 100, 0.5)}
              {num("rsi_long_max", "Long max", 0, 100, 0.5)}
              {num("rsi_short_min", "Short min", 0, 100, 0.5)}
              {num("rsi_short_max", "Short max", 0, 100, 0.5)}
            </Filter>
            <Filter title='Volatility' description='ATR/price percentile over a rolling window: skip very quiet and extreme markets.' checked={config.use_volatility_filter} onChange={(v) => set({ use_volatility_filter: v })}>
              {num("atr_window", "Window (candles)", 50, 20000)}
              {num("atr_pct_min", "Min percentile", 0, 100, 1, "%")}
              {num("atr_pct_max", "Max percentile", 0, 100, 1, "%")}
            </Filter>
            <Filter title='Market regime' description='Longs only in a strong bullish trend, shorts only in a strong bearish one (ADX, DI, EMA slope, 15m trend).' checked={config.use_regime_filter} onChange={(v) => set({ use_regime_filter: v })} />
            <Filter title='Session' description='Only open trades in the selected UTC sessions.' checked={config.use_session_filter} onChange={(v) => set({ use_session_filter: v })}>
              <div className='chip-group lab-sessions' role='group' aria-label='Sessions'>
                {SESSIONS.map(([key, label, hours]) => {
                  const on = config.sessions.includes(key);
                  return (
                    <button key={key} type='button' role='checkbox' aria-checked={on} title={hours} onClick={() => set({ sessions: on ? config.sessions.filter((s) => s !== key) : [...config.sessions, key] })}>
                      {label}
                    </button>
                  );
                })}
              </div>
            </Filter>
            <Filter title='Economic news' description='No new trades around US CPI, NFP, FOMC and press conferences (high) or PPI, retail sales, GDP/PCE, minutes (medium).' checked={config.use_news_filter} onChange={(v) => set({ use_news_filter: v })}>
              {num("news_high_before", "High: minutes before", 0, 600)}
              {num("news_high_after", "High: minutes after", 0, 600)}
              {num("news_medium_before", "Medium: minutes before", 0, 600)}
              {num("news_medium_after", "Medium: minutes after", 0, 600)}
            </Filter>
            <Filter title='Volume' description='Optional: candle volume above its moving average.' checked={config.use_volume_filter} onChange={(v) => set({ use_volume_filter: v })}>
              {num("volume_sma", "Average length", 2, 500)}
              {num("volume_mult", "Multiple", 0, 20, "any", "×")}
            </Filter>
          </div>
        </SettingsCard>

        <SettingsCard
          step={3}
          title='Exits'
          description='Stops and targets from ATR at the signal candle. Break-even and trailing move the stop at a candle close (from the next candle), never above the market.'
          actions={<Toggle label='ATR exits' checked={config.use_atr_exits} onChange={(v) => set({ use_atr_exits: v })} />}
        >
          {config.use_atr_exits ? (
            <div className='setup-grid'>
              {num("stop_atr", "Stop-loss", 0.1, 20, "any", "× ATR")}
              {num("target_atr", "Take-profit", 0.1, 50, "any", "× ATR")}
              {num("breakeven_atr", "Break-even at", 0, 50, "any", "× ATR", "0 = off")}
              {num("trail_atr", "Trail from", 0, 50, "any", "× ATR", "0 = off")}
              {num("trail_distance_atr", "Trail distance", 0.1, 50, "any", "× ATR")}
              {num("max_hold_bars", "Max hold", 1, 500, 1, "candles")}
              <Field label='Exit on opposite flip'>
                <Toggle label='Exit on opposite SuperTrend flip' checked={config.exit_on_flip} onChange={(v) => set({ exit_on_flip: v })} />
              </Field>
            </div>
          ) : (
            <p className='lab-note'>Exit on the opposite SuperTrend flip. Reverse when the new entry passes the ATR minimum and any enabled filters.</p>
          )}
        </SettingsCard>

        <TradingCostsCard settings={settings} onChange={onChange} step={4} />

        <StrategyLab
          settings={{ ...settings, st_scalper: config }}
          onApply={(params) => set(params as Partial<Config>)}
        />
      </div>

      <aside className='setup-aside adx-st-aside'>
        <section className='setup-summary'>
          <h2>Backtest period</h2>
          <div className='chip-group' role='radiogroup' aria-label='Period preset'>
            {PRESETS.map(([label, months]) => {
              const start = presetStart(range, months);
              return (
                <button key={label} type='button' role='radio' aria-checked={settings.start_date === start && settings.end_date === range.endDate} onClick={() => onChange({ ...settings, start_date: start, end_date: range.endDate })}>
                  {label}
                </button>
              );
            })}
          </div>
          <div className='setup-dates'>
            <Field label='Start (UTC)'>
              <input type='date' required min={range.startDate} max={settings.end_date} value={settings.start_date} onChange={(e) => onChange({ ...settings, start_date: e.target.value })} />
            </Field>
            <Field label='End (UTC)'>
              <input type='date' required min={settings.start_date} max={range.endDate} value={settings.end_date} onChange={(e) => onChange({ ...settings, end_date: e.target.value })} />
            </Field>
          </div>
          <small className='setup-note'>{days > 0 ? `${days} days` : "Choose an end date after the start date"}</small>
          <div className='setup-field'>
            <span className='setup-label'>Timeframe</span>
            <div className='chip-group' role='radiogroup' aria-label='Execution timeframe'>
              {TIMEFRAME_CHOICES.filter((tf) => ["5m", "15m", "30m", "1h"].includes(tf)).map((tf) => (
                <button key={tf} type='button' role='radio' aria-checked={settings.entry_timeframe === tf} onClick={() => onChange({ ...settings, entry_timeframe: tf })}>
                  {tf}
                </button>
              ))}
            </div>
          </div>
        </section>
        <section className='setup-summary'>
          <h2>Summary</h2>
          <dl>
            <div><dt>Strategy</dt><dd>SuperTrend Scalper</dd></div>
            <div><dt>SuperTrend</dt><dd>{config.st_length} / {config.st_multiplier}</dd></div>
            <div><dt>ATR gate</dt><dd>ATR({config.atr_length}) &gt; {config.atr_min}</dd></div>
            <div><dt>Optional filters</dt><dd>{filters} of 8 on</dd></div>
            <div><dt>Exits</dt><dd>{config.use_atr_exits ? `SL ${config.stop_atr} · TP ${config.target_atr} ATR` : "Stop and reverse"}</dd></div>
            <div><dt>Risk</dt><dd>{config.risk_pct}% per trade</dd></div>
            <div><dt>Balance</dt><dd>{settings.capital.toLocaleString()} USDT</dd></div>
          </dl>
          <button type='submit' className='setup-run' disabled={busy || days <= 0}>
            {busy ? "Running backtest…" : "Run backtest"}
          </button>
          <small className='setup-note'>Backtests and paper trading only. Live trading stays off until the strategy is validated.</small>
        </section>
      </aside>
    </form>
  );
}

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../../shared/api/api";
import type { BacktestSettings } from "../../shared/types/types";
import { Field, SettingsCard, TIMEFRAME_CHOICES, Toggle } from "./BBReversalSettings";
import TradingCostsCard from "./TradingCostsCard";

type Config = BacktestSettings["adx_supertrend"];
type ForecastModel = { id: string; name: string; trainedThrough: string; config: { model: string; timeframe: string; horizon: number } };

const PRESETS: [string, number | null][] = [["1M", 1], ["3M", 3], ["6M", 6], ["1Y", 12], ["All", null]];
/** Start date for a preset ending at the last available day, clamped to the first available day. */
function presetStart(range: { startDate: string; endDate: string }, months: number | null) {
  if (months === null) return range.startDate;
  const date = new Date(range.endDate + "T00:00:00Z");
  date.setUTCMonth(date.getUTCMonth() - months);
  const start = date.toISOString().slice(0, 10);
  return start < range.startDate ? range.startDate : start;
}

/** One minor filter: title, on/off switch, description, and its inputs when on. */
function FilterCard({ title, description, checked, onChange, children }: { title: string; description: string; checked: boolean; onChange: (value: boolean) => void; children: ReactNode }) {
  return (
    <section className={checked ? "adx-st-filter" : "adx-st-filter is-off"}>
      <header>
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        <Toggle label={title} checked={checked} onChange={onChange} />
      </header>
      {checked && <div className='adx-st-filter-fields'>{children}</div>}
    </section>
  );
}

/** Bot settings for the ADX + Supertrend strategy (server/strategies/adx_supertrend.py). */
export default function AdxSupertrendSettings({
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
  const config = settings.adx_supertrend;
  const set = (patch: Partial<Config>) => onChange({ ...settings, adx_supertrend: { ...config, ...patch } });
  const [models, setModels] = useState<ForecastModel[]>([]);
  useEffect(() => {
    void api<ForecastModel[]>("/api/forecast/models")
      .then((rows) => setModels(rows.filter((row) => row.config.model === "boost")))
      .catch(() => setModels([]));
  }, []);
  const usable = models.filter((model) => model.config.timeframe === settings.entry_timeframe);
  const chosen = models.find((model) => model.id === config.forecast_model_id);
  const lookAhead = chosen && chosen.trainedThrough.slice(0, 10) > settings.start_date;
  const num = (key: keyof Config, label: string, min: number, max: number, step: number | "any" = 1, hint?: string, unit?: string) => (
    <Field key={key} label={label} hint={hint} unit={unit}>
      <input
        type='number'
        required
        min={min}
        max={max}
        step={step}
        value={config[key] as number}
        onChange={(e) => set({ [key]: Number(e.target.value) } as Partial<Config>)}
      />
    </Field>
  );
  const days = Math.round((Date.parse(settings.end_date) - Date.parse(settings.start_date)) / 86400000);
  const activeFilters = [config.htf_filter, config.atr_filter, config.rsi_filter, config.forecast_filter].filter(Boolean).length;
  function submit(event: FormEvent) {
    event.preventDefault();
    onRun();
  }
  return (
    <form className='setup-layout adx-st-settings' onSubmit={submit}>
      <div className='setup-main'>
      <SettingsCard
        step={1}
        title='Account and sizing'
        description='Enters in the Supertrend direction when ADX is at or above the threshold and rising, on an ADX cross or a Supertrend flip. The stop follows the Supertrend line and an opposite flip closes the trade.'
      >
        <div className='setup-grid'>
          <Field label='Trade direction'>
            <select value={config.trade_mode} onChange={(e) => set({ trade_mode: e.target.value as Config["trade_mode"] })}>
              <option>Both</option>
              <option>Long Only</option>
              <option>Short Only</option>
            </select>
          </Field>
          <Field label='Starting balance' unit='USDT'>
            <input
              type='number'
              required
              min={1}
              max={1e9}
              step='any'
              value={settings.capital}
              onChange={(e) => onChange({ ...settings, capital: Number(e.target.value) })}
            />
          </Field>
          <Field label='Leverage' unit='×'>
            <input
              type='number'
              required
              min={1}
              max={100}
              step={0.5}
              value={settings.max_leverage}
              onChange={(e) => onChange({ ...settings, max_leverage: Number(e.target.value) })}
            />
          </Field>
          <Field label='Amount per trade' hint={config.amount_unit === "percent" ? "Share of balance, before leverage." : "Fixed USDT, capped at balance."}>
            <span className='input-with-unit'>
              <input
                type='number'
                required
                min={0.01}
                max={config.amount_unit === "percent" ? 100 : settings.capital}
                step='any'
                value={config.amount_per_trade}
                onChange={(e) => set({ amount_per_trade: Number(e.target.value) })}
              />
              <select aria-label='Amount unit' value={config.amount_unit} onChange={(e) => set({ amount_unit: e.target.value as Config["amount_unit"] })}>
                <option value='percent'>%</option>
                <option value='price'>$</option>
              </select>
            </span>
          </Field>
        </div>
      </SettingsCard>

      <SettingsCard step={2} title='Core: ADX' description='Pine ta.dmi(DI length, ADX smoothing). Trades need ADX at or above the threshold and higher than N candles ago.'>
        <div className='setup-grid'>
          {num("di_length", "DI length", 1, 500)}
          {num("adx_length", "ADX smoothing", 1, 500)}
          {num("adx_threshold", "ADX threshold", 0, 100, 0.5)}
          {num("adx_rising_bars", "Rising vs N candles ago", 1, 50)}
          <Field label='Require +DI / −DI agreement' hint='Long only when +DI > −DI, short only when −DI > +DI.'>
            <Toggle label='Require DI agreement' checked={config.require_di_agreement} onChange={(value) => set({ require_di_agreement: value })} />
          </Field>
        </div>
      </SettingsCard>

      <SettingsCard step={3} title='Core: Supertrend' description='Direction, trigger on flips, and the trailing stop line.'>
        <div className='setup-grid'>
          {num("st_length", "ATR length", 1, 500)}
          {num("st_multiplier", "Factor", 0.01, 100, "any")}
        </div>
      </SettingsCard>

      <SettingsCard
        step={4}
        title='Minor filters'
        description='Each filter can only block an entry. Turn any of them off to compare.'
        actions={<span className='adx-st-count'>{activeFilters} of 4 on</span>}
      >
        <div className='adx-st-filters'>
          <FilterCard
            title='Higher-timeframe trend'
            description='Trade only with the higher-timeframe Supertrend (closed candles only).'
            checked={config.htf_filter}
            onChange={(value) => set({ htf_filter: value })}
          >
            <Field label='Higher timeframe'>
              <select value={config.htf_timeframe} onChange={(e) => set({ htf_timeframe: e.target.value as Config["htf_timeframe"] })}>
                {["15m", "30m", "1h", "4h", "1d"].map((tf) => (
                  <option key={tf}>{tf}</option>
                ))}
              </select>
            </Field>
          </FilterCard>
          <FilterCard
            title='Volatility (ATR)'
            description='Skip trades when ATR/price is unusually low (choppy) or extreme, by percentile over a rolling window.'
            checked={config.atr_filter}
            onChange={(value) => set({ atr_filter: value })}
          >
            {num("atr_length", "ATR length", 1, 500)}
            {num("atr_window", "Percentile window", 20, 5000)}
            {num("atr_min_pct", "Min percentile", 0, 100, 1, undefined, "%")}
            {num("atr_max_pct", "Max percentile", 0, 100, 1, undefined, "%")}
          </FilterCard>
          <FilterCard
            title='RSI extremes'
            description='Skip longs when RSI is overbought and shorts when oversold.'
            checked={config.rsi_filter}
            onChange={(value) => set({ rsi_filter: value })}
          >
            {num("rsi_length", "RSI length", 1, 500)}
            {num("rsi_overbought", "Overbought", 0, 100, 0.5)}
            {num("rsi_oversold", "Oversold", 0, 100, 0.5)}
          </FilterCard>
          <FilterCard
            title='Forecast probability'
            description="Require a saved Quantile Boost model's calibrated direction probability to agree. The model must use the same timeframe and be trained before the backtest start."
            checked={config.forecast_filter}
            onChange={(value) => set({ forecast_filter: value, forecast_model_id: value ? config.forecast_model_id || usable[0]?.id || "" : config.forecast_model_id })}
          >
            <Field label='Forecast model' hint={usable.length ? undefined : `No Quantile Boost model for ${settings.entry_timeframe}. Train one on the Forecast page.`}>
              <select required value={config.forecast_model_id} onChange={(e) => set({ forecast_model_id: e.target.value })}>
                <option value='' disabled>
                  Choose a model
                </option>
                {usable.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name} · {model.config.horizon} bars · to {model.trainedThrough.slice(0, 10)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label='Minimum probability' unit='%'>
              <input
                type='number'
                required
                min={50}
                max={100}
                step={1}
                value={Math.round(config.forecast_min_probability * 100)}
                onChange={(e) => set({ forecast_min_probability: Number(e.target.value) / 100 })}
              />
            </Field>
            {lookAhead && (
              <p className='error adx-st-wide' role='alert'>
                This model was trained through {chosen!.trainedThrough.slice(0, 10)}, after the backtest start. Move the start date later or train an earlier model.
              </p>
            )}
          </FilterCard>
        </div>
      </SettingsCard>

      <TradingCostsCard settings={settings} onChange={onChange} step={5} />

      </div>

      <aside className='setup-aside adx-st-aside'>
        <section className='setup-summary'>
          <h2>Backtest period</h2>
          <div className='chip-group' role='radiogroup' aria-label='Period preset'>
            {PRESETS.map(([label, months]) => {
              const start = presetStart(range, months);
              return (
                <button
                  key={label}
                  type='button'
                  role='radio'
                  aria-checked={settings.start_date === start && settings.end_date === range.endDate}
                  onClick={() => onChange({ ...settings, start_date: start, end_date: range.endDate })}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <div className='setup-dates'>
            <Field label='Start (UTC)'>
              <input
                type='date'
                required
                min={range.startDate}
                max={settings.end_date}
                value={settings.start_date}
                onChange={(e) => onChange({ ...settings, start_date: e.target.value })}
              />
            </Field>
            <Field label='End (UTC)'>
              <input
                type='date'
                required
                min={settings.start_date}
                max={range.endDate}
                value={settings.end_date}
                onChange={(e) => onChange({ ...settings, end_date: e.target.value })}
              />
            </Field>
          </div>
          <small className='setup-note'>
            {days > 0 ? `${days} days` : 'Choose an end date after the start date'} · data available {range.startDate} → {range.endDate}
          </small>
          <div className='setup-field'>
            <span className='setup-label'>Timeframe</span>
            <div className='chip-group' role='radiogroup' aria-label='Execution timeframe'>
              {TIMEFRAME_CHOICES.map((tf) => (
                <button
                  key={tf}
                  type='button'
                  role='radio'
                  aria-checked={settings.entry_timeframe === tf}
                  onClick={() => onChange({ ...settings, entry_timeframe: tf })}
                >
                  {tf}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className='setup-summary'>
          <h2>Summary</h2>
          <dl>
            <div><dt>Strategy</dt><dd>ADX + Supertrend</dd></div>
            <div><dt>Entry</dt><dd>ADX ≥ {config.adx_threshold}, rising</dd></div>
            <div><dt>Supertrend</dt><dd>{config.st_length} / {config.st_multiplier}</dd></div>
            <div><dt>Direction</dt><dd>{config.trade_mode}</dd></div>
            <div><dt>Balance</dt><dd>{settings.capital.toLocaleString()} USDT</dd></div>
            <div><dt>Leverage</dt><dd>{settings.max_leverage}×</dd></div>
            <div><dt>Per trade</dt><dd>{config.amount_unit === "percent" ? `${config.amount_per_trade}% of balance` : `${config.amount_per_trade} USDT`}</dd></div>
            <div><dt>Filters</dt><dd>{activeFilters} of 4 on</dd></div>
          </dl>
          <button type='submit' className='setup-run' disabled={busy || days <= 0 || (config.forecast_filter && (!config.forecast_model_id || !!lookAhead))}>
            {busy ? "Running backtest…" : "Run backtest"}
          </button>
          <small className='setup-note'>Backtests and paper trading only. Live trading stays off until the strategy is validated.</small>
        </section>
      </aside>
    </form>
  );
}

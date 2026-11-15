import { useEffect, useState, type FormEvent } from "react";
import { api } from "../../shared/api/api";
import type { BacktestSettings } from "../../shared/types/types";
import { Field, SettingsCard, TIMEFRAME_CHOICES, Toggle } from "./BBReversalSettings";
import TradingCostsCard from "./TradingCostsCard";

type Config = BacktestSettings["adx_supertrend"];
type ForecastModel = { id: string; name: string; trainedThrough: string; config: { model: string; timeframe: string; horizon: number } };

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
  function submit(event: FormEvent) {
    event.preventDefault();
    onRun();
  }
  return (
    <form className='setup-form adx-st-settings' onSubmit={submit}>
      <SettingsCard
        step={1}
        title='ADX + Supertrend'
        description='Enters in the Supertrend direction when ADX is at or above the threshold and rising, on an ADX cross or a Supertrend flip. The stop follows the Supertrend line and an opposite flip closes the trade. Filters below are minor checks that can only skip trades.'
      >
        <div className='setup-grid'>
          <Field label='Timeframe'>
            <select
              value={settings.entry_timeframe}
              onChange={(e) => onChange({ ...settings, entry_timeframe: e.target.value as BacktestSettings["entry_timeframe"] })}
            >
              {TIMEFRAME_CHOICES.map((tf) => (
                <option key={tf}>{tf}</option>
              ))}
            </select>
          </Field>
          <Field label='Backtest start (UTC)'>
            <input
              type='date'
              required
              min={range.startDate}
              max={settings.end_date}
              value={settings.start_date}
              onChange={(e) => onChange({ ...settings, start_date: e.target.value })}
            />
          </Field>
          <Field label='Backtest end (UTC)'>
            <input
              type='date'
              required
              min={settings.start_date}
              max={range.endDate}
              value={settings.end_date}
              onChange={(e) => onChange({ ...settings, end_date: e.target.value })}
            />
          </Field>
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

      <SettingsCard step={4} title='Minor filters' description='Each filter can only block an entry. Turn any of them off to compare.'>
        <div className='adx-st-filters'>
          <div className='adx-st-filter'>
            <header>
              <strong>Higher-timeframe trend</strong>
              <Toggle label='Higher-timeframe filter' checked={config.htf_filter} onChange={(value) => set({ htf_filter: value })} />
            </header>
            <p>Trade only with the higher-timeframe Supertrend (closed candles only).</p>
            {config.htf_filter && (
              <div className='setup-grid'>
                <Field label='Higher timeframe'>
                  <select value={config.htf_timeframe} onChange={(e) => set({ htf_timeframe: e.target.value as Config["htf_timeframe"] })}>
                    {["15m", "30m", "1h", "4h", "1d"].map((tf) => (
                      <option key={tf}>{tf}</option>
                    ))}
                  </select>
                </Field>
              </div>
            )}
          </div>
          <div className='adx-st-filter'>
            <header>
              <strong>Volatility (ATR)</strong>
              <Toggle label='ATR filter' checked={config.atr_filter} onChange={(value) => set({ atr_filter: value })} />
            </header>
            <p>Skip trades when ATR/price is unusually low (choppy) or extreme, by percentile over a rolling window.</p>
            {config.atr_filter && (
              <div className='setup-grid'>
                {num("atr_length", "ATR length", 1, 500)}
                {num("atr_window", "Percentile window", 20, 5000)}
                {num("atr_min_pct", "Min percentile", 0, 100, 1, undefined, "%")}
                {num("atr_max_pct", "Max percentile", 0, 100, 1, undefined, "%")}
              </div>
            )}
          </div>
          <div className='adx-st-filter'>
            <header>
              <strong>RSI extremes</strong>
              <Toggle label='RSI filter' checked={config.rsi_filter} onChange={(value) => set({ rsi_filter: value })} />
            </header>
            <p>Skip longs when RSI is overbought and shorts when oversold.</p>
            {config.rsi_filter && (
              <div className='setup-grid'>
                {num("rsi_length", "RSI length", 1, 500)}
                {num("rsi_overbought", "Overbought", 0, 100, 0.5)}
                {num("rsi_oversold", "Oversold", 0, 100, 0.5)}
              </div>
            )}
          </div>
          <div className='adx-st-filter'>
            <header>
              <strong>Forecast probability</strong>
              <Toggle
                label='Forecast filter'
                checked={config.forecast_filter}
                onChange={(value) => set({ forecast_filter: value, forecast_model_id: value ? config.forecast_model_id || usable[0]?.id || "" : config.forecast_model_id })}
              />
            </header>
            <p>Require a saved Quantile Boost model's calibrated direction probability to agree. The model must use the same timeframe and be trained before the backtest start.</p>
            {config.forecast_filter && (
              <div className='setup-grid'>
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
              </div>
            )}
            {config.forecast_filter && lookAhead && (
              <p className='error' role='alert'>
                This model was trained through {chosen!.trainedThrough.slice(0, 10)}, after the backtest start. Move the start date later or train an earlier model.
              </p>
            )}
          </div>
        </div>
      </SettingsCard>

      <TradingCostsCard settings={settings} onChange={onChange} step={5} />

      <div className='setup-run'>
        <button type='submit' disabled={busy || (config.forecast_filter && (!config.forecast_model_id || !!lookAhead))}>
          {busy ? "Running backtest…" : "Run backtest"}
        </button>
        <small>Backtests and paper trading only. Live trading stays off until the strategy is validated.</small>
      </div>
    </form>
  );
}

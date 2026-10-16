import type {ReactNode} from 'react';
import type {BacktestSettings} from '../../shared/types/types';
import {bbDefaults} from './strategyDefaults';

type BbKey=Exclude<keyof typeof bbDefaults,'trade_mode'|'rsi_exit_enabled'|'use_sma_trend_adjustment'|'amount_unit'|'amount_per_trade'|'quantity'>;
const limits:Record<BbKey,[number,number,number]>={
  bb_length:[1,1000,1],bb_mult:[.1,100,.1],min_bb_width_pct:[0,100,.1],atr_length:[1,500,1],min_atr:[0,100,.01],
  adx_length:[1,500,1],adx_threshold:[0,100,.5],pullback_bars:[1,100,1],rsi_exit_length:[1,500,1],rsi_exit_move:[0,100,.01],
  rsi_exit_short:[0,100,.5],rsi_exit_long:[0,100,.5],initial_sl:[.01,100,.01],trail_trigger:[.01,100,.01],
  trail_distance:[.01,100,.01],trail_multiplier:[1,100,.1],sma_length:[1,1000,1],sma_slope_bars:[1,500,1],
  counter_profit_pct:[1,100,1],counter_sl_pct:[1,100,1],
};
export const TIMEFRAME_CHOICES=['1m','3m','5m','10m','15m','30m','1h','4h','1d'] as const;

export function SettingsCard({step,title,description,actions,children,id}:{step?:number;title:string;description?:string;actions?:ReactNode;children:ReactNode;id?:string}){
  return <section className="setup-card" id={id}><header>{step!=null&&<span className="setup-step">{step}</span>}<div><h2>{title}</h2>{description&&<p>{description}</p>}</div>{actions&&<div className="setup-card-actions">{actions}</div>}</header>{children}</section>;
}

export function Field({label,hint,unit,children}:{label:string;hint?:string;unit?:string;children:ReactNode}){
  return <label className="setup-field"><span className="setup-label">{label}</span><span className={unit?'setup-input has-unit':'setup-input'}>{children}{unit&&<em>{unit}</em>}</span>{hint&&<small>{hint}</small>}</label>;
}

function Toggle({checked,onChange,label}:{checked:boolean;onChange:(value:boolean)=>void;label:string}){
  return <label className="setup-toggle"><input type="checkbox" role="switch" aria-label={label} checked={checked} onChange={event=>onChange(event.target.checked)}/><i aria-hidden="true"/><span>{checked?'On':'Off'}</span></label>;
}

export default function BBReversalSettings({settings,onChange}:{settings:BacktestSettings;onChange:(s:BacktestSettings)=>void}) {
  const config=settings.bb_reversal;
  const setBb=(patch:Partial<typeof config>)=>onChange({...settings,bb_reversal:{...config,...patch}});
  const num=(key:BbKey,label:string,hint?:string,unit?:string)=>{
    const [min,max,step]=limits[key];
    return <Field key={key} label={label} hint={hint} unit={unit}><input type="number" required min={min} max={max} step={step>=1?1:"any"} value={config[key]} onChange={event=>setBb({[key]:Number(event.target.value)})}/></Field>;
  };


  return <>
    <SettingsCard step={1} id="settings-execution" title="Position size" description="How much the bot puts into each trade and which candles it trades on.">
      <div className="setup-field setup-field--wide"><span className="setup-label">Timeframe</span><div className="chip-group" role="radiogroup" aria-label="Execution timeframe">{TIMEFRAME_CHOICES.map(tf=><button key={tf} type="button" role="radio" aria-checked={settings.entry_timeframe===tf} onClick={()=>onChange({...settings,entry_timeframe:tf})}>{tf}</button>)}</div><small>The bot checks for signals each time one of these candles closes.</small></div>
      <div className="setup-grid">
        <Field label="Amount per trade" hint={config.amount_unit==='percent'?'Share of your current balance, before leverage.':'Fixed dollars, capped at your available balance.'}>
          <input aria-label="Amount per trade" type="number" required min={.01} max={config.amount_unit==='percent'?100:settings.capital} step="any" value={config.amount_per_trade} onChange={event=>setBb({amount_per_trade:Number(event.target.value)})}/>
          <span className="unit-switch" role="group" aria-label="Amount unit">{(['percent','price'] as const).map(unit=><button key={unit} type="button" aria-pressed={config.amount_unit===unit} onClick={()=>setBb({amount_unit:unit})}>{unit==='percent'?'%':'$'}</button>)}</span>
        </Field>
        <Field label="Leverage" unit="×" hint={`Position size = amount × ${settings.max_leverage}.`}><input aria-label="Leverage" type="number" required min={1} max={100} step={.5} value={settings.max_leverage} onChange={event=>onChange({...settings,max_leverage:Number(event.target.value)})}/></Field>
      </div>
    </SettingsCard>

    <SettingsCard step={2} id="settings-filters" title="When to enter" description="A candle touching the outer Bollinger band arms a rebound. The bot enters on the first candle that closes back inside.">
      <div className="setup-grid">
        {num('bb_length','Band length','Candles used for the bands.')}
        {num('bb_mult','Band width','Standard deviations from the middle.','σ')}
        {num('pullback_bars','Rebound window','Candles allowed for the rebound.','bars')}
        {num('min_bb_width_pct','Minimum band width','Skip very quiet markets.','%')}
      </div>
      <details className="setup-more"><summary>Volatility & trend-strength filters</summary><div className="setup-grid">
        {num('atr_length','ATR length')}{num('min_atr','Minimum ATR','Trade only when moves are large enough.')}
        {num('adx_length','ADX length')}{num('adx_threshold','ADX above','Trend strength required.')}
      </div></details>
    </SettingsCard>

    <SettingsCard step={3} id="settings-stops" title="When to exit" description="Every trade starts with a stop. Once in profit, a trailing stop follows the price and never loosens.">
      <div className="setup-grid">
        {num('initial_sl','Stop loss','Distance from entry in price.','USDT')}
        {num('trail_trigger','Start trailing after','Profit needed to activate.','USDT')}
        {num('trail_distance','Trailing distance','Gap kept behind the price.','USDT')}
        {num('trail_multiplier','Trailing multiplier','Scales activation and distance.','×')}
      </div>
      <div className="setup-option" id="settings-trend"><div><strong>Tighter exits against the trend</strong><p>Uses a moving average to spot countertrend trades and shrinks their stop and trailing distances.</p></div><Toggle label="Use SMA Trend Adjustment" checked={config.use_sma_trend_adjustment} onChange={value=>setBb({use_sma_trend_adjustment:value})}/></div>
      {config.use_sma_trend_adjustment&&<div className="setup-grid setup-grid--nested">
        {num('sma_length','Trend SMA length',undefined,'bars')}{num('sma_slope_bars','Slope lookback',undefined,'bars')}
        {num('counter_profit_pct','Countertrend trailing','Share of normal distances.','%')}{num('counter_sl_pct','Countertrend stop','Share of normal stop.','%')}
      </div>}
      <div className="setup-option" id="settings-rsi-exit"><div><strong>RSI take-profit exit</strong><p>Closes at candle close when price moved more than the set amount and RSI is extreme. Stops still apply.</p></div><Toggle label="Enable RSI and price exit" checked={config.rsi_exit_enabled??false} onChange={value=>setBb({rsi_exit_enabled:value})}/></div>
      {config.rsi_exit_enabled&&<><div className="setup-grid setup-grid--nested">
        {num('rsi_exit_length','RSI length',undefined,'bars')}{num('rsi_exit_move','Price move above',undefined,'USDT')}
        {num('rsi_exit_long','Long: RSI above')}{num('rsi_exit_short','Short: RSI below')}
      </div><p className="setup-note">Both sides require close − entry &gt; {config.rsi_exit_move}; for shorts this upward move is against the position.</p></>}
    </SettingsCard>

  </>;
}

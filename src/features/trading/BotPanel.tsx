import type {ReactNode} from 'react';
import {fmt,type BacktestSettings} from '../../shared/types/types';
import {adxSupertrendDefaults,stScalperDefaults} from '../strategy/strategyDefaults';
import BotSelector from '../strategy/BotSelector';
import type {SavedSetup} from '../strategy/SetupPicker';
import StrategySummary from './StrategySummary';

const BOT_TIMEFRAMES:readonly BacktestSettings['entry_timeframe'][]=['1m','3m','5m','10m','15m','30m','1h','4h','1d'];

type AmountUnit='price'|'percent';
type Sizing={amount_per_trade:number;amount_unit:AmountUnit};

/** Fixed-amount sizing of the selected strategy (ADX + Supertrend keeps its own; others use BB's). */
export function tradeSizing(settings:BacktestSettings):Sizing{
  return settings.strategy==='adx_supertrend'?{...adxSupertrendDefaults,...settings.adx_supertrend}:settings.bb_reversal;
}
function withSizing(settings:BacktestSettings,patch:Partial<Sizing>):BacktestSettings{
  return settings.strategy==='adx_supertrend'
    ?{...settings,adx_supertrend:{...adxSupertrendDefaults,...settings.adx_supertrend,...patch}}
    :{...settings,bb_reversal:{...settings.bb_reversal,...patch}};
}

function UnitInput({unit,children}:{unit:ReactNode;children:ReactNode}){
  return <div className="input-with-unit">{children}<span>{unit}</span></div>;
}

export type AllocationOptions={
  /** Label of the fixed-amount input, e.g. "Amount per trade" (paper) or "Margin per trade" (live). */
  amountLabel:string;
  /** Upper limit for a $ amount; percent is always capped at 100. */
  amountCap?:number;
  /** Text under a fixed-amount input. */
  amountHint:ReactNode;
};

/** Risk-based strategies size by % risked; the others by a fixed amount or % of funds. */
function AllocationControl({settings,onChange,amountLabel,amountCap,amountHint}:AllocationOptions&{settings:BacktestSettings;onChange:(settings:BacktestSettings)=>void}){
  if(settings.strategy==='st_scalper'){
    const scalper={...stScalperDefaults,...settings.st_scalper};
    return <div className="allocation-control">
      <label>Risk per trade<UnitInput unit="%"><input type="number" required min={.01} max={10} step="any" value={scalper.risk_pct} onChange={event=>onChange({...settings,st_scalper:{...scalper,risk_pct:Number(event.target.value)}})}/></UnitInput></label>
      <small>Equity lost if the initial ATR stop is hit. Position size is capped by leverage.</small>
    </div>;
  }
  if(settings.strategy==='ml_directional'){
    const ml=settings.ml_directional;
    return <div className="allocation-control">
      <label>Risk per trade<UnitInput unit="%"><input type="number" required min={.01} max={10} step="any" value={ml.risk_per_trade_pct} onChange={event=>onChange({...settings,ml_directional:{...ml,risk_per_trade_pct:Number(event.target.value)}})}/></UnitInput></label>
      <small>Balance lost if the stop is hit. Position size is capped by leverage.</small>
    </div>;
  }
  const sizing=tradeSizing(settings);
  return <div className="allocation-control">
    <label>{amountLabel}<div className="input-with-unit">
      <input type="number" required min={.01} step="any" max={sizing.amount_unit==='percent'?100:amountCap} value={sizing.amount_per_trade} onChange={event=>onChange(withSizing(settings,{amount_per_trade:Number(event.target.value)}))}/>
      <select aria-label={`${amountLabel} unit`} value={sizing.amount_unit} onChange={event=>onChange(withSizing(settings,{amount_unit:event.target.value as AmountUnit}))}><option value="percent">%</option><option value="price">$</option></select>
    </div></label>
    <small>{amountHint}</small>
  </div>;
}

export type BotPanelProps={
  /** Optional heading with a status pill (paper shows "Paper bot · Running"). */
  heading?:{title:string;status:string};
  /** Settings shown in the form (a running session's settings while it runs). */
  settings:BacktestSettings;
  onSettingsChange?:(settings:BacktestSettings)=>void;
  profiles?:SavedSetup[];
  onApplySetup?:(setup:SavedSetup)=>void;
  onConfigure?:()=>void;
  running:boolean;
  busy:boolean;
  /** Form inputs are read-only (bot running, request pending, no editor). */
  locked:boolean;
  /** Balance used by the bot: editable starting balance (paper) or the exchange's free margin (live). */
  funds:{label:string;value:number|null;unit:string;onChange?:(value:number)=>void};
  leverage:{value:string;min:number;max:number;step:number;disabled?:boolean;onChange:(value:string)=>void};
  allocation:AllocationOptions;
  /** Checkbox that must be ticked before starting (live real-money authorization). */
  confirmation?:{label:string;checked:boolean;disabled:boolean;onChange:(checked:boolean)=>void};
  canStart:boolean;
  startLabel:string;
  stopLabel:string;
  canStop?:boolean;
  onStart:()=>void;
  onStop:()=>void;
  /** Extra buttons next to Start, e.g. paper's "Resume saved session". */
  secondaryActions?:ReactNode;
  /** Shown instead of the form when no strategy is configured. */
  emptyText:string;
  emptyStopLabel:string;
  /** Extra line in the strategy card, e.g. where the strategy can run. */
  strategyNote?:string;
  /** Hints, status lines and errors under the form. */
  children?:ReactNode;
};

/** Bot controls shared by paper and live trading: strategy, timeframe, funds, leverage, sizing and start/stop. */
export default function BotPanel(props:BotPanelProps){
  const {heading,settings,onSettingsChange,profiles=[],onApplySetup,onConfigure,running,busy,locked,funds,leverage,allocation,confirmation,canStart,startLabel,stopLabel,canStop=true,onStart,onStop,secondaryActions,emptyText,emptyStopLabel,strategyNote,children}=props;
  const change=(next:BacktestSettings)=>onSettingsChange?.(next);
  return <div className="bot-control live-bot-panel">
    {heading&&<div className="panel-heading"><h2>{heading.title}</h2><span className={`bot-state ${running?'is-running':''}`}><i className="status-dot"/>{heading.status}</span></div>}
    {settings.strategy==='none'?<div className="bot-form">
      <h3>No strategy configured</h3><p>{emptyText}</p>
      {running&&<button type="button" disabled={busy||!canStop} onClick={onStop}>{emptyStopLabel}</button>}
    </div>:<form className="bot-form" onSubmit={event=>{event.preventDefault();if(canStart)onStart();}}>
      <fieldset disabled={locked}>
        {onApplySetup&&<BotSelector strategy={settings.strategy} onStrategyChange={strategy=>change({...settings,strategy})} profiles={profiles} onApplySetup={onApplySetup} setupLabel="Saved parameters"/>}
        <label>Timeframe<select value={settings.entry_timeframe} onChange={event=>change({...settings,entry_timeframe:event.target.value as BacktestSettings['entry_timeframe']})}>{BOT_TIMEFRAMES.map(timeframe=><option key={timeframe} value={timeframe}>{timeframe}</option>)}</select></label>
        <div className="control-row">
          <label>{funds.label}<UnitInput unit={funds.unit}>{funds.onChange
            ?<input type="number" required min={1} max={1e9} step="any" value={funds.value??''} onChange={event=>funds.onChange?.(Number(event.target.value))}/>
            :<input readOnly tabIndex={-1} value={funds.value==null?'—':fmt(funds.value,2)}/>}</UnitInput></label>
          <label>Leverage<UnitInput unit="×"><input type="number" required min={leverage.min} max={leverage.max} step={leverage.step} value={leverage.value} disabled={leverage.disabled} onChange={event=>leverage.onChange(event.target.value)}/></UnitInput></label>
        </div>
        <AllocationControl settings={settings} onChange={change} {...allocation}/>
      </fieldset>
      {running?<button className="bot-pause" type="button" disabled={busy||!canStop} onClick={onStop}>{stopLabel}</button>:<>
        {confirmation&&<label className="ticket-confirm"><input type="checkbox" checked={confirmation.checked} disabled={confirmation.disabled} onChange={event=>confirmation.onChange(event.target.checked)}/><span>{confirmation.label}</span></label>}
        <button className="bot-start" type="submit" disabled={!canStart}>{busy?'Starting…':startLabel}</button>
        {secondaryActions}
      </>}
    </form>}
    {children}
    <StrategySummary settings={settings} note={strategyNote} onConfigure={onConfigure}/>
  </div>;
}

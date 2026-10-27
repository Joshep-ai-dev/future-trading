import {useState} from 'react';
import type {BacktestSettings} from '../../shared/types/types';
import type {BotStatus,ExchangeAction} from '../../shared/api/exchangeTypes';
import type {ExchangeVenue} from '../../shared/api/exchangeVenue';
import {liveNumber as number,useExchangeStream} from '../../shared/api/useExchangeStream';
import BotSelector from '../strategy/BotSelector';
import type {SavedSetup} from '../strategy/SetupPicker';
import {instrumentDetails,useExchangeInstrument} from '../../shared/api/exchangeInstrument';

type Props={venue:ExchangeVenue;settings:BacktestSettings;onSettingsChange?:(settings:BacktestSettings)=>void;onConfigure?:()=>void;
  profiles?:SavedSetup[];onApplySetup?:(setup:SavedSetup)=>void;bot:BotStatus;connected:boolean;busy:boolean;blocked:boolean;
  positionOpen:boolean;leverage:string;onLeverageChange:(value:string)=>void;onRun:ExchangeAction};

/** Live bot controls, laid out like the paper bot: model and saved parameters, timeframe, sizing, start/stop. */
export default function LiveBotPanel({venue,settings,onSettingsChange,onConfigure,profiles=[],onApplySetup,bot,connected,busy,blocked,positionOpen,leverage,onLeverageChange,onRun}:Props){
  const asset=instrumentDetails(useExchangeInstrument()).base;
  const {data,connected:streamConnected}=useExchangeStream(venue);
  const [confirmed,setConfirmed]=useState(false);
  const available=data?.balance?.free;
  const validMargin=available!=null&&Number.isFinite(available)&&available>0&&!data?.errors.balance&&streamConnected;
  const config=settings.bb_reversal;
  const amount=validMargin?(config.amount_unit==='percent'?available*config.amount_per_trade/100:Math.min(config.amount_per_trade,available)):null;
  const active=bot.running&&bot.venue===venue;
  const locked=bot.running||busy||!onSettingsChange;
  const validAllocation=Number.isFinite(config.amount_per_trade)&&config.amount_per_trade>0&&(config.amount_unit==='percent'?config.amount_per_trade<=100:!validMargin||config.amount_per_trade<=available);
  const validLeverage=Number.isInteger(Number(leverage))&&Number(leverage)>=1&&Number(leverage)<=100;
  const mlSelected=settings.strategy==='ml_ensemble';
  const canStart=!mlSelected&&connected&&validMargin&&validAllocation&&!blocked&&!positionOpen&&!bot.running&&confirmed&&!busy&&validLeverage;
  // First reason the bot cannot start, shown under the button.
  const hint=bot.running?null:!connected?'Connect an exchange account first.':mlSelected?'ML Ensemble runs in backtests and paper trading only; choose BB Reversal to trade live.'
    :blocked?'Live trading is blocked until the position check succeeds.':positionOpen?'Close the open position to start.'
    :!validMargin?'Waiting for available margin.':!validAllocation?'Margin per trade exceeds the available margin.':!validLeverage?'Leverage must be a whole number from 1 to 100.'
    :!confirmed?'Tick the authorization box to enable the start button.':null;

  async function start(){
    if(!canStart)return;
    if(await onRun('/api/exchange/auto/start',{...settings,capital:available,strategy:'bb_outer_reversal',max_leverage:Number(leverage),venue,confirmation:'START LIVE STRATEGY'}))setConfirmed(false);
  }

  return <div id="bot-ticket-panel" role="tabpanel" aria-labelledby="execution-tab-bot" className="live-bot-panel bot-control">
    <form className="bot-form" onSubmit={event=>{event.preventDefault();void start();}}>
      <fieldset disabled={locked}>
        {onApplySetup&&<BotSelector strategy={settings.strategy} onStrategyChange={key=>onSettingsChange?.({...settings,strategy:key})} profiles={profiles} onApplySetup={onApplySetup} setupLabel="Saved parameters"/>}
        <label>Timeframe<select value={settings.entry_timeframe} onChange={event=>onSettingsChange?.({...settings,entry_timeframe:event.target.value as BacktestSettings['entry_timeframe']})}>{['1m','3m','5m','10m','15m','30m','1h','4h','1d'].map(timeframe=><option key={timeframe} value={timeframe}>{timeframe}</option>)}</select></label>
        <div className="control-row">
          <label>Available margin (USDT)<input readOnly tabIndex={-1} value={validMargin?number(available,2):'—'}/></label>
          <label>Leverage<input type="number" required min={1} max={100} step={1} value={leverage} disabled={!connected} onChange={event=>onLeverageChange(event.target.value)}/></label>
        </div>
        <div className="allocation-control"><label>Margin per trade<div className="input-with-unit"><input type="number" required min={.01} step="any" max={config.amount_unit==='percent'?100:undefined} value={config.amount_per_trade} onChange={event=>onSettingsChange?.({...settings,bb_reversal:{...config,amount_per_trade:Number(event.target.value)}})}/><select aria-label="Margin unit" value={config.amount_unit} onChange={event=>onSettingsChange?.({...settings,bb_reversal:{...config,amount_unit:event.target.value as 'price'|'percent'}})}><option value="percent">%</option><option value="price">$</option></select></div></label><small>≈ {number(amount,2)} USDT margin · {number(amount==null?null:amount*Number(leverage),2)} USDT position value.</small></div>
      </fieldset>
      {bot.running?<button className="bot-pause" type="button" disabled={busy||!active} onClick={()=>{if(window.confirm('Stop the live strategy? Open exchange positions and their stop stay active.'))void onRun('/api/exchange/auto/stop');}}>■ Stop live bot</button>:<>
        <label className="ticket-confirm"><input type="checkbox" checked={confirmed} disabled={!connected||busy||blocked||positionOpen||!validMargin||mlSelected} onChange={event=>setConfirmed(event.target.checked)}/><span>I authorize this bot to place real orders.</span></label>
        <button className="bot-start" type="submit" disabled={!canStart}>{busy?'Starting…':'▶ Start live bot'}</button>
      </>}
    </form>
    {hint&&<p className="ticket-help">{hint}</p>}
    {active&&<p className="ticket-help">{bot.position?`${bot.position.direction.toUpperCase()} · ${number(bot.position.quantity)} ${asset} · stop ${number(bot.position.stop,3)}`:'Waiting for a signal. Readiness is shown below and on the chart.'}</p>}
    {bot.error&&<p className="error" role="alert">{bot.error}</p>}
    <div className="strategy-card"><div><span className="strategy-icon">⌁</span><div><strong>{mlSelected?'ML Ensemble':'BB Outer Band Reversal'}</strong><small>{mlSelected?'Backtest and paper only':'Trailing SL · Both directions · Live'}</small></div></div><button type="button" className="text-button" onClick={onConfigure}>Strategy settings ↗</button></div>
  </div>;
}

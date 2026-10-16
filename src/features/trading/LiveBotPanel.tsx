import {useState} from 'react';
import type {BacktestSettings} from '../../shared/types/types';
import type {BotStatus,ExchangeAction} from '../../shared/api/exchangeTypes';
import type {ExchangeVenue} from '../../shared/api/exchangeVenue';
import {liveNumber as number,useExchangeStream} from '../../shared/api/useExchangeStream';
import {Button,StatusBadge} from '../../shared/ui/ui';

type Props={venue:ExchangeVenue;settings:BacktestSettings;onSettingsChange?:(settings:BacktestSettings)=>void;onConfigure?:()=>void;bot:BotStatus;connected:boolean;busy:boolean;blocked:boolean;positionOpen:boolean;leverage:string;onLeverageChange:(value:string)=>void;onRun:ExchangeAction};
export default function LiveBotPanel({venue,settings,onSettingsChange,onConfigure,bot,connected,busy,blocked,positionOpen,leverage,onLeverageChange,onRun}:Props){
  const {data,connected:streamConnected}=useExchangeStream(venue);
  const [confirmed,setConfirmed]=useState(false);
  const available=data?.balance?.free;
  const validMargin=available!=null&&Number.isFinite(available)&&available>0&&!data?.errors.balance&&streamConnected;
  const config=settings.bb_reversal;
  const amount=validMargin?(config.amount_unit==='percent'?available*config.amount_per_trade/100:Math.min(config.amount_per_trade,available)):null;
  const active=bot.running&&bot.venue===venue;
  const locked=bot.running||busy||!onSettingsChange;
  const validAllocation=Number.isFinite(config.amount_per_trade)&&config.amount_per_trade>0&&(config.amount_unit==='percent'?config.amount_per_trade<=100:!validMargin||config.amount_per_trade<=available);
  const mlSelected=settings.strategy==='ml_ensemble';
  const canStart=!mlSelected&&connected&&validMargin&&validAllocation&&!blocked&&!positionOpen&&!bot.running&&confirmed&&!busy&&Number.isInteger(Number(leverage))&&Number(leverage)>=1&&Number(leverage)<=100;
  async function start(){
    if(!canStart)return;
    if(await onRun('/api/exchange/auto/start',{...settings,capital:available,strategy:'bb_outer_reversal',max_leverage:Number(leverage),venue,confirmation:'START LIVE STRATEGY'}))setConfirmed(false);
  }
  return <div id="bot-ticket-panel" role="tabpanel" aria-labelledby="execution-tab-bot" className="live-bot-panel">
    {mlSelected&&<p className="exchange-inline-error">ML Ensemble runs in backtests and paper trading only. Validate it there first; switch to BB Outer Band Reversal in Bot settings to trade live.</p>}
    <div className="bot-strategy-heading"><span className="strategy-icon">BB</span><div><strong>Outer Band Reversal</strong><small>Bollinger bands · Trailing stop</small></div><StatusBadge tone={active?'positive':'neutral'}>{active?'Running':'Ready'}</StatusBadge></div>
    <div className="bot-live-balance"><span>Available margin <small>Live · USDT</small></span><strong>{number(available,4)}</strong></div>
    <div className="bot-ticket-fields"><label className="ui-field"><span>Timeframe</span><select value={settings.entry_timeframe} disabled={locked} onChange={event=>onSettingsChange?.({...settings,entry_timeframe:event.target.value as BacktestSettings['entry_timeframe']})}>{['1m','3m','5m','10m','15m','30m','1h','4h','1d'].map(timeframe=><option key={timeframe}>{timeframe}</option>)}</select></label><label className="ui-field"><span>Leverage</span><input type="number" min="1" max="100" step="1" value={leverage} disabled={locked||!connected} onChange={event=>onLeverageChange(event.target.value)}/></label></div>
    <label className="ui-field bot-allocation"><span>Margin per trade</span><div className="ticket-size"><div><input aria-label="Bot margin per trade" type="number" min="0.01" step="any" max={config.amount_unit==='percent'?100:undefined} value={config.amount_per_trade} disabled={locked} onChange={event=>onSettingsChange?.({...settings,bb_reversal:{...config,amount_per_trade:Number(event.target.value)}})}/><select aria-label="Bot allocation unit" value={config.amount_unit} disabled={locked} onChange={event=>onSettingsChange?.({...settings,bb_reversal:{...config,amount_unit:event.target.value as 'price'|'percent'}})}><option value="percent">%</option><option value="price">USDT</option></select></div></div></label>
    <div className="ticket-estimates"><div><span>Estimated allocation</span><b>{number(amount,4)} USDT</b></div><div><span>Position value</span><b>{number(amount==null?null:amount*Number(leverage),4)} USDT</b></div></div>
    {active&&<p className="ticket-help">Live readiness is shown in Bot status below and on the chart.</p>}
    {bot.running?<div className="bot-active-summary"><StatusBadge dot tone="positive">{active?'Strategy running':`Running on ${bot.venue?.toUpperCase()}`}</StatusBadge><p>{active?(bot.position?`${bot.position.direction.toUpperCase()} · ${number(bot.position.quantity)} XAG`:'Waiting for a signal'): 'Stop the active bot before starting another.'}</p><Button variant="secondary" disabled={busy} onClick={()=>void onRun('/api/exchange/auto/stop')}>Stop strategy</Button></div>:<><label className="ticket-confirm"><input type="checkbox" checked={confirmed} disabled={!connected||busy||blocked||positionOpen||!validMargin} onChange={event=>setConfirmed(event.target.checked)}/><span>I authorize this bot to place real orders.</span></label><Button className="bot-start-action" disabled={!canStart} onClick={()=>void start()}>{busy?'Starting...':'Start live strategy'}</Button></>}
    {!validMargin&&<p className="ticket-help">Waiting for available margin.</p>}
    {validMargin&&config.amount_unit==='price'&&config.amount_per_trade>available&&<p className="ticket-help">Amount exceeds available margin.</p>}
    {positionOpen&&!active&&<p className="ticket-help">Close the open position to start.</p>}
    {bot.error&&<p className="exchange-inline-error">{bot.error}</p>}
    <div className="bot-settings-link"><Button variant="ghost" onClick={onConfigure}>Configure strategy <span aria-hidden="true">↗</span></Button></div>
  </div>;
}

import {useState} from 'react';
import type {BacktestSettings} from '../../shared/types/types';
import type {BotStatus,ExchangeAction} from '../../shared/api/exchangeTypes';
import type {ExchangeVenue} from '../../shared/api/exchangeVenue';
import {liveNumber as number,useExchangeStream} from '../../shared/api/useExchangeStream';
import type {SavedSetup} from '../strategy/SetupPicker';
import {instrumentDetails,useExchangeInstrument} from '../../shared/api/exchangeInstrument';
import BotPanel from './BotPanel';

type Props={venue:ExchangeVenue;settings:BacktestSettings;onSettingsChange?:(settings:BacktestSettings)=>void;onConfigure?:()=>void;
  profiles?:SavedSetup[];onApplySetup?:(setup:SavedSetup)=>void;bot:BotStatus;connected:boolean;busy:boolean;blocked:boolean;
  positionOpen:boolean;leverage:string;minimumLeverage:number;maximumLeverage:number;leverageLoading:boolean;onLeverageChange:(value:string)=>void;onRun:ExchangeAction};

/** Live bot: the shared bot controls fed with exchange margin, exchange leverage and a real-money authorization. */
export default function LiveBotPanel({venue,settings,onSettingsChange,onConfigure,profiles,onApplySetup,bot,connected,busy,blocked,positionOpen,leverage,minimumLeverage,maximumLeverage,leverageLoading,onLeverageChange,onRun}:Props){
  const asset=instrumentDetails(useExchangeInstrument()).base;
  const {data,connected:streamConnected}=useExchangeStream(venue);
  const [confirmed,setConfirmed]=useState(false);
  const available=data?.balance?.free;
  const validMargin=available!=null&&Number.isFinite(available)&&available>0&&!data?.errors.balance&&streamConnected;
  const sizing=settings.bb_reversal;
  const amount=validMargin?(sizing.amount_unit==='percent'?available*sizing.amount_per_trade/100:Math.min(sizing.amount_per_trade,available)):null;
  const active=bot.running&&bot.venue===venue;
  const validAllocation=Number.isFinite(sizing.amount_per_trade)&&sizing.amount_per_trade>0&&(sizing.amount_unit==='percent'?sizing.amount_per_trade<=100:!validMargin||sizing.amount_per_trade<=available);
  const validLeverage=Number.isInteger(Number(leverage))&&!leverageLoading&&Number(leverage)>=minimumLeverage&&Number(leverage)<=maximumLeverage;
  const simulationOnly=settings.strategy!=='bb_outer_reversal';
  const canStart=!simulationOnly&&connected&&validMargin&&validAllocation&&!blocked&&!positionOpen&&!bot.running&&confirmed&&!busy&&validLeverage;
  // First reason the bot cannot start, shown under the button.
  const hint=bot.running?null:!connected?'Connect an exchange account first.':simulationOnly?'This strategy runs in backtests and paper trading only; choose BB Reversal to trade live.'
    :blocked?'Live trading is blocked until the position check succeeds.':positionOpen?'Close the open position to start.'
    :!validMargin?'Waiting for available margin.':!validAllocation?'Margin per trade exceeds the available margin.':!validLeverage?`Leverage must be a whole number from ${minimumLeverage} to ${maximumLeverage}.`
    :!confirmed?'Tick the authorization box to enable the start button.':null;

  async function start(){
    if(await onRun('/api/exchange/auto/start',{...settings,capital:available,strategy:'bb_outer_reversal',max_leverage:Number(leverage),venue,confirmation:'START LIVE STRATEGY'}))setConfirmed(false);
  }
  function stop(){
    if(settings.strategy!=='none'&&!window.confirm('Stop the live strategy? Open exchange positions and their stop stay active.'))return;
    void onRun('/api/exchange/auto/stop');
  }

  return <BotPanel settings={settings} onSettingsChange={onSettingsChange} profiles={profiles} onApplySetup={onApplySetup} onConfigure={onConfigure}
    running={bot.running} busy={busy} locked={bot.running||busy||!onSettingsChange}
    funds={{label:'Available margin',value:validMargin?available:null,unit:'USDT'}}
    leverage={{value:leverage,min:minimumLeverage,max:maximumLeverage,step:1,disabled:!connected||leverageLoading,onChange:onLeverageChange}}
    allocation={{amountLabel:'Margin per trade',amountHint:`≈ ${number(amount,2)} USDT margin · ${number(amount==null?null:amount*Number(leverage),2)} USDT position value.`}}
    confirmation={{label:'I authorize this bot to place real orders.',checked:confirmed,disabled:!connected||busy||blocked||positionOpen||!validMargin||simulationOnly,onChange:setConfirmed}}
    canStart={canStart} canStop={active} startLabel="▶ Start live bot" stopLabel="■ Stop live bot" onStart={()=>void start()} onStop={stop}
    emptyText="Automated trading is disabled. Use Manual for the order ticket." emptyStopLabel="Stop existing automation"
    strategyNote={simulationOnly?'Backtest and paper only':'Live trading supported'}>
    {hint&&<p className="ticket-help">{hint}</p>}
    {active&&<p className="ticket-help">{bot.position?`${bot.position.direction.toUpperCase()} · ${number(bot.position.quantity)} ${asset} · stop ${number(bot.position.stop,3)}`:'Waiting for a signal. Readiness is shown below and on the chart.'}</p>}
    {bot.error&&<p className="error" role="alert">{bot.error}</p>}
  </BotPanel>;
}

import {useEffect,useState} from 'react';
import {api} from './api';
import {disconnectExchangeStream,reconnectExchangeStream,syncExchangeConnection} from './useExchangeStream';
import ManualOrderTicket from './components/ManualOrderTicket';
import {Button,StatusBadge,TabBar} from './components/ui';
import {EXCHANGES,saveExchangeVenue,useExchangeVenue,type ExchangeVenue} from './exchangeVenue';
import type {BacktestSettings} from './types';
import type {VenueStatus,BotStatus} from './exchangeTypes';
import ExchangeConnections from './components/ExchangeConnections';
import LiveBotPanel from './components/LiveBotPanel';

type Venue=ExchangeVenue;
export default function LiveExecution({view,settings,onSettingsChange,onConfigure,onManageAccount,onOpenTerminal}:{view:'account'|'terminal';settings:BacktestSettings;onSettingsChange?:(settings:BacktestSettings)=>void;onConfigure?:()=>void;onManageAccount?:()=>void;onOpenTerminal?:()=>void}){
  const [statuses,setStatuses]=useState<VenueStatus[]>([]),[bot,setBot]=useState<BotStatus>({running:false,venue:null,timeframe:null,position:null,strategyState:null,error:null,lastProcessed:null});
  const venue=useExchangeVenue();
  const [savedVenues,setSavedVenues]=useState<Venue[]>([]);
  const [mode,setMode]=useState<'manual'|'bot'>('manual');
  const [liveLeverage,setLiveLeverage]=useState(String(Math.max(1,Math.floor(settings.max_leverage)))),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const selected=EXCHANGES.find(item=>item.id===venue)!;
  const account=statuses.find(item=>item.venue===venue);
  const connected=!!account?.connected;
  const positionOpen=!!account?.position?.side;
  const positionCheckFailed=!!account?.position?.error||!!account?.executionError;
  const botForVenue=bot.running&&bot.venue===venue;

  async function refresh(){
    try{
      const value=await api<{venues:VenueStatus[];bot:BotStatus;savedVenues:Venue[]}>('/api/exchange/status');
      EXCHANGES.forEach(exchange=>syncExchangeConnection(exchange.id,value.venues.some(account=>account.venue===exchange.id&&account.connected)));
      setStatuses(value.venues);setBot(value.bot);setSavedVenues(value.savedVenues??[]);
    }catch{/* Keep the last known account display while the backend restarts. */}
  }
  useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),3000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{if(bot.running&&bot.venue===venue)setMode('bot');},[bot.running,bot.venue,venue]);
  async function run(path:string,body?:unknown){
    setBusy(true);setMessage('');
    try{
      const result=await api<any>(path,{method:'POST',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
      setMessage(result.message??(result.order?result.takeProfitError??`Order accepted · ${result.order.side} · ${result.order.filled??result.order.amount} contracts${result.protectiveStop?' · stop loss accepted':''}${result.takeProfit?' · take profit accepted':''}`:'Request completed.'));
      if(path==='/api/exchange/disconnect')disconnectExchangeStream(venue);
      if(path==='/api/exchange/connect'||path==='/api/exchange/reconnect')reconnectExchangeStream(venue);
      if(path==='/api/exchange/auto/start'){setMode('bot');}
      await refresh();return true;
    }catch(error){setMessage(String(error));return false;}finally{setBusy(false);}
  }
  function changeVenue(value:Venue){saveExchangeVenue(value);}

  return <div className={`live-account-content live-${view}-view`}>
    {view==='account'&&<ExchangeConnections venue={venue} statuses={statuses} savedVenues={savedVenues} busy={busy} onVenueChange={changeVenue} onRun={run} onOpenTerminal={onOpenTerminal}/>}
    {view==='terminal'&&<div className="live-method-section">
      <TabBar items={[{value:'manual',label:'Manual',controls:'manual-ticket-panel'},{value:'bot',label:'Bots',controls:'bot-ticket-panel'}] as const} value={mode} onChange={setMode} label="Execution mode" idPrefix="execution-tab"/>
      <div className="ticket-connection"><StatusBadge tone={connected?'positive':'warning'} dot>{connected?selected.name+' connected':'No exchange connected'}</StatusBadge>{connected?<Button variant="ghost" disabled={busy} onClick={()=>{if(window.confirm('Disconnect this exchange? Local automation stops. Exchange positions and orders remain active.'))void run('/api/exchange/disconnect',{venue});}}>Disconnect</Button>:<Button variant="ghost" onClick={onManageAccount}>Connect API</Button>}</div>
      {account?.executionError&&<p className="exchange-inline-error">{account.executionError}</p>}
      {mode==='manual'?<ManualOrderTicket venue={venue} connected={connected} busy={busy} blocked={positionCheckFailed} botRunning={botForVenue} leverage={liveLeverage} onLeverageChange={setLiveLeverage} onRun={run}/>:<LiveBotPanel key={venue} venue={venue} settings={settings} onSettingsChange={onSettingsChange} onConfigure={onConfigure} bot={bot} connected={connected} busy={busy} blocked={positionCheckFailed} positionOpen={positionOpen} leverage={liveLeverage} onLeverageChange={setLiveLeverage} onRun={run}/>}

    </div>}
    {message&&<p className={message.startsWith('Error:')?'error':'live-result'} role="status">{message}</p>}
  </div>;
}

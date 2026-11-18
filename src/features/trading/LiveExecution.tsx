import {SidebarArrow} from './TradingWorkspaceTools';
import {ExecutionModeContext,LiveSidebarContext,type ExecutionMode} from './ExecutionModeContext';
import {useMarketLeverage} from '../../shared/api/useMarketLeverage';
import {useContext,useEffect,useRef,useState} from 'react';
import {api} from '../../shared/api/api';
import {disconnectExchangeStream,reconnectExchangeStream,syncExchangeConnection} from '../../shared/api/useExchangeStream';
import ManualOrderTicket from './ManualOrderTicket';
import {Button,StatusBadge,TabBar} from '../../shared/ui/ui';
import {EXCHANGES,saveExchangeVenue,useExchangeVenue,type ExchangeVenue} from '../../shared/api/exchangeVenue';
import type {BacktestSettings} from '../../shared/types/types';
import type {VenueStatus,BotStatus} from '../../shared/api/exchangeTypes';
import ExchangeConnections from '../account/ExchangeConnections';
import LiveBotPanel from './LiveBotPanel';
import type {SavedSetup} from '../strategy/SetupPicker';
import {defaultInstrumentForVenue,instrumentDetails,saveExchangeInstrument,useExchangeInstrument} from '../../shared/api/exchangeInstrument';

type Venue=ExchangeVenue;
export default function LiveExecution({view,settings,onSettingsChange,onConfigure,onManageAccount,onOpenTerminal,profiles,onApplySetup}:{view:'account'|'terminal';settings:BacktestSettings;profiles?:SavedSetup[];onApplySetup?:(setup:SavedSetup)=>void;onSettingsChange?:(settings:BacktestSettings)=>void;onConfigure?:()=>void;onManageAccount?:()=>void;onOpenTerminal?:()=>void}){
  const [statuses,setStatuses]=useState<VenueStatus[]>([]),[bot,setBot]=useState<BotStatus>({running:false,venue:null,timeframe:null,position:null,strategyState:null,error:null,lastProcessed:null});
  const venue=useExchangeVenue();
  const instrument=useExchangeInstrument(),instrumentInfo=instrumentDetails(instrument);
  const [savedVenues,setSavedVenues]=useState<Venue[]>([]);
  const sidebar=useContext(LiveSidebarContext);
  const localMode=useState<ExecutionMode>('manual');
  const [mode,setMode]=useContext(ExecutionModeContext)??localMode;
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const selected=EXCHANGES.find(item=>item.id===venue)!;
  const account=statuses.find(item=>item.venue===venue);
  const connected=!!account?.connected;
  const leverage=useMarketLeverage(venue,instrument,connected&&view==='terminal',account?.symbol);
  const liveLeverage=leverage.value,setLiveLeverage=leverage.setValue;
  const positionOpen=!!account?.position?.side;
  const positionCheckFailed=!!account?.position?.error||!!account?.executionError;
  const botForVenue=bot.running&&bot.venue===venue;

  const refreshing=useRef(false);
  const submitting=useRef(false);
  async function refresh(){
    if(refreshing.current)return;
    refreshing.current=true;
    try{
      const value=await api<{venues:VenueStatus[];bot:BotStatus;savedVenues:Venue[]}>('/api/exchange/status');
      EXCHANGES.forEach(exchange=>syncExchangeConnection(exchange.id,value.venues.some(account=>account.venue===exchange.id&&account.connected)));
      setStatuses(value.venues);setBot(value.bot);setSavedVenues(value.savedVenues??[]);
    }catch{/* Keep the last known account display while the backend restarts. */}finally{refreshing.current=false;}
  }
  useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),3000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{if(bot.running&&bot.venue===venue)setMode('bot');},[bot.running,bot.venue,venue]);
  async function run(path:string,body?:unknown){
    if(submitting.current)return false;
    submitting.current=true;
    setBusy(true);setMessage('');
    try{
      const result=await api<any>(path,{method:'POST',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
      setMessage(result.message??(result.order?result.takeProfitError??`Order accepted · ${result.order.side} · ${result.order.filled??result.order.amount} contracts${result.protectiveStop?' · stop loss accepted':''}${result.takeProfit?' · take profit accepted':''}`:'Request completed.'));
      if(path==='/api/exchange/disconnect')disconnectExchangeStream(venue);
      if(path==='/api/exchange/connect'||path==='/api/exchange/reconnect')reconnectExchangeStream(venue);
      if(path==='/api/exchange/auto/start'){setMode('bot');}
      if(path==='/api/exchange/order'||path==='/api/exchange/close'||path==='/api/exchange/protection'){
        if(result.order)setMessage(`Order ${result.order.id} | ${result.order.side} | ${result.order.status??'accepted'}${result.takeProfitError?` | ${result.takeProfitError}`:''}. See Positions for filled market orders.`);
        window.dispatchEvent(new CustomEvent('exchange-order-updated',{detail:{venue}}));
        void refresh();
        return true;
      }
      await refresh();return true;
    }catch(error){setMessage(String(error));return false;}finally{submitting.current=false;setBusy(false);}
  }
  function changeVenue(value:Venue){
    saveExchangeInstrument(defaultInstrumentForVenue(value));
    saveExchangeVenue(value);
  }

  return <div className={`live-account-content live-${view}-view`}>
    {view==='account'&&<ExchangeConnections venue={venue} instrument={instrument} statuses={statuses} savedVenues={savedVenues} busy={busy} onVenueChange={changeVenue} onRun={run} onOpenTerminal={onOpenTerminal}/>}
    {view==='terminal'&&<div className="live-method-section">
      <div className="ticket-connection">{sidebar&&<SidebarArrow open={sidebar.open} onToggle={sidebar.toggle} panelId="live-execution-sidebar"/>}<TabBar className="live-execution-mode-tabs" items={[{value:'manual',label:'Manual',controls:'manual-ticket-panel'},{value:'bot',label:'Bots',controls:'bot-ticket-panel'}] as const} value={mode} onChange={setMode} label="Execution mode" idPrefix="execution-tab"/><StatusBadge tone={connected?'positive':'warning'} dot>{connected?selected.name+' connected':'Not connected'}</StatusBadge>{!connected&&<Button variant="ghost" onClick={onManageAccount}>Connect API</Button>}</div>
      {account?.executionError&&<p className="exchange-inline-error">{account.executionError}</p>}
      {mode==='manual'?<ManualOrderTicket key={`${venue}-${instrument}`} venue={venue} asset={instrumentInfo.base} connected={connected} busy={busy} blocked={positionCheckFailed} botRunning={botForVenue} leverage={liveLeverage} minimumLeverage={leverage.minimum} maximumLeverage={leverage.maximum} leverageLoading={leverage.loading} onLeverageChange={setLiveLeverage} onRun={run}/>:<LiveBotPanel key={`${venue}-${instrument}`} venue={venue} settings={settings} onSettingsChange={onSettingsChange} onConfigure={onConfigure} profiles={profiles} onApplySetup={onApplySetup} bot={bot} connected={connected} busy={busy} blocked={positionCheckFailed} positionOpen={positionOpen} leverage={liveLeverage} minimumLeverage={leverage.minimum} maximumLeverage={leverage.maximum} leverageLoading={leverage.loading} onLeverageChange={setLiveLeverage} onRun={run}/>}

    </div>}
    {message&&<p className={message.startsWith('Error:')?'error':'live-result'} role="status">{message}</p>}
  </div>;
}

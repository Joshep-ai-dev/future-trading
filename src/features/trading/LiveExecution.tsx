import {ExecutionModeContext,type ExecutionMode} from './ExecutionModeContext';
import {useMarketLeverage} from '../../shared/api/useMarketLeverage';
import {useAutoConnectingExchanges} from '../../shared/api/useAutoConnectExchanges';
import {useContext,useEffect,useRef,useState} from 'react';
import {api} from '../../shared/api/api';
import {disconnectExchangeStream,reconnectExchangeStream,syncExchangeConnection} from '../../shared/api/useExchangeStream';
import ManualOrderTicket from './ManualOrderTicket';
import ExecutionPanel,{ExecutionMessage} from './ExecutionPanel';
import {Button,StatusBadge} from '../../shared/ui/ui';
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
  const autoConnecting=useAutoConnectingExchanges().includes(venue);
  const instrument=useExchangeInstrument(),instrumentInfo=instrumentDetails(instrument);
  const [savedVenues,setSavedVenues]=useState<Venue[]>([]);
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

  const feedback=message?<ExecutionMessage text={message} error={message.startsWith('Error:')}/>:null;
  if(view==='terminal')return <ExecutionPanel prefix="execution" mode={mode} onModeChange={setMode}
      footer={feedback}
      status={<>
        <div className="ticket-connection"><StatusBadge tone={connected?'positive':'warning'} dot>{connected?selected.name+' connected':'Not connected'}</StatusBadge>{!connected&&<Button variant="ghost" onClick={onManageAccount}>Connect API</Button>}</div>
        {account?.executionError&&<p className="exchange-inline-error">{account.executionError}</p>}
      </>}
      manual={<ManualOrderTicket key={`${venue}-${instrument}`} venue={venue} asset={instrumentInfo.base} connected={connected} busy={busy} blocked={positionCheckFailed} botRunning={botForVenue} leverage={liveLeverage} minimumLeverage={leverage.minimum} maximumLeverage={leverage.maximum} leverageLoading={leverage.loading} onLeverageChange={setLiveLeverage} onRun={run}/>}
      bot={<LiveBotPanel key={`${venue}-${instrument}`} venue={venue} settings={settings} onSettingsChange={onSettingsChange} onConfigure={onConfigure} profiles={profiles} onApplySetup={onApplySetup} bot={bot} connected={connected} busy={busy} blocked={positionCheckFailed} positionOpen={positionOpen} leverage={liveLeverage} minimumLeverage={leverage.minimum} maximumLeverage={leverage.maximum} leverageLoading={leverage.loading} onLeverageChange={setLiveLeverage} onRun={run}/>}/>;
  return <div className="live-account-content live-account-view">
    <ExchangeConnections venue={venue} instrument={instrument} statuses={statuses} savedVenues={savedVenues} busy={busy||autoConnecting} onVenueChange={changeVenue} onRun={run} onOpenTerminal={onOpenTerminal}/>
    {feedback}
  </div>;
}

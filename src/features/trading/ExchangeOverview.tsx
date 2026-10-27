import {useEffect,useState} from 'react';
import {api} from '../../shared/api/api';
import type {ExchangeVenue} from '../../shared/api/exchangeVenue';
import {AssetTable,OrderTable,PositionTable} from './ExchangeTables';
import {EmptyState,Panel,TabBar} from '../../shared/ui/ui';
import {useExchangeStream,type LivePosition} from '../../shared/api/useExchangeStream';
import LiveTradeHistory from './LiveTradeHistory';
import {BotEventLog} from './TradingHistory';
import PatternPanel from './PatternPanel';
import PositionProtection from './PositionProtection';
import {instrumentDetails,useExchangeInstrument} from '../../shared/api/exchangeInstrument';

type AccountTab='positions'|'orders'|'history'|'assets'|'botlog'|'patterns';
export default function ExchangeOverview({venue}:{venue:ExchangeVenue}){
  const {data,connected,error}=useExchangeStream(venue);
  const asset=instrumentDetails(useExchangeInstrument()).base;
  const [tab,setTab]=useState<AccountTab>('positions');
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [editingProtection,setEditingProtection]=useState<LivePosition|null>(null);
  const [protection,setProtection]=useState<Partial<Record<string,{stop:number|null;takeProfit:number|null}>>>({});
  const [protectionRevision,setProtectionRevision]=useState(0);
  const section=tab==='assets'?'balance':tab==='history'||tab==='botlog'||tab==='patterns'?'orders':tab;
  const sectionError=data?.errors[section];
  const positions=data?.positions;
  const orders=data?.orders;
  const lastUpdate=data?.sectionTimes[section];
  const idPrefix=`exchange-tab-${venue}`;

  async function closePosition(){
    if(!window.confirm(`Close the ${asset}/USDT position with a reduce-only market order?`))return;
    setBusy(true);setMessage('');
    try{
      const result=await api<{message?:string}>('/api/exchange/close',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({venue,confirmation:'CLOSE LIVE POSITION'}),
      });
      setMessage(result.message??'Close submitted. Waiting for exchange confirmation.');
    }catch(reason){setMessage(String(reason));}finally{setBusy(false);}
  }

  async function run(path:string,body:unknown){
    setBusy(true);setMessage('');
    try{
      await api(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      setMessage('TP/SL updated at the exchange.');
      setProtectionRevision(value=>value+1);
      return true;
    }catch(reason){setMessage(String(reason));return false;}finally{setBusy(false);}
  }
  const positionKey=positions?.map(position=>`${position.side}:${position.quantity}`).join('|')??'';
  // TP/SL orders are not in the account stream: read them now, after edits and every 15 s.
  useEffect(()=>{
    if(!positionKey){setProtection({});return;}
    let live=true;
    const sides=[...new Set(positions?.map(position=>position.side).filter(side=>side==='long'||side==='short')??[])];
    const load=()=>Promise.all(sides.map(async side=>[side,await api<{stop:number|null;takeProfit:number|null}>(`/api/exchange/protection?venue=${venue}&side=${side}`)] as const))
      .then(values=>live&&setProtection(Object.fromEntries(values))).catch(()=>undefined);
    void load();
    const timer=setInterval(()=>void load(),15000);
    return ()=>{live=false;clearInterval(timer);};
  },[venue,positionKey,protectionRevision]);
  const tableDisabled=busy||!connected||!!sectionError||!!data?.executionError;

  return <Panel className="exchange-activity" aria-label="Live exchange account">
    <TabBar<AccountTab> items={[
      {value:'positions',label:'Positions',count:positions?.length,controls:`exchange-${venue}-positions`},
      {value:'orders',label:'Open orders',count:orders?.length,controls:`exchange-${venue}-orders`},
      {value:'history',label:'P&L',controls:`exchange-${venue}-history`},
      {value:'assets',label:'Assets',controls:`exchange-${venue}-assets`},
      {value:'botlog',label:'Bot log',controls:`exchange-${venue}-botlog`},
      {value:'patterns',label:'Patterns',controls:`exchange-${venue}-patterns`},
    ]} value={tab} onChange={setTab} label="Exchange activity" idPrefix={idPrefix} trailing={<span>{venue.toUpperCase()} · {asset}USDT</span>}/>
    {(error||data?.errors.connection)&&<p className="exchange-inline-error" role="status">{error||data?.errors.connection} Displayed values may be stale.</p>}
    {data?.executionError&&<p className="exchange-inline-error">{data.executionError}</p>}
    {data?.errors.accountStream&&<p className="exchange-inline-error">{data.errors.accountStream}</p>}
    {sectionError&&<p className="exchange-inline-error" role="status">{sectionError} Account data is unverified.</p>}
    <div role="tabpanel" id={`exchange-${venue}-${tab}`} aria-labelledby={`${idPrefix}-${tab}`} className="exchange-activity-content">
      {tab==='positions'&&(positions?.length?
        <>
          <PositionTable asset={asset} positions={positions} disabled={tableDisabled} onClose={()=>void closePosition()} protection={protection} onEditProtection={setEditingProtection}/>
          {editingProtection&&(editingProtection.side==='long'||editingProtection.side==='short')&&<PositionProtection venue={venue} asset={asset} side={editingProtection.side} quantity={editingProtection.quantity} entryPrice={editingProtection.entryPrice} price={editingProtection.markPrice??data?.market?.last} disabled={tableDisabled} onRun={run} onClose={()=>setEditingProtection(null)}/>}
        </>:
        !sectionError&&<EmptyState compact title={positions?`No open ${asset} positions`:'Loading positions'} description={positions?'Your exchange positions will appear here automatically.':'Waiting for a verified account snapshot.'}/>)}
      {tab==='orders'&&(orders?.length?
        <OrderTable asset={asset} orders={orders}/>:
        !sectionError&&<EmptyState compact title={orders?'No standard open orders':'Loading orders'} description="Conditional and protective stops may be listed separately on the exchange."/>)}
      {tab==='assets'&&<AssetTable balance={data?.balance}/>}
      {tab==='history'&&<LiveTradeHistory venue={venue}/>}
      {tab==='botlog'&&<BotEventLog/>}
      {tab==='patterns'&&<PatternPanel/>}
    </div>
    {message&&<p className="exchange-inline-error" role="status">{message}</p>}
    <div className="exchange-activity-footer"><span>Exchange account · USDT</span><span>{lastUpdate?`Account snapshot ${new Date(lastUpdate).toLocaleTimeString()}`:'Waiting for account data'}</span></div>
  </Panel>;
}

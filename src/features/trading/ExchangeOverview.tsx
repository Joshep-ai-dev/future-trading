import {useState} from 'react';
import {api} from '../../shared/api/api';
import type {ExchangeVenue} from '../../shared/api/exchangeVenue';
import {AssetTable,OrderTable,PositionTable} from './ExchangeTables';
import {EmptyState,Panel,TabBar} from '../../shared/ui/ui';
import {useExchangeStream} from '../../shared/api/useExchangeStream';
import LiveTradeHistory from './LiveTradeHistory';
import {BotEventLog} from './TradingHistory';
import PatternPanel from './PatternPanel';

type AccountTab='positions'|'orders'|'history'|'assets'|'botlog'|'patterns';
export default function ExchangeOverview({venue}:{venue:ExchangeVenue}){
  const {data,connected,error}=useExchangeStream(venue);
  const [tab,setTab]=useState<AccountTab>('positions');
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const section=tab==='assets'?'balance':tab==='history'||tab==='botlog'||tab==='patterns'?'orders':tab;
  const sectionError=data?.errors[section];
  const positions=data?.positions;
  const orders=data?.orders;
  const lastUpdate=data?.sectionTimes[section];
  const idPrefix=`exchange-tab-${venue}`;

  async function closePosition(){
    if(!window.confirm('Close the XAG/USDT position with a reduce-only market order?'))return;
    setBusy(true);setMessage('');
    try{
      const result=await api<{message?:string}>('/api/exchange/close',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({venue,confirmation:'CLOSE LIVE POSITION'}),
      });
      setMessage(result.message??'Close submitted. Waiting for exchange confirmation.');
    }catch(reason){setMessage(String(reason));}finally{setBusy(false);}
  }

  return <Panel className="exchange-activity" aria-label="Live exchange account">
    <TabBar<AccountTab> items={[
      {value:'positions',label:'Positions',count:positions?.length,controls:`exchange-${venue}-positions`},
      {value:'orders',label:'Open orders',count:orders?.length,controls:`exchange-${venue}-orders`},
      {value:'history',label:'P&L',controls:`exchange-${venue}-history`},
      {value:'assets',label:'Assets',controls:`exchange-${venue}-assets`},
      {value:'botlog',label:'Bot log',controls:`exchange-${venue}-botlog`},
      {value:'patterns',label:'Patterns',controls:`exchange-${venue}-patterns`},
    ]} value={tab} onChange={setTab} label="Exchange activity" idPrefix={idPrefix} trailing={<span>{venue.toUpperCase()} · XAGUSDT</span>}/>
    {(error||data?.errors.connection)&&<p className="exchange-inline-error" role="status">{error||data?.errors.connection} Displayed values may be stale.</p>}
    {data?.executionError&&<p className="exchange-inline-error">{data.executionError}</p>}
    {data?.errors.accountStream&&<p className="exchange-inline-error">{data.errors.accountStream}</p>}
    {sectionError&&<p className="exchange-inline-error" role="status">{sectionError} Account data is unverified.</p>}
    <div role="tabpanel" id={`exchange-${venue}-${tab}`} aria-labelledby={`${idPrefix}-${tab}`} className="exchange-activity-content">
      {tab==='positions'&&(positions?.length?
        <PositionTable positions={positions} disabled={busy||!connected||!!sectionError||!!data?.executionError} onClose={()=>void closePosition()}/>:
        !sectionError&&<EmptyState compact title={positions?'No open XAG positions':'Loading positions'} description={positions?'Your exchange positions will appear here automatically.':'Waiting for a verified account snapshot.'}/>)}
      {tab==='orders'&&(orders?.length?
        <OrderTable orders={orders}/>:
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

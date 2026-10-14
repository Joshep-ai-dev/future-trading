import {useEffect,useRef,useState} from 'react';
import {api} from './api';

type Status = {running:boolean;lastSuccess:number|null;latestCandle:number|null;error:string|null;nextRefresh:number|null;addedRows:number;pages:number;pendingRows:number};
const date=(t:number)=>new Date(t*1000).toLocaleString();
export default function MarketStatus({onUpdated}:{onUpdated:()=>void}) {
  const [status,setStatus]=useState<Status|null>(null),[error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const callback=useRef(onUpdated),success=useRef<number|null>(null);
  callback.current=onUpdated;
  function accept(value:Status) {
    setStatus(value);
    if(value.lastSuccess!==null&&value.lastSuccess!==success.current) {
      success.current=value.lastSuccess;callback.current();
    }
  }
  useEffect(()=>{
    let active=true;
    async function poll() {
      try {const value=await api<Status>('/api/market-status');if(active){accept(value);setError('');}}
      catch(e){if(active)setError(String(e));}
    }
    void poll();const timer=setInterval(poll,15000);
    return ()=>{active=false;clearInterval(timer);};
  },[]);
  async function refresh() {
    setBusy(true);setError('');
    try {accept(await api<Status>('/api/market-refresh',{method:'POST'}));}
    catch(e){setError(String(e));}finally{setBusy(false);}
  }
  return <div className="data-strip" aria-label="Market data refresh"><div className="data-status"><i className={`status-dot ${error||status?.error?'dot-error':status?.running?'dot-busy':''}`}/><span>{error||status?.error?'Data sync needs attention':status?.running?'Syncing market history':'OKX market data'}</span><span className="data-muted">{status?.lastSuccess?`Checked ${date(status.lastSuccess)}`:'Hourly sync enabled'}</span></div>
    <div className="data-actions"><details><summary>Data details</summary><div className="data-popover"><p>Confirmed candles download on startup and hourly. The running live bot adds 30-second checks.</p><p>Latest downloaded candle: {status?.latestCandle?date(status.latestCandle):'Waiting'}<br/>Next scheduled check: {status?.nextRefresh?date(status.nextRefresh):'Waiting'}</p>{status?.running&&<p>Fetched {status.pages??0} pages; {(status.pendingRows??0).toLocaleString()} minutes pending save.</p>}</div></details><button type="button" className="text-button" disabled={busy||status?.running} onClick={()=>void refresh()}>{busy||status?.running?'Syncing…':'↻ Sync data'}</button></div>
    {(error||status?.error)&&<p role="alert" className="data-error">{error||status?.error}. Existing data is available; automatic sync will retry.</p>}
  </div>;
}

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
  return <section aria-label="Market data refresh"><p>OKX candle downloads run on startup and every hour while the backend is running. {status?.running?'Downloading missing candles…':status?.lastSuccess?`Last successful check: ${date(status.lastSuccess)}. Added ${status.addedRows.toLocaleString()} minutes.`:'Waiting for the first download.'} {status?.latestCandle?`Latest downloaded candle: ${date(status.latestCandle)}.`:''} {status?.nextRefresh&&!status.running?`Next check: ${date(status.nextRefresh)}.`:''}</p>
    {status?.running&&<p role="status">Fetched {status.pages??0} pages; {(status.pendingRows??0).toLocaleString()} completed minutes pending save.</p>}
    <button type="button" className="secondary" disabled={busy||status?.running} onClick={()=>void refresh()}>{busy?'Downloading…':'Download latest prices now'}</button>
    {(error||status?.error)&&<p role="alert" className="error">Download failed: {error||status?.error}. Existing prices remain available; the hourly job will retry.</p>}
  </section>;
}

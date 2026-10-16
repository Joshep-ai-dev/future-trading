import {useEffect,useRef,useState} from 'react';
import {api} from '../api/api';

type Backfill={running:boolean;targetStart:number|null;oldestCandle:number|null;addedRows:number;pages:number;error:string|null;finished:number|null;reachedStart:boolean};
const day=(t:number|null)=>t?new Date(t*1000).toISOString().slice(0,10):'—';

/** Download older OKX minute candles into the separate history file. */
export default function HistoryBackfill({onFinished}:{onFinished:()=>void}){
  const [status,setStatus]=useState<Backfill|null>(null),[error,setError]=useState(''),[days,setDays]=useState(365);
  const wasRunning=useRef(false);
  useEffect(()=>{
    let active=true;
    const load=()=>api<Backfill>('/api/market-backfill').then(value=>{
      if(!active)return;
      setStatus(value);
      if(wasRunning.current&&!value.running)onFinished();
      wasRunning.current=value.running;
    }).catch(reason=>{if(active)setError(String(reason));});
    void load();const timer=setInterval(()=>void load(),2000);
    return()=>{active=false;clearInterval(timer);};
  },[onFinished]);
  async function start(){
    setError('');
    try{setStatus(await api<Backfill>('/api/market-backfill',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({days})}));wasRunning.current=true;}
    catch(reason){setError(String(reason));}
  }
  async function stop(){try{setStatus(await api<Backfill>('/api/market-backfill/stop',{method:'POST'}));}catch(reason){setError(String(reason));}}
  return <div className="history-backfill">
    <strong>Older history</strong>
    <p>Download earlier OKX minute candles for longer backtests and ML training. Saved separately; your original data is not changed.</p>
    {status?.running?<>
      <p className="backfill-progress">Downloading… {status.pages.toLocaleString()} pages · back to {day(status.oldestCandle)} · {status.addedRows.toLocaleString()} minutes saved</p>
      <button type="button" className="secondary" onClick={()=>void stop()}>Stop</button>
    </>:<div className="backfill-start">
      <select aria-label="History to download" value={days} onChange={event=>setDays(Number(event.target.value))}><option value={90}>90 days</option><option value={180}>180 days</option><option value={365}>1 year</option><option value={1095}>3 years</option></select>
      <button type="button" className="secondary" onClick={()=>void start()}>Download</button>
    </div>}
    {status?.finished&&!status.running&&<p className="backfill-result">{status.error?`Stopped: ${status.error}`:status.reachedStart?`Done. OKX history for this contract starts ${day(status.oldestCandle)}.`:`Done. ${status.addedRows.toLocaleString()} minutes added, back to ${day(status.oldestCandle)}.`}</p>}
    {error&&<p className="data-error">{error}</p>}
  </div>;
}

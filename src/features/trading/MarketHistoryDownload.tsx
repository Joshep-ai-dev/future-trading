import {useEffect,useId,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {api} from '../../shared/api/api';
import {notifyMarketDataUpdated} from '../../shared/charts/marketDataRevision';
import type {MarketDataset} from '../../shared/api/useMarketDatasets';
const utcDate=(offset=0)=>new Date(Date.now()+offset*86400000).toISOString().slice(0,10);
type DownloadResult=MarketDataset&{downloadedBars:number;downloadedStart:number;downloadedEnd:number;limitedHistory?:boolean};
export default function MarketHistoryDownload({venue,symbol,connected}:{venue:string;symbol:string;connected:boolean}){
  const [open,setOpen]=useState(false),[start,setStart]=useState(()=>utcDate(-6)),[end,setEnd]=useState(()=>utcDate());
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState<DownloadResult|null>(null);
  const dialog=useRef<HTMLDialogElement>(null),titleId=useId();
  const dayCount=Math.round((Date.parse(end)-Date.parse(start))/86400000)+1;
  const valid=!!start&&!!end&&dayCount>=1&&dayCount<=30&&end<=utcDate();
  useEffect(()=>{
    if(!open)return;
    const element=dialog.current,previous=document.activeElement as HTMLElement|null;
    element?.showModal();return()=>{element?.close();previous?.focus();};
  },[open]);
  async function download(){
    if(!valid||busy)return;
    setBusy(true);setError('');setResult(null);
    try{const data=await api<DownloadResult>('/api/exchange/history/download',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({venue,symbol,start_date:start,end_date:end})});setResult(data);notifyMarketDataUpdated();}
    catch(reason){setError(String(reason));}finally{setBusy(false);}
  }
  return <><button className="history-download-icon" type="button" aria-label="Download one-minute history" title="Download 1m history" onClick={()=>setOpen(true)}><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/></svg></button>{open&&createPortal(<dialog ref={dialog} className="history-download-modal" aria-labelledby={titleId} onCancel={event=>{event.preventDefault();setOpen(false);}} onClick={event=>{if(event.target!==event.currentTarget)return;const bounds=event.currentTarget.getBoundingClientRect();if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)setOpen(false);}}>
    <form onSubmit={event=>{event.preventDefault();void download();}}>
      <header><div><h2 id={titleId}>Download market history</h2><p>{symbol.split(':')[0]} <span> / {venue.toUpperCase()}</span></p></div><button type="button" className="history-modal-close" aria-label="Close history download" onClick={()=>setOpen(false)}><svg width="18" height="18" viewBox="0 0 20 20" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg></button></header>
      <div className="history-modal-body"><div className="history-modal-info"><span>1 minute</span><span>OHLCV candles</span><span>CSV export</span></div><p className="history-modal-description">Choose the history to save for paper replay and backtesting. Dates use UTC.</p>
      <div className="history-range-presets" role="group" aria-label="Quick date ranges">{[1,7,14,30].map(days=><button key={days} type="button" disabled={busy} aria-pressed={start===utcDate(1-days)&&end===utcDate()} onClick={()=>{setStart(utcDate(1-days));setEnd(utcDate());setResult(null);}}>{days===1?'Today':`${days} days`}</button>)}</div>
      <div className="history-date-range"><label>Start date<input type="date" aria-label="History start date" required max={end||utcDate()} value={start} disabled={busy} onChange={event=>{setStart(event.target.value);setResult(null);}}/></label><label>End date<input type="date" aria-label="History end date" required min={start} max={utcDate()} value={end} disabled={busy} onChange={event=>{setEnd(event.target.value);setResult(null);}}/></label></div>
      <p className="history-range-caption">{valid?`${dayCount} day${dayCount===1?'':'s'} selected. Up to 30 days per download.`:'Choose a date range of 1 to 30 days, ending today or earlier.'}</p>
      <p className="history-availability">{venue==='hyperliquid'?'Hyperliquid provides only the latest 5,000 one-minute candles (about 3.5 days). Older saved data remains available for replay.':'Exchange retention limits may reduce the available range.'} Today includes completed candles only.</p>
      {busy&&<p role="status" className="history-modal-status">Downloading candles from {venue.toUpperCase()}...</p>}{error&&<p role="alert" className="history-modal-error">{error}</p>}{result&&<div role="status" className="history-modal-success"><strong>{result.downloadedBars.toLocaleString()} candles saved</strong><p>{new Date(result.downloadedStart*1000).toISOString().slice(0,16)} to {new Date(result.downloadedEnd*1000).toISOString().slice(0,16)} UTC</p><p>{result.limitedHistory?'The exchange returned only part of your requested range. ':''}{result.missingBars} missing minutes in the saved dataset.</p><a href={`/api/market/datasets/export?market=${encodeURIComponent(result.id)}`} download>Export CSV</a><p>Available from the symbol dropdown in Paper mode.</p></div>}</div>
      <footer><button type="button" className="history-modal-secondary" onClick={()=>setOpen(false)}>Close</button><button type="submit" className="history-modal-primary" disabled={busy||!connected||!valid}>{busy?'Downloading...':'Download history'}</button></footer>
    </form>
  </dialog>,document.body)}</>;
}

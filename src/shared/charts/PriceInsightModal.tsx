import {useEffect,useId,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {api} from '../api/api';
import {displaySymbol} from './displaySymbol';
import './priceInsight.css';

type OnlineAnalysis={supported:boolean;message?:string;source:string;sourceUrl:string;market:string;updatedAt:string;fetchedAt:number;stale:boolean;pivotDate:string|null;referencePrice:number|null;rangeLow:number|null;rangeHigh:number|null;rangeMethod:string|null;levels:Record<string,number>;signals:{timeframe:string;rating:string;asOf:string|null;computedAt:string|null}[]};
type Candle={time:number;close:number};
const providerFrames:Record<string,string>={'1m':'1min','5m':'5min','15m':'15min','30m':'30min','1h':'1h','4h':'4h','1d':'1D'};

export default function PriceInsightModal({symbol,timeframe,getCandles,onClose}:{symbol:string;timeframe:string;getCandles:()=>Candle[];clock:number;onClose:()=>void}){
  const dialog=useRef<HTMLDialogElement>(null),title=useId();
  const [analysis,setAnalysis]=useState<OnlineAnalysis|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[revision,setRevision]=useState(0);
  const [,setTick]=useState(0);
  const latest=getCandles().at(-1);
  useEffect(()=>{
    const element=dialog.current,previous=document.activeElement as HTMLElement|null;
    element?.showModal();
    const timer=setInterval(()=>setTick(value=>value+1),1000);
    return()=>{clearInterval(timer);element?.close();previous?.focus();};
  },[]);
  useEffect(()=>{
    const abort=new AbortController();
    setAnalysis(null);setError('');setLoading(true);
    api<OnlineAnalysis>(`/api/market/online-analysis?symbol=${encodeURIComponent(symbol)}`,{signal:abort.signal})
      .then(value=>{if(!abort.signal.aborted)setAnalysis(value);})
      .catch(reason=>{if(!abort.signal.aborted)setError(String(reason));})
      .finally(()=>{if(!abort.signal.aborted)setLoading(false);});
    return()=>abort.abort();
  },[symbol,revision]);
  const format=(value:number|null|undefined)=>value==null?'Not published':value.toLocaleString(undefined,{maximumSignificantDigits:8});
  const stamp=(value:string)=>new Date(value).toLocaleString();
  const signal=analysis?.signals?.find(row=>row.timeframe===providerFrames[timeframe]);
  const daily=analysis?.signals?.find(row=>row.timeframe==='1D');
  const stale=!!analysis&&(analysis.stale||Date.now()-new Date(analysis.updatedAt).getTime()>3600000);
  return createPortal(<dialog ref={dialog} className="price-insight-modal" aria-labelledby={title} onCancel={onClose} onClick={event=>{if(event.target===event.currentTarget){const r=event.currentTarget.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)onClose();}}}>
    <header><div><small>{displaySymbol(symbol)} · {timeframe}</small><h2 id={title}>Online price outlook</h2></div><button type="button" autoFocus onClick={onClose} aria-label="Close price outlook">×</button></header>
    <dl><div><dt>Current chart price</dt><dd>{format(latest?.close)}</dd></div><div><dt>Chart candle time</dt><dd className="insight-time">{latest?new Date(latest.time*1000).toLocaleString():'Unavailable'}</dd></div></dl>
    {loading&&<p role="status">Finding online analysis for {displaySymbol(symbol)}…</p>}
    {error&&<p role="alert">{error}</p>}
    {analysis&&!analysis.supported&&<p role="status">{analysis.message}</p>}
    {analysis?.supported&&<>
      <p><a href={analysis.sourceUrl} target="_blank" rel="noopener noreferrer">{analysis.source} analysis ↗</a><br/>{analysis.market} · USD<br/>Published calculation: {stamp(analysis.updatedAt)} (local time)</p>
      {stale&&<p className="insight-delayed" role="status">Delayed source analysis. These published values may no longer describe the current market.</p>}
      <dl>
        <div><dt>{signal?`${timeframe} technical outlook`:'Daily technical outlook'}</dt><dd>{(signal??daily)?.rating.replaceAll('_',' ')??'Not published'}</dd></div>
        <div><dt>Expected weekly range · USD</dt><dd>{analysis.rangeLow!=null&&analysis.rangeHigh!=null?`${format(analysis.rangeLow)} – ${format(analysis.rangeHigh)}`:'Not published'}</dd></div>
        <div className="insight-support"><dt>Published support S1 · USD</dt><dd>{format(analysis.levels.s1)}</dd></div>
        <div className="insight-resistance"><dt>Published resistance R1 · USD</dt><dd>{format(analysis.levels.r1)}</dd></div>
      </dl>
      {!signal&&<p>The source does not provide a {timeframe} signal. Showing its daily outlook.</p>}
      {(signal??daily)?.computedAt&&<small>Outlook calculated: {stamp((signal??daily)!.computedAt!)} (local time).</small>}
      <p>Classic daily pivots · source bar date: {analysis.pivotDate??'Not published'}<br/>S2 {format(analysis.levels.s2)} · S3 {format(analysis.levels.s3)}<br/>Pivot {format(analysis.levels.pivot)}<br/>R2 {format(analysis.levels.r2)} · R3 {format(analysis.levels.r3)}</p>
      <p>The weekly range is the source’s {analysis.rangeMethod==='atr'?'ATR-based estimate':'published estimate'}, not a single target price. Signals describe technical conditions. This underlying market can differ from your exchange’s perpetual price. Online analysis is current-source data, including when viewing historical or replay candles.</p>
      <small>Retrieved: {new Date(analysis.fetchedAt*1000).toLocaleString()} (local time).</small>
    </>}
    <footer><button type="button" onClick={()=>setRevision(value=>value+1)} disabled={loading}>{loading?'Loading…':'Refresh online analysis'}</button></footer>
  </dialog>,document.body);
}

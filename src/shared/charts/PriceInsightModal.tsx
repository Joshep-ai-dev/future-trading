import {useEffect,useId,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {api} from '../api/api';
import {displaySymbol} from './displaySymbol';
import './priceInsight.css';

type OnlineAnalysis={nearestSupport:number|null;nextResistance:number|null;quoteUpdatedAt?:string;priceChangePct?:number;summary?:{buy:number;sell:number;neutral:number;total:number};signalChange?:{previous:string;changedAt:string}|null;supported:boolean;timeframe?:string;message?:string;source:string;sourceUrl:string;market:string;updatedAt:string;fetchedAt:number;stale:boolean;pivotDate:string|null;referencePrice:number|null;rangeLow:number|null;rangeHigh:number|null;rangeMethod:string|null;levels:Record<string,number>;signals:{timeframe:string;rating:string;asOf:string|null;computedAt:string|null}[]};
type Candle={time:number;close:number};
const providerFrames:Record<string,string>={'1m':'1min','5m':'5min','15m':'15min','30m':'30min','1h':'1H','4h':'4H','1d':'1D','1w':'1W'};

export default function PriceInsightModal({symbol,timeframe,onClose}:{symbol:string;timeframe:string;getCandles?:()=>Candle[];clock?:number;onClose:()=>void}){
  const dialog=useRef<HTMLDialogElement>(null),title=useId();
  const [analysis,setAnalysis]=useState<OnlineAnalysis|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[lastChecked,setLastChecked]=useState<number|null>(null);
  const [,setTick]=useState(0);

  useEffect(()=>{
    const element=dialog.current,previous=document.activeElement as HTMLElement|null;
    element?.showModal();
    const timer=setInterval(()=>setTick(value=>value+1),1000);
    return()=>{clearInterval(timer);element?.close();previous?.focus();};
  },[]);
  useEffect(()=>{
    const abort=new AbortController();
    setAnalysis(null);setError('');setLoading(true);setLastChecked(null);
    let pending=false;
    function load(){
      if(pending||abort.signal.aborted)return;
      pending=true;
      void api<OnlineAnalysis>(`/api/market/online-analysis?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`,{signal:abort.signal})
      .then(value=>{if(!abort.signal.aborted){setAnalysis(value);setError('');setLastChecked(Date.now());}})
      .catch(reason=>{if(!abort.signal.aborted)setError(String(reason));})
      .finally(()=>{pending=false;if(!abort.signal.aborted)setLoading(false);});
    }
    load();
    const timer=setInterval(load,5000);
    return()=>{abort.abort();clearInterval(timer);};
  },[symbol,timeframe]);
  const format=(value:number|null|undefined)=>value==null?'Not published':value.toLocaleString(undefined,{maximumFractionDigits:Math.abs(value)<1?5:2});
  const stamp=(value:string)=>new Date(value).toLocaleString();
  const signal=analysis?.signals?.find(row=>row.timeframe.toUpperCase()===providerFrames[analysis?.timeframe??timeframe]?.toUpperCase());
  const rating=signal?.rating.toLowerCase().replaceAll('_',' ');
  const stale=!!analysis&&(analysis.stale||Date.now()-new Date(analysis.updatedAt).getTime()>3600000);
  return createPortal(<dialog ref={dialog} className="price-insight-modal" aria-labelledby={title} onCancel={onClose} onClick={event=>{if(event.target===event.currentTarget){const r=event.currentTarget.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)onClose();}}}>
    <header><div><small>{displaySymbol(symbol)} · {timeframe}</small><h2 id={title}>Price outlook</h2></div><button type="button" autoFocus onClick={onClose} aria-label="Close price outlook">×</button></header>
    {loading&&<p role="status">Finding online analysis for {displaySymbol(symbol)}…</p>}
    {error&&<p role="alert">{error}</p>}
    {analysis&&!analysis.supported&&<p role="status">{analysis.message}</p>}
    {analysis?.supported&&<>
      <div className="forecast-source"><a href={analysis.sourceUrl} target="_blank" rel="noopener noreferrer">{analysis.source} forecast &#8599;</a><span>{analysis.market}</span><strong>{format(analysis.referencePrice)}</strong>{analysis.priceChangePct!=null&&<span className={analysis.priceChangePct<0?'negative':'positive'}>{analysis.priceChangePct.toFixed(2)}%</span>}</div>
      {stale&&<p className="insight-delayed" role="status">Delayed source analysis.</p>}
      <p className="forecast-eyebrow">Technical outlook &middot; Daily</p>
      <div className="forecast-signal">
        <div className="forecast-gauge">
          <h3>Overall Signal</h3>
          <svg viewBox="0 0 180 110" role="img" aria-label={`Overall signal: ${rating??'Unavailable'}`}>
            <path d="M15 90 A75 75 0 0 1 52.5 25" stroke="#f23645"/>
            <path d="M52.5 25 A75 75 0 0 1 127.5 25" stroke="#8c929d"/>
            <path d="M127.5 25 A75 75 0 0 1 165 90" stroke="#26a69a"/>
            <g transform={`rotate(${({'strong sell':-75,sell:-40,neutral:0,buy:40,'strong buy':75} as Record<string,number>)[rating??'neutral']??0} 90 90)`}><line x1="90" y1="90" x2="90" y2="28"/><circle cx="90" cy="90" r="4"/></g>
          </svg>
          <strong className={rating?.includes('sell')?'negative':rating?.includes('buy')?'positive':''}>{rating??'Not published'}</strong>
          {analysis.summary&&<div className="forecast-counts"><span className="negative">{analysis.summary.sell} Sell</span><span>{analysis.summary.neutral} Neutral</span><span className="positive">{analysis.summary.buy} Buy</span></div>}
        </div>
        <div className="forecast-signal-copy"><p>{analysis.market.split(' \u00b7 ')[0]}: <strong className={rating?.includes('sell')?'negative':rating?.includes('buy')?'positive':''}>{rating??'Not published'}</strong> on the Daily timeframe</p>
          {analysis.signalChange&&<p>Previous signal: {analysis.signalChange.previous}</p>}
          <small>Updated {stamp(analysis.updatedAt)}</small>
        </div>
      </div>
      <p className="forecast-eyebrow">Key levels today &middot; based on daily pivot points</p>
      <div className="forecast-levels">
        <div className="insight-support"><span>Nearest support</span><strong>{format(analysis.nearestSupport)}</strong></div>
        <div><span>Price now</span><strong>{format(analysis.referencePrice)}</strong></div>
        <div className="insight-resistance"><span>Next resistance</span><strong>{format(analysis.nextResistance)}</strong></div>
        <div className="forecast-weekly"><span>Weekly range</span><strong>{format(analysis.rangeLow)} &ndash; {format(analysis.rangeHigh)}</strong><small>from current volatility</small></div>
      </div>
    </>}
    <footer><small>{error?'Retrying automatically every 5 seconds':'Auto-refresh every 5 seconds'}{lastChecked&&<> &middot; Last checked {new Date(lastChecked).toLocaleTimeString()}</>}</small></footer>
  </dialog>,document.body);
}

import {useEffect,useState} from 'react';
import {api} from '../api/api';
import {Metric} from './ui';
import PriceInsightModal from '../charts/PriceInsightModal';

type Analysis={nearestSupport:number|null;nextResistance:number|null;supported:boolean;timeframe?:string;message?:string;stale:boolean;updatedAt:string;source:string;sourceUrl:string;market:string;pivotDate:string|null;rangeLow:number|null;rangeHigh:number|null;levels:Record<string,number>;signals:{timeframe:string;rating:string}[]};
const price=(value:number|null|undefined)=>value==null?'Unavailable':value.toLocaleString(undefined,{maximumFractionDigits:Math.abs(value)<1?5:2});

export default function MarketOutlook({symbol,timeframe,active=true}:{symbol:string;timeframe:string;active?:boolean}){
  const [analysis,setAnalysis]=useState<Analysis|null>(null);
  const [error,setError]=useState('');
  const [open,setOpen]=useState(false);
  useEffect(()=>setOpen(false),[symbol,timeframe,active]);
  useEffect(()=>{
    setAnalysis(null);setError('');
    if(!active)return;
    const abort=new AbortController();
    let loading=false;
    async function load(){
      if(loading||abort.signal.aborted)return;
      loading=true;
      try{
        const value=await api<Analysis>(`/api/market/online-analysis?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`,{signal:abort.signal});
        
        if(!abort.signal.aborted){setAnalysis(value);setError('');}
      }catch(reason){if(!abort.signal.aborted){setAnalysis(null);setError(reason instanceof Error?reason.message:'Outlook unavailable');}}
      finally{loading=false;}
    }
    void load();
    const timer=setInterval(()=>void load(),5000);
    return()=>{abort.abort();clearInterval(timer);};
  },[symbol,timeframe,active]);
  if(!active)return null;
  if(!analysis?.supported)return <div className="market-outlook-status" role="status">{error|| (analysis?(analysis.message??'No source outlook for this market'):'Loading market outlook...')}</div>;
  const providerFrame:Record<string,string>={'1m':'1min','5m':'5min','15m':'15min','30m':'30min','1h':'1H','4h':'4H','1d':'1D','1w':'1W'};
  const signal=analysis.signals.find(item=>item.timeframe.toUpperCase()===providerFrame[analysis.timeframe??timeframe]?.toUpperCase());
  const rating=signal?.rating.toLowerCase().replaceAll('_',' ');
  const tone=rating?.includes('buy')?'positive':rating?.includes('sell')?'negative':'neutral';
  const delayed=analysis.stale||Date.now()-new Date(analysis.updatedAt).getTime()>3600000;
  return <><div className="market-outlook live-header-stats" role="button" tabIndex={0} aria-haspopup="dialog" onClick={()=>setOpen(true)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();setOpen(true);}}} aria-label="Open price outlook" title={`${analysis.source} | ${delayed?'Delayed | ':''}${new Date(analysis.updatedAt).toLocaleString()} | ${analysis.market} | ${timeframe} Classic pivots: ${analysis.pivotDate??'Unavailable'} | Weekly range is an estimate`}>
    <Metric label={`Outlook${delayed?' (delayed)':''}`} tone={tone} value={<span className="market-outlook-rating">{rating??'Unavailable'}</span>}/>
    <Metric label="Weekly range" value={`${price(analysis.rangeLow)} - ${price(analysis.rangeHigh)}`}/>
    <Metric label="Nearest support" value={price(analysis.nearestSupport)} tone="positive"/>
    <Metric label="Next resistance" value={price(analysis.nextResistance)} tone="negative"/>
  </div>{open&&<PriceInsightModal symbol={symbol} timeframe={timeframe} onClose={()=>setOpen(false)}/>}</>;
}

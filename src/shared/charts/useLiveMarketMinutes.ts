import {useEffect,useRef,useState} from 'react';
import {api} from '../api/api';
import {mergeHistory} from './candleHistory';
import type {Candle} from '../../features/trading/replayAnimation';

type Snapshot={candles:Candle[];checkedAt:number;stale:boolean};
type Tick={last:number;timestamp:number};

/** Move the forming minute with the latest trade price (display only), opening a new minute when needed. */
function applyTick(minutes:Candle[],tick:Tick|null):Candle[]{
  if(!tick||!minutes.length)return minutes;
  const time=Math.floor(tick.timestamp/1000/60)*60,last=minutes[minutes.length-1];
  if(time<last.time)return minutes;
  if(time===last.time){
    if(last.close===tick.last&&last.high>=tick.last&&last.low<=tick.last)return minutes;
    return [...minutes.slice(0,-1),{...last,close:tick.last,high:Math.max(last.high,tick.last),low:Math.min(last.low,tick.last)}];
  }
  return [...minutes,{...last,time,open:tick.last,high:tick.last,low:tick.last,close:tick.last,volume:0}].slice(-600);
}

/** Public display feed, independent of paper sessions and strategy execution.
 *  Completed OHLCV comes from polling; the forming minute follows the real-time exchange ticker
 *  (OKX XAG, or the downloaded market's own exchange). */
export function useLiveMarketMinutes(enabled:boolean,market='xag'){
  const [state,setState]=useState<{minutes:Candle[];checkedAt:number|null;stale:boolean;error:string}>({minutes:[],checkedAt:null,stale:true,error:''});
  const tick=useRef<Tick|null>(null);
  useEffect(()=>{
    setState({minutes:[],checkedAt:null,stale:true,error:''});tick.current=null;
    if(!enabled)return;
    const abort=new AbortController();
    let timer:ReturnType<typeof setTimeout>|undefined,disposed=false;
    async function poll(){
      try{
        const snapshot=await api<Snapshot>(market==='xag'?'/api/market/live-candles':`/api/paper/market?market=${encodeURIComponent(market)}`,{signal:abort.signal});
        if(!disposed)setState(previous=>({minutes:applyTick(mergeHistory(previous.minutes,snapshot.candles).slice(-600),tick.current),checkedAt:snapshot.checkedAt,stale:snapshot.stale,error:''}));
      }catch(error){
        if(!disposed)setState(previous=>({...previous,stale:true,error:String(error)}));
      }finally{if(!disposed)timer=setTimeout(poll,market==='xag'?2000:5000);}
    }
    void poll();
    const realtime=market==='xag'||market.startsWith('dataset:');
    const ticker=realtime?new EventSource(`/api/market/realtime?${new URLSearchParams({kind:'ticker',market})}`):null;
    if(ticker)ticker.onmessage=event=>{
      try{
        const next=JSON.parse(event.data) as Tick;
        if(!Number.isFinite(next.last)||next.last<=0)return;
        tick.current=next;
        setState(previous=>{const minutes=applyTick(previous.minutes,next);return minutes===previous.minutes?previous:{...previous,minutes,checkedAt:next.timestamp/1000};});
      }catch{/* Ignore malformed frames. */}
    };
    return()=>{disposed=true;abort.abort();ticker?.close();if(timer)clearTimeout(timer);};
  },[enabled,market]);
  return state;
}

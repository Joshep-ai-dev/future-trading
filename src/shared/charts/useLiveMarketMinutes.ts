import {useEffect,useState} from 'react';
import {api} from '../api/api';
import {mergeHistory} from './candleHistory';
import type {Candle} from '../../features/trading/replayAnimation';

type Snapshot={candles:Candle[];checkedAt:number;stale:boolean};

/** Public display feed, independent of paper sessions and strategy execution. */
export function useLiveMarketMinutes(enabled:boolean){
  const [state,setState]=useState<{minutes:Candle[];checkedAt:number|null;stale:boolean;error:string}>({minutes:[],checkedAt:null,stale:true,error:''});
  useEffect(()=>{
    if(!enabled)return;
    const abort=new AbortController();
    let timer:ReturnType<typeof setTimeout>|undefined,disposed=false;
    async function poll(){
      try{
        const snapshot=await api<Snapshot>('/api/market/live-candles',{signal:abort.signal});
        if(!disposed)setState(previous=>({minutes:mergeHistory(previous.minutes,snapshot.candles).slice(-600),checkedAt:snapshot.checkedAt,stale:snapshot.stale,error:''}));
      }catch(error){
        if(!disposed)setState(previous=>({...previous,stale:true,error:String(error)}));
      }finally{if(!disposed)timer=setTimeout(poll,2000);}
    }
    void poll();
    return()=>{disposed=true;abort.abort();if(timer)clearTimeout(timer);};
  },[enabled]);
  return state;
}

import {useEffect,useMemo,useRef,useState} from 'react';
import {api} from './api';
import {candleAt,type Candle} from './replayAnimation';
import {mergeHistory} from './candleHistory';
import {TIMEFRAMES} from './chartTimeframe';
import {aggregateMinutes,timeframeIndicators} from './aggregateTimeframe';
import type {BacktestSettings} from './types';

type Page={candles:Candle[];hasMore:boolean};
export function useChartTimeframe(timeframe:BacktestSettings['entry_timeframe'],sessionId:number,clock:number,enabled:boolean,updates:Candle[],config:BacktestSettings['bb_reversal'],synthetic:boolean){
  const duration=TIMEFRAMES[timeframe];
  const latest=useRef({clock,duration});latest.current={clock,duration};
  const [state,setState]=useState<{id:number;minutes:Candle[];error:string}>({id:sessionId,minutes:[],error:''});
  useEffect(()=>{
    if(!enabled)return;
    let disposed=false,timer:ReturnType<typeof setTimeout>,pool:Candle[]=[],before:number|undefined,more=true,lastCutoff=0;
    const abort=new AbortController();
    async function page(cursor:number){return api<Page>('/api/candles',{method:'POST',headers:{'Content-Type':'application/json'},signal:abort.signal,body:JSON.stringify({timeframe:'1m',before:cursor,limit:5000})});}
    async function refresh(){
      try{
        const cutoff=Math.floor(latest.current.clock/60)*60;
        if(cutoff>0&&cutoff!==lastCutoff){
          const result=await page(cutoff);
          if(disposed)return;
          pool=mergeHistory(pool,result.candles);lastCutoff=cutoff;
          if(before===undefined){before=pool[0]?.time;more=result.hasMore;}
          setState({id:sessionId,minutes:pool,error:''});
        }
        const target=Math.min(50000,Math.max(5000,150*latest.current.duration/60));
        if(pool.length<target&&more&&before!==undefined){
          const result=await page(before);if(disposed)return;
          pool=mergeHistory(result.candles,pool);before=pool[0]?.time;more=result.hasMore&&result.candles.length>0;
        }
        if(!disposed)setState({id:sessionId,minutes:pool,error:''});
      }catch(error){if(!disposed)setState(old=>({id:sessionId,minutes:old.id===sessionId?old.minutes:[],error:String(error)}));}
      finally{if(!disposed)timer=setTimeout(refresh,1000);}
    }
    void refresh();return ()=>{disposed=true;abort.abort();clearTimeout(timer);};
  },[sessionId,enabled]);
  const minutes=useMemo(()=>mergeHistory(state.id===sessionId?state.minutes:[],updates),[state,sessionId,updates]);
  const cutoff=Math.floor(clock/60)*60;
  const candles=useMemo(()=>aggregateMinutes(minutes,duration,cutoff),[minutes,duration,cutoff]);
  const indicators=useMemo(()=>timeframeIndicators(candles,config),[candles,config.bb_length,config.bb_mult,config.sma_length,config.use_sma_trend_adjustment]);
  let forming:Candle|null;
  if(synthetic)forming=candleAt(minutes,clock,duration);
  else{
    const start=Math.floor(clock/duration)*duration,rows=minutes.filter(r=>r.time>=start&&r.time<=clock);
    forming=rows.length&&rows.every((r,i)=>r.time===start+i*60)?{time:start,open:rows[0].open,high:Math.max(...rows.map(r=>r.high)),low:Math.min(...rows.map(r=>r.low)),close:rows.at(-1)!.close}:null;
  }
  return {view:{candles,indicators,minutes,forming},error:state.id===sessionId?state.error:''};
}

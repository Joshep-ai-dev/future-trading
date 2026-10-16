import type {Candle} from '../../features/trading/replayAnimation';
import type {BacktestSettings} from '../types/types';

export function aggregateMinutes(minutes:Candle[],duration:number,clock:number){
  const buckets=new Map<number,{candle:Candle;count:number;last:number;valid:boolean}>();
  for(const row of minutes){
    if(row.time+60>clock)break;
    const time=Math.floor(row.time/duration)*duration;
    if(time+duration>clock)continue;
    const bucket=buckets.get(time);
    if(!bucket)buckets.set(time,{candle:{...row,time},count:1,last:row.time,valid:row.time===time});
    else{bucket.valid&&=row.time===bucket.last+60;bucket.count++;bucket.last=row.time;bucket.candle.high=Math.max(bucket.candle.high,row.high);bucket.candle.low=Math.min(bucket.candle.low,row.low);bucket.candle.close=row.close;}
  }
  return [...buckets.values()].filter(b=>b.valid&&b.count===duration/60).map(b=>b.candle);
}

export function timeframeIndicators(candles:Candle[],config:BacktestSettings['bb_reversal']){
  return candles.map((row,index)=>{
    const bb=candles.slice(Math.max(0,index-config.bb_length+1),index+1).map(c=>c.close);
    const sma=candles.slice(Math.max(0,index-config.sma_length+1),index+1).map(c=>c.close);
    const basis=bb.length===config.bb_length?bb.reduce((a,b)=>a+b,0)/bb.length:null;
    const deviation=basis===null?null:Math.sqrt(bb.reduce((sum,c)=>sum+(c-basis)**2,0)/bb.length)*config.bb_mult;
    return {time:row.time,bbBasis:basis,bbUpper:basis===null?null:basis+deviation!,bbLower:basis===null?null:basis-deviation!,trendSma:config.use_sma_trend_adjustment&&sma.length===config.sma_length?sma.reduce((a,b)=>a+b,0)/sma.length:null};
  });
}

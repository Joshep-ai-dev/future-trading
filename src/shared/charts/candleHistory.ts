/** Newer snapshots replace matching candles; previously loaded history stays available. */
export function mergeHistory<T extends {time:number}>(saved:T[],incoming:T[]):T[]{
  const rows=new Map(saved.map(row=>[row.time,row]));
  for(const row of incoming)rows.set(row.time,row);
  return [...rows.values()].sort((a,b)=>a.time-b.time);
}


type PriceCandle={time:number;open:number;high:number;low:number;close:number;volume?:number};
/** Updating only the last candle is safe only when the older prefix is unchanged. */
export function canAppendCandles(previous:PriceCandle[],next:PriceCandle[]):boolean{
  if(!previous.length||next.length<previous.length)return false;
  if(next[previous.length-1]?.time!==previous[previous.length-1].time)return false;
  return previous.slice(0,-1).every((old,index)=>{
    const current=next[index];
    return old===current||(!!current&&old.time===current.time&&old.open===current.open&&old.high===current.high&&old.low===current.low&&old.close===current.close&&old.volume===current.volume);
  });
}

/** Newer snapshots replace matching candles; previously loaded history stays available. */
export function mergeHistory<T extends {time:number}>(saved:T[],incoming:T[]):T[]{
  const rows=new Map(saved.map(row=>[row.time,row]));
  for(const row of incoming)rows.set(row.time,row);
  return [...rows.values()].sort((a,b)=>a.time-b.time);
}

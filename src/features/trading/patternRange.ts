export type PatternCandle={time:number;close:number};

/** Freeze only completed candles inside the selected time boundaries. */
export function selectPatternRange(candles:readonly PatternCandle[],first:number,last:number,seconds:number,clock:number):PatternCandle[]{
  const left=Math.min(first,last),right=Math.max(first,last);
  const rows=candles.filter(row=>row.time>=left&&row.time<=right&&row.time+seconds<=clock).map(row=>({...row}));
  if(rows.length<8)throw new Error('Select at least 8 completed candles.');
  if(rows.length>2000)throw new Error('Select at most 2,000 candles. Zoom in to a smaller area.');
  if(rows.some(row=>!Number.isFinite(row.close)||row.close<=0))throw new Error('The selected range contains invalid prices.');
  if(rows.some((row,index)=>index>0&&row.time-rows[index-1].time!==seconds))throw new Error('The selected range contains missing candles. Choose an uninterrupted area.');
  return rows;
}

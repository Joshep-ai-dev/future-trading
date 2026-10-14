import type {IChartApi,UTCTimestamp} from 'lightweight-charts';

export function candleLogical(chart:IChartApi,time:number|undefined){
  if(time===undefined)return null;
  const scale=chart.timeScale(),x=scale.timeToCoordinate(time as UTCTimestamp);
  return x===null?null:scale.coordinateToLogical(x);
}

/** Keep fractional zoom and blank space, even when the oldest candles roll off. */
export function captureViewport(chart:IChartApi,anchor:number|undefined){
  return {range:chart.timeScale().getVisibleLogicalRange(),anchor,index:candleLogical(chart,anchor)};
}

export function restoreViewport(chart:IChartApi,saved:ReturnType<typeof captureViewport>,latest:number|undefined,follow:boolean){
  if(!saved.range)return;
  const index=candleLogical(chart,follow?latest:saved.anchor);
  const delta=index!==null&&saved.index!==null?index-saved.index:0;
  const range={from:saved.range.from+delta,to:saved.range.to+delta};
  const current=chart.timeScale().getVisibleLogicalRange();
  if(!current||Math.abs(current.from-range.from)>1e-7||Math.abs(current.to-range.to)>1e-7)
    chart.timeScale().setVisibleLogicalRange(range);
}

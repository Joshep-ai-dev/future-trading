import type {IChartApi,UTCTimestamp} from 'lightweight-charts';

export function candleLogical(chart:IChartApi,time:number|undefined){
  if(time===undefined)return null;
  const scale=chart.timeScale(),x=scale.timeToCoordinate(time as UTCTimestamp);
  return x===null?null:scale.coordinateToLogical(x);
}

/** Keep fractional zoom and blank space, even when the oldest candles roll off. */
export function captureViewport(chart:IChartApi,anchor:number|undefined){
  const scale=chart.timeScale();
  const visible=scale.getVisibleRange();
  const historyAnchor=typeof visible?.from==='number'?visible.from:anchor;
  const price=chart.priceScale('right');
  return {range:scale.getVisibleLogicalRange(),anchor,index:candleLogical(chart,anchor),
    historyAnchor,historyIndex:candleLogical(chart,historyAnchor),
    priceRange:price.options().autoScale?null:price.getVisibleRange()};
}

export function restoreViewport(chart:IChartApi,saved:ReturnType<typeof captureViewport>,latest:number|undefined,follow:boolean){
  if(!saved.range)return;
  const index=candleLogical(chart,follow?latest:saved.historyAnchor);
  const previousIndex=follow?saved.index:saved.historyIndex;
  const delta=index!==null&&previousIndex!==null?index-previousIndex:0;
  const range={from:saved.range.from+delta,to:saved.range.to+delta};
  const current=chart.timeScale().getVisibleLogicalRange();
  if(!current||Math.abs(current.from-range.from)>1e-7||Math.abs(current.to-range.to)>1e-7)
    chart.timeScale().setVisibleLogicalRange(range);
  if(saved.priceRange){
    const price=chart.priceScale('right');
    price.setAutoScale(false);
    price.setVisibleRange(saved.priceRange);
  }
}

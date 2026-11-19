type Bar={time:number;high:number;low:number;close:number};
export type ZigZagPoint={time:number;value:number};

/** High/low swing extremes; a closing-price reversal confirms each turn.
 * The final leg is provisional and follows new extremes until a reversal.
 */
export function chartZigZag(bars:readonly Bar[],deviation=5):ZigZagPoint[]{
  if(!Number.isFinite(deviation)||deviation<=0||deviation>100)throw new RangeError('Deviation must be greater than 0 and at most 100');
  if(!bars.length)return [];
  const fraction=deviation/100;
  let high={time:bars[0].time,value:bars[0].high},low={time:bars[0].time,value:bars[0].low};
  let direction=0;
  const pivots:ZigZagPoint[]=[];
  for(const bar of bars){
    if(direction===0){
      if(bar.high>high.value)high={time:bar.time,value:bar.high};
      if(bar.low<low.value)low={time:bar.time,value:bar.low};
      if(bar.time>low.time&&bar.close>=low.value*(1+fraction)){
        pivots.push(low);
        high=bars.filter(row=>row.time>low.time&&row.time<=bar.time).reduce((peak,row)=>row.high>peak.value?{time:row.time,value:row.high}:peak,{time:bar.time,value:bar.high});
        direction=1;
      }else if(bar.time>high.time&&bar.close<=high.value*(1-fraction)){
        pivots.push(high);
        low=bars.filter(row=>row.time>high.time&&row.time<=bar.time).reduce((trough,row)=>row.low<trough.value?{time:row.time,value:row.low}:trough,{time:bar.time,value:bar.low});
        direction=-1;
      }
    }else if(direction===1){
      if(bar.high>high.value)high={time:bar.time,value:bar.high};
      if(bar.time>high.time&&bar.close<=high.value*(1-fraction)){
        pivots.push(high);low={time:bar.time,value:bar.low};direction=-1;
      }
    }else{
      if(bar.low<low.value)low={time:bar.time,value:bar.low};
      if(bar.time>low.time&&bar.close>=low.value*(1+fraction)){
        pivots.push(low);high={time:bar.time,value:bar.high};direction=1;
      }
    }
  }
  if(direction!==0)pivots.push(direction===1?high:low);
  return pivots;
}

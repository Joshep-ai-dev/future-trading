import {priceSource,type PriceSource} from './bollingerBands';

export const VWAP_ANCHORS=['Session','Week','Month'] as const;
export type VwapAnchor=typeof VWAP_ANCHORS[number];
export type VwapConfig={anchor:VwapAnchor;source:PriceSource;bandMultiplier:number};
export type VwapPoint={time:number;vwap:number|null;upper:number|null;lower:number|null;anchored:boolean};

/** Start (UTC seconds) of the anchor period containing `time`: UTC day, ISO week (Monday) or month. */
export function anchorStart(time:number,anchor:VwapAnchor):number{
  const date=new Date(time*1000);
  const day=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate())/1000;
  if(anchor==='Session')return day;
  if(anchor==='Week')return day-((date.getUTCDay()+6)%7)*86400;
  return Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1)/1000;
}

/**
 * TradingView VWAP: volume-weighted average of the source since the anchor period began, with
 * bands at ± multiplier × the volume-weighted standard deviation. Bars without volume add nothing;
 * a period with no volume yet has no value. `anchored` marks the first bar of each period.
 */
export function chartVwap(candles:readonly {time:number;open:number;high:number;low:number;close:number;volume?:number|null}[],config:VwapConfig):VwapPoint[]{
  let period:number|null=null,volume=0,weighted=0,weightedSquares=0;
  return candles.map(candle=>{
    const start=anchorStart(candle.time,config.anchor);
    const anchored=start!==period;
    if(anchored){period=start;volume=weighted=weightedSquares=0;}
    const size=candle.volume!=null&&Number.isFinite(candle.volume)&&candle.volume>0?candle.volume:0;
    const price=priceSource(candle,config.source);
    volume+=size;weighted+=size*price;weightedSquares+=size*price*price;
    if(volume<=0)return {time:candle.time,vwap:null,upper:null,lower:null,anchored};
    const vwap=weighted/volume;
    const deviation=Math.sqrt(Math.max(0,weightedSquares/volume-vwap*vwap))*config.bandMultiplier;
    return {time:candle.time,vwap,upper:vwap+deviation,lower:vwap-deviation,anchored};
  });
}

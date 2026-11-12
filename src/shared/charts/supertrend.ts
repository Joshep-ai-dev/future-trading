import type {Candle} from '../../features/trading/replayAnimation';

export type SupertrendPoint={time:number;value:number|null;direction:'up'|'down'|null;pineDirection:1|-1;bodyMiddle:number|null;change:'up'|'down'|null};

/** Pine ta.supertrend(factor, atrPeriod), followed by the supplied plot mask.
 * ATR uses SMA-seeded RMA of true range. Elapsed-time gaps do not reset Pine
 * series: the next available bar includes the previous close in true range.
 * Recalculate from history on each update, including the current realtime bar.
 */
export function chartSupertrend(candles:Candle[],duration:number,length=10,multiplier=3):SupertrendPoint[]{
  if(!Number.isInteger(length)||length<1||length>1000||!Number.isFinite(multiplier)||multiplier<.01||multiplier>100||!Number.isFinite(duration)||duration<=0){
    throw new Error('Invalid Supertrend period, multiplier or candle duration');
  }
  let previous:Candle|undefined,count=0,sum=0,atr=NaN,previousAtr=NaN,upper=NaN,lower=NaN,supertrend=NaN;
  let pineDirection:1|-1=1;
  return candles.map((candle,index)=>{
    if(![candle.time,candle.open,candle.high,candle.low,candle.close].every(Number.isFinite)||candle.low>candle.high||candle.close<candle.low||candle.close>candle.high){
      previous=undefined;count=0;sum=0;atr=previousAtr=upper=lower=supertrend=NaN;pineDirection=1;
      return {time:candle.time,value:null,direction:null,pineDirection,bodyMiddle:null,change:null};
    }
    const oldDirection=pineDirection;
    const range=previous?Math.max(candle.high-candle.low,Math.abs(candle.high-previous.close),Math.abs(candle.low-previous.close)):candle.high-candle.low;
    if(Number.isNaN(atr)){sum+=range;count++;if(count===length)atr=sum/length;}
    else atr=(atr*(length-1)+range)/length;
    const midpoint=(candle.high+candle.low)/2;
    const basicUpper=midpoint+multiplier*atr,basicLower=midpoint-multiplier*atr;
    const previousUpper=Number.isNaN(upper)?0:upper,previousLower=Number.isNaN(lower)?0:lower;
    const previousSupertrend=supertrend,previousClose=previous?.close??NaN;
    upper=basicUpper<previousUpper||previousClose>previousUpper?basicUpper:previousUpper;
    lower=basicLower>previousLower||previousClose<previousLower?basicLower:previousLower;
    if(Number.isNaN(previousAtr))pineDirection=1;
    else if(previousSupertrend===previousUpper)pineDirection=candle.close>upper?-1:1;
    else pineDirection=candle.close<lower?1:-1;
    supertrend=pineDirection===-1?lower:upper;
    previous=candle;previousAtr=atr;
    const value=index===0||!Number.isFinite(atr)||!Number.isFinite(supertrend)?null:supertrend;
    return {time:candle.time,value,direction:value===null?null:pineDirection<0?'up':'down',pineDirection,
      bodyMiddle:index===0?null:(candle.open+candle.close)/2,
      change:index>0&&oldDirection!==pineDirection?(pineDirection<0?'up':'down'):null};
  });
}

/** plot.style_linebr and fillgaps=false: never bridge an opposite or na plot. */
export function supertrendSegments(points:SupertrendPoint[]):SupertrendPoint[][]{
  const segments:SupertrendPoint[][]=[];
  let previous:SupertrendPoint|undefined;
  for(const point of points){
    if(point.value===null||point.bodyMiddle===null||point.direction===null){previous=undefined;continue;}
    if(!previous||previous.direction!==point.direction)segments.push([]);
    segments[segments.length-1].push(point);previous=point;
  }
  return segments;
}

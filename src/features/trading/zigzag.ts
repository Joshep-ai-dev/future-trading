import type {PatternCandle} from './patternRange';

export type SwingPoint={index:number;value:number;high:boolean;confirmedAt:number|null;threshold:number;seed?:boolean};
export type ZigZagOptions={atrPeriod?:number;reversalAtr?:number;minReversalPct?:number};
export type ZigZagResult={pivots:SwingPoint[];provisional:SwingPoint|null;atr:number[];reversalAtr:number};

/** Causal Wilder ATR: use the available prefix as the seed until a full period.
 * Each reversal uses the preceding bar's ATR. A pivot is committed only after
 * a later candle CLOSE reverses sufficiently; same-bar OHLC order is unknown.
 * Confirmed pivots never move when subsequent bars are appended.
 */
export function detectZigZag(rows:readonly PatternCandle[],{atrPeriod=14,reversalAtr=1.5,minReversalPct=.05}:ZigZagOptions={}):ZigZagResult{
  if(!Number.isInteger(atrPeriod)||atrPeriod<2||!Number.isFinite(reversalAtr)||reversalAtr<=0||!Number.isFinite(minReversalPct)||minReversalPct<0)throw new Error('Invalid ZigZag settings.');
  const empty={pivots:[],provisional:null,atr:[],reversalAtr};
  if(!rows.length||rows.some((row,index)=>!Number.isFinite(row.time)||!Number.isFinite(row.high)||!Number.isFinite(row.low)||!Number.isFinite(row.close)||row.low!<=0||row.low!>row.close||row.high!<row.close||(index>0&&row.time<=rows[index-1].time)))return empty;
  const atr:number[]=[];let sum=0;
  rows.forEach((row,index)=>{
    const previous=index?rows[index-1].close:row.close;
    const tr=Math.max(row.high!-row.low!,Math.abs(row.high!-previous),Math.abs(row.low!-previous));
    sum+=tr;
    atr.push(index<atrPeriod?sum/(index+1):(atr[index-1]*(atrPeriod-1)+tr)/atrPeriod);
  });
  const threshold=(index:number,value:number)=>Math.max(atr[Math.max(0,index-1)]*reversalAtr,Math.abs(value)*minReversalPct/100,Number.EPSILON);
  const pivots:SwingPoint[]=[];
  let high:SwingPoint={index:0,value:rows[0].high!,high:true,confirmedAt:null,threshold:0};
  let low:SwingPoint={index:0,value:rows[0].low!,high:false,confirmedAt:null,threshold:0};
  let direction=0,extreme:SwingPoint|null=null;
  for(let i=1;i<rows.length;i++){
    const row=rows[i];
    if(direction===0){
      if(row.high!>high.value)high={...high,index:i,value:row.high!};
      if(row.low!<low.value)low={...low,index:i,value:row.low!};
      const up=low.index<i&&row.close-low.value>=threshold(i,low.value);
      const down=high.index<i&&high.value-row.close>=threshold(i,high.value);
      if(up&&(!down||row.close>=rows[i-1].close)){
        pivots.push({...low,confirmedAt:i,threshold:threshold(i,low.value),seed:true});direction=1;
        extreme={index:i,value:row.high!,high:true,confirmedAt:null,threshold:threshold(i,row.high!)};
      }else if(down){
        pivots.push({...high,confirmedAt:i,threshold:threshold(i,high.value),seed:true});direction=-1;
        extreme={index:i,value:row.low!,high:false,confirmedAt:null,threshold:threshold(i,row.low!)};
      }
      continue;
    }
    if(!extreme)continue;
    const value=direction===1?row.high!:row.low!;
    if(direction===1?value>extreme.value:value<extreme.value)extreme={index:i,value,high:direction===1,confirmedAt:null,threshold:extreme.threshold};
    const reversal=threshold(i,extreme.value);
    if(extreme.index<i&&(direction===1?extreme.value-row.close:row.close-extreme.value)>=reversal){
      pivots.push({...extreme,confirmedAt:i,threshold:reversal});direction=-direction;
      extreme={index:i,value:direction===1?row.high!:row.low!,high:direction===1,confirmedAt:null,threshold:reversal};
    }else extreme={...extreme,threshold:reversal};
  }
  return {pivots,provisional:extreme,atr,reversalAtr};
}

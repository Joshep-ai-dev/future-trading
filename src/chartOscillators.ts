import type {Candle} from './replayAnimation';

function wilder(length:number){
  let count=0,sum=0,value:number|null=null;
  return (next:number|null)=>{
    if(next===null)return null;
    if(value===null){sum+=next;count++;if(count===length)value=sum/length;}
    else value=(value*(length-1)+next)/length;
    return value;
  };
}

/** Wilder ATR and DMI/ADX, with the same warmup and gap resets as the bot. */
export function chartOscillators(candles:Candle[],duration:number,atrLength:number,adxLength:number,atrSmoothing:'RMA'|'SMA'|'EMA'|'WMA'='RMA'){
  let atr=wilder(atrLength),tr=wilder(adxLength),plus=wilder(adxLength),minus=wilder(adxLength),adx=wilder(adxLength);
  let previous:Candle|undefined,previousPlus:number|null=null,previousMinus:number|null=null;
  let ranges:number[]=[],ema:number|null=null;
  return candles.map(c=>{
    if(previous&&c.time-previous.time>duration){atr=wilder(atrLength);tr=wilder(adxLength);plus=wilder(adxLength);minus=wilder(adxLength);adx=wilder(adxLength);previous=undefined;previousPlus=previousMinus=null;ranges=[];ema=null;}
    const range=previous?Math.max(c.high-c.low,Math.abs(c.high-previous.close),Math.abs(c.low-previous.close)):c.high-c.low;
    ranges.push(range);if(ranges.length>atrLength)ranges.shift();
    ema=ema===null?range:ema+2/(atrLength+1)*(range-ema);
    const average=atrSmoothing==='WMA'?ranges.reduce((sum,v,i)=>sum+v*(i+1),0)/(atrLength*(atrLength+1)/2):ranges.reduce((sum,v)=>sum+v,0)/atrLength;
    const atrValue=atrSmoothing==='RMA'?atr(range):atrSmoothing==='EMA'?ema:ranges.length===atrLength?average:null;
    const up=previous?c.high-previous.high:0,down=previous?previous.low-c.low:0;
    const smoothTr=tr(previous?range:null),p=plus(previous?(up>down&&up>0?up:0):null),m=minus(previous?(down>up&&down>0?down:0):null);
    const pdi=smoothTr&&p!==null?100*p/smoothTr:previousPlus;
    const mdi=smoothTr&&m!==null?100*m/smoothTr:previousMinus;
    previousPlus=pdi;previousMinus=mdi;
    const dx=pdi===null||mdi===null?null:100*Math.abs(pdi-mdi)/((pdi+mdi)||1);
    const adxValue=adx(dx);previous=c;
    return {time:c.time,atr:atrValue,adx:adxValue};
  });
}

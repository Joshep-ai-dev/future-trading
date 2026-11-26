import {priceSource,type PriceSource} from './bollingerBands';

export type MacdMa='EMA'|'SMA';
export type MacdConfig={fast:number;slow:number;signal:number;source:PriceSource;oscillatorMa:MacdMa;signalMa:MacdMa};
export type MacdPoint={time:number;macd:number|null;signal:number|null;histogram:number|null};

/**
 * Pine ta.sma / ta.ema over a series that may start with gaps (null): the average starts at the
 * first `length` consecutive values, and an EMA is seeded with their SMA like ta.ema.
 */
function movingAverage(values:readonly (number|null)[],length:number,type:MacdMa):(number|null)[]{
  const out:(number|null)[]=new Array(values.length).fill(null);
  const window:number[]=[];
  let sum=0,ema:number|null=null;
  const k=2/(length+1);
  values.forEach((value,index)=>{
    if(value===null){window.length=0;sum=0;ema=null;return;}
    if(type==='EMA'&&ema!==null){ema+=k*(value-ema);out[index]=ema;return;}
    window.push(value);sum+=value;
    if(window.length>length)sum-=window.shift()!;
    if(window.length<length)return;
    out[index]=sum/length;
    if(type==='EMA')ema=sum/length;
  });
  return out;
}

/** TradingView MACD: fast MA - slow MA of the source, a signal MA of that line, and their difference. */
export function chartMacd(candles:readonly {time:number;open:number;high:number;low:number;close:number}[],config:MacdConfig):MacdPoint[]{
  const source=candles.map(candle=>priceSource(candle,config.source));
  const fast=movingAverage(source,config.fast,config.oscillatorMa);
  const slow=movingAverage(source,config.slow,config.oscillatorMa);
  const macd=source.map((_,index)=>fast[index]===null||slow[index]===null?null:fast[index]!-slow[index]!);
  const signal=movingAverage(macd,config.signal,config.signalMa);
  return candles.map((candle,index)=>({time:candle.time,macd:macd[index],signal:signal[index],
    histogram:macd[index]===null||signal[index]===null?null:macd[index]!-signal[index]!}));
}

/** TradingView histogram colors: grow/fall above or below zero, relative to the previous bar. */
export function macdHistogramColor(value:number,previous:number|null,colors:{growAbove:string;fallAbove:string;growBelow:string;fallBelow:string}){
  const rising=previous===null||value>=previous;
  return value>=0?(rising?colors.growAbove:colors.fallAbove):(rising?colors.growBelow:colors.fallBelow);
}

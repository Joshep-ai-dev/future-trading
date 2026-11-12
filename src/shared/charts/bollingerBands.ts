import type {Candle} from '../../features/trading/replayAnimation';

export const BB_MA_TYPES=['SMA','EMA','SMMA (RMA)','WMA','VWMA'] as const;
export const BB_SOURCES=['close','open','high','low','hl2','hlc3','ohlc4','hlcc4'] as const;
export type BollingerConfig={length:number;maType:typeof BB_MA_TYPES[number];source:typeof BB_SOURCES[number];multiplier:number;offset:number};
export type BollingerPoint={time:number;basis:number|null;upper:number|null;lower:number|null};
export const defaultBollinger:BollingerConfig={length:20,maType:'SMA',source:'close',multiplier:2,offset:0};

export function validBollinger(config:BollingerConfig):boolean{
  return Number.isSafeInteger(config.length)&&config.length>=1&&BB_MA_TYPES.includes(config.maType)&&BB_SOURCES.includes(config.source)
    &&Number.isFinite(config.multiplier)&&config.multiplier>=.001&&config.multiplier<=50
    &&Number.isInteger(config.offset)&&config.offset>=-500&&config.offset<=500;
}

/** Pine basis MA plus ta.stdev(source,length), using population variance (N).
 * The deviation always uses the source mean, even for an EMA/VWMA basis.
 * Offset is a display shift in bars and never changes the calculated values.
 */
export function chartBollingerBands(candles:Candle[],config:BollingerConfig=defaultBollinger):BollingerPoint[]{
  if(!validBollinger(config))throw new Error('Invalid Bollinger Bands inputs');
  const {length,source,maType,multiplier}=config;
  const ring:{value:number;volume:number|null}[]=[];
  const volumeRing:{value:number;volume:number}[]=[];
  let volumeCursor=0,positiveVolumes=0;
  let cursor=0,count=0,mean=0,m2=0,sum=0,weighted=0,volumeSum=0,volumePriceSum=0,volumeCount=0;
  let ema:number|null=null,rma:number|null=null;
  return candles.map(candle=>{
    const value=source==='hl2'?(candle.high+candle.low)/2:source==='hlc3'?(candle.high+candle.low+candle.close)/3:
      source==='ohlc4'?(candle.open+candle.high+candle.low+candle.close)/4:source==='hlcc4'?(candle.high+candle.low+2*candle.close)/4:candle[source];
    if(!Number.isFinite(value))return {time:candle.time,basis:null,upper:null,lower:null};
    const full=count===length;
    if(full){
      const old=ring[cursor];
      weighted-=sum;sum-=old.value;
      if(count===1){mean=0;m2=0;}
      else{
        const nextMean=mean+(mean-old.value)/(count-1);
        m2-=(old.value-mean)*(old.value-nextMean);mean=nextMean;
      }
      count--;
    }
    count++;
    const delta=value-mean;mean+=delta/count;m2+=delta*(value-mean);
    sum+=value;weighted+=value*count;
    const volume=candle.volume!==undefined&&Number.isFinite(candle.volume)&&candle.volume>=0?candle.volume:null;
    if(volume!==null){
      if(volumeCount===length){
        const old=volumeRing[volumeCursor];volumeSum-=old.volume;volumePriceSum-=old.value*old.volume;
        if(old.volume>0)positiveVolumes--;
      }else volumeCount++;
      volumeSum+=volume;volumePriceSum+=value*volume;if(volume>0)positiveVolumes++;
      volumeRing[volumeCursor]={value,volume};volumeCursor=(volumeCursor+1)%length;
      if(positiveVolumes===0){volumeSum=0;volumePriceSum=0;}
    }
    ring[cursor]={value,volume};cursor=(cursor+1)%length;
    ema=ema===null?value:ema+2/(length+1)*(value-ema);
    if(rma!==null)rma=(rma*(length-1)+value)/length;
    else if(count===length)rma=mean;
    let basis:number|null=maType==='EMA'?ema:maType==='SMMA (RMA)'?rma:null;
    if(count===length){
      if(maType==='SMA')basis=mean;
      else if(maType==='WMA')basis=weighted/(length*(length+1)/2);
      else if(maType==='VWMA')basis=volumeCount===length&&volumeSum>0?volumePriceSum/volumeSum:null;
    }
    const deviation=count===length?multiplier*Math.sqrt(Math.max(0,m2)/length):null;
    return {time:candle.time,basis,upper:basis!==null&&deviation!==null?basis+deviation:null,
      lower:basis!==null&&deviation!==null?basis-deviation:null};
  });
}

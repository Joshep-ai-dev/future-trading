import {CHART_TIME_ZONES,readChartTimeZone,useChartTimeZone,type ChartTimeZone} from './chartTimeZone';

// Chart labels and trade timestamps intentionally share one account preference.
export const TRADING_TIME_ZONES=CHART_TIME_ZONES;
export type TradingTimeZone=ChartTimeZone;
export const readTradingTimeZone=readChartTimeZone;
export const useTradingTimeZone=useChartTimeZone;

export function formatTradingTime(epochSeconds:number,timeZone:TradingTimeZone=readChartTimeZone()){
  const parts=new Intl.DateTimeFormat('en-GB',{
    timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',
    hourCycle:'h23',timeZoneName:'short',
  }).formatToParts(new Date(epochSeconds*1000));
  const part=(type:Intl.DateTimeFormatPartTypes)=>parts.find(value=>value.type===type)?.value??'';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')} ${part('timeZoneName')}`;
}

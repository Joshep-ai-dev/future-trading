import type {Position,PaperTrade} from './PaperTrading';

export const TIMEFRAMES={'1m':60,'3m':180,'5m':300,'10m':600,'15m':900,'30m':1800,'1h':3600,'4h':14400,'1d':86400};
export function chartPosition<T extends Position>(position:T,execution:number,duration:number):T{
  const bucket=(time:number)=>Math.floor((time+execution-1)/duration)*duration;
  const history=new Map<number,NonNullable<Position['stop_history']>[number]>();
  for(const point of position.stop_history??[]){const time=bucket(point.time);history.set(time,{...point,time});}
  return {...position,entry_time:bucket(position.entry_time),...('exit_time' in position?{exit_time:bucket((position as unknown as PaperTrade).exit_time)}:{}),stop_history:position.stop_history?[...history.values()]:undefined};
}

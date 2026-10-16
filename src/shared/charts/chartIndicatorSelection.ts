import {useSyncExternalStore} from 'react';

export type ChartIndicatorSelection={atr:boolean;adx:boolean;rsi:boolean};
type IndicatorKey=keyof ChartIndicatorSelection;
const key='silver.chart.oscillators';
const changed='silver:chart-oscillators-changed';
const defaults:ChartIndicatorSelection={atr:false,adx:false,rsi:false};
let current:ChartIndicatorSelection|null=null;

function read():ChartIndicatorSelection{
  if(current)return current;
  try{const saved=JSON.parse(localStorage.getItem(key)??'{}');current={atr:saved.atr===true,adx:saved.adx===true,rsi:saved.rsi===true};}
  catch{current={atr:false,adx:false,rsi:false};}
  return current;
}
function subscribe(listener:()=>void){
  if(typeof window==='undefined')return ()=>{};
  const storage=(event:StorageEvent)=>{if(event.key!==key&&event.key!==null)return;current=null;listener();};
  window.addEventListener(changed,listener);window.addEventListener('storage',storage);
  return ()=>{window.removeEventListener(changed,listener);window.removeEventListener('storage',storage);};
}
export function useChartIndicatorSelection(){return useSyncExternalStore(subscribe,read,()=>defaults);}
export function toggleChartIndicator(keyToToggle:IndicatorKey){
  const previous=read(),next={...previous,[keyToToggle]:!previous[keyToToggle]};current=next;
  try{localStorage.setItem(key,JSON.stringify(next));}catch{/* Keep the selection for the current session. */}
  if(typeof window!=='undefined')window.dispatchEvent(new Event(changed));
}

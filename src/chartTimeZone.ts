import {TickMarkType,type Time,type TimeScaleOptions,type LocalizationOptions} from 'lightweight-charts';
import {useSyncExternalStore} from 'react';

export const CHART_TIME_ZONES=[
  {value:'UTC',label:'UTC'},
  {value:'Asia/Shanghai',label:'Shanghai · UTC+8'},
  {value:'Asia/Tokyo',label:'Tokyo'},
  {value:'Asia/Singapore',label:'Singapore'},
  {value:'Europe/London',label:'London'},
  {value:'America/New_York',label:'New York'},
] as const;
export type ChartTimeZone=typeof CHART_TIME_ZONES[number]['value'];
const storageKey='silver.display.timeZone';
const changedEvent='silver:chart-timezone-changed';
let activeTimeZone:ChartTimeZone|null=null;

export function readChartTimeZone():ChartTimeZone{
  if(activeTimeZone)return activeTimeZone;
  try{const saved=(localStorage.getItem(storageKey)??localStorage.getItem('silver.chart.timeZone')??localStorage.getItem('silver.trading.timeZone')) as ChartTimeZone|null;activeTimeZone=CHART_TIME_ZONES.some(zone=>zone.value===saved)?saved!:'UTC';}
  catch{activeTimeZone='UTC';}
  return activeTimeZone;
}

export function saveChartTimeZone(value:ChartTimeZone){
  activeTimeZone=value;
  try{localStorage.setItem(storageKey,value);}catch{/* Keep chart controls usable when storage is unavailable. */}
  if(typeof window!=='undefined')window.dispatchEvent(new Event(changedEvent));
}

function subscribe(listener:()=>void){
  if(typeof window==='undefined')return ()=>{};
  const changed=()=>listener();
  const storage=(event:StorageEvent)=>{if(event.key!==storageKey&&event.key!==null)return;activeTimeZone=null;listener();};
  window.addEventListener(changedEvent,changed);
  window.addEventListener('storage',storage);
  return ()=>{window.removeEventListener(changedEvent,changed);window.removeEventListener('storage',storage);};
}

export function useChartTimeZone(){
  return useSyncExternalStore(subscribe,readChartTimeZone,()=> 'UTC');
}

function timestamp(time:Time):number{
  if(typeof time==='number')return time;
  if(typeof time==='string')return Date.parse(`${time}T00:00:00Z`)/1000;
  return Date.UTC(time.year,time.month-1,time.day)/1000;
}

function zone(value:ChartTimeZone):string{return value;}

export function formatChartTime(time:Time,value:ChartTimeZone,locale?:string){
  return new Intl.DateTimeFormat(locale,{timeZone:zone(value),year:'numeric',month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZoneName:'short'}).format(new Date(timestamp(time)*1000));
}

export function chartTimeOptions(value:ChartTimeZone):{timeScale:Pick<TimeScaleOptions,'tickMarkFormatter'>;localization:Pick<LocalizationOptions<Time>,'timeFormatter'>}{
  return {
    timeScale:{tickMarkFormatter:(time,type,locale)=>{
      const date=new Date(timestamp(time)*1000),timeZone=zone(value);
      const options:Intl.DateTimeFormatOptions=type===TickMarkType.Year?{year:'numeric'}:
        type===TickMarkType.Month?{month:'short'}:
        type===TickMarkType.DayOfMonth?{month:'short',day:'numeric'}:
        {hour:'2-digit',minute:'2-digit',...(type===TickMarkType.TimeWithSeconds?{second:'2-digit'}:{}),hourCycle:'h23'};
      return new Intl.DateTimeFormat(locale,{...options,timeZone}).format(date);
    }},
    localization:{timeFormatter:time=>formatChartTime(time,value)},
  };
}

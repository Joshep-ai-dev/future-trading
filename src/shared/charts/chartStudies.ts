import {useSyncExternalStore} from 'react';
import {normalizeIndicatorConfig,readIndicatorSettings,type IndicatorConfig,type IndicatorKind,type OverlayKind,type SettingsKind} from './IndicatorSettings';

/** Indicators a chart can show; each can be added any number of times. */
export type StudyKind='ma'|OverlayKind|IndicatorKind;
export type ChartStudy={id:string;kind:StudyKind;config:IndicatorConfig;hidden:boolean};

export const STUDY_KINDS:readonly StudyKind[]=['ma','triplema','bollinger','supertrend','zigzag','rsi','adx','atr'];
export const PANE_KINDS:readonly IndicatorKind[]=['rsi','adx','atr'];
export const isPaneStudy=(kind:StudyKind):kind is IndicatorKind=>(PANE_KINDS as readonly string[]).includes(kind);
export const settingsKind=(kind:StudyKind):SettingsKind=>kind==='ma'?'trendsma':kind;

const storageKey='silver.chart.studies.v1';
const legacyKey='silver.chart.oscillators';
const changed='silver:chart-studies-changed';
const EMPTY:ChartStudy[]=[];
let current:ChartStudy[]|null=null;
let counter=0;
const newId=()=>`s${Date.now().toString(36)}${(counter++).toString(36)}`;

/** One instance per indicator that was switched on in the old on/off selection. */
function migrate():ChartStudy[]{
  const config=readIndicatorSettings();
  try{
    const raw=localStorage.getItem(legacyKey);
    if(raw){
      const old=JSON.parse(raw) as Record<string,unknown>;
      return (['triplema','bollinger','supertrend','rsi','adx','atr'] as const)
        .filter(kind=>kind==='bollinger'?old.bollinger!==false:old[kind]===true)
        .map(kind=>({id:newId(),kind,config,hidden:false}));
    }
  }catch{/* Fall back to the default study. */}
  return [{id:newId(),kind:'bollinger',config,hidden:false}];
}
function read():ChartStudy[]{
  if(current)return current;
  try{
    const raw=localStorage.getItem(storageKey);
    if(raw!==null){
      const parsed=JSON.parse(raw);
      if(Array.isArray(parsed)){
        current=parsed
          .filter(item=>item&&typeof item.id==='string'&&STUDY_KINDS.includes(item.kind))
          .map(item=>({id:item.id,kind:item.kind,config:normalizeIndicatorConfig(item.config),hidden:item.hidden===true}));
        return current;
      }
    }
  }catch{/* Rebuild below. */}
  current=migrate();
  try{localStorage.setItem(storageKey,JSON.stringify(current));}catch{/* Session only. */}
  return current;
}
function save(next:ChartStudy[]){
  current=next;
  try{localStorage.setItem(storageKey,JSON.stringify(next));}catch{/* Keep the list for this session. */}
  if(typeof window!=='undefined')window.dispatchEvent(new Event(changed));
}
function subscribe(listener:()=>void){
  if(typeof window==='undefined')return ()=>{};
  const storage=(event:StorageEvent)=>{if(event.key!==storageKey&&event.key!==null)return;current=null;listener();};
  window.addEventListener(changed,listener);window.addEventListener('storage',storage);
  return ()=>{window.removeEventListener(changed,listener);window.removeEventListener('storage',storage);};
}

export function useChartStudies(){return useSyncExternalStore(subscribe,read,()=>EMPTY);}
export function addChartStudy(kind:StudyKind){save([...read(),{id:newId(),kind,config:readIndicatorSettings(),hidden:false}]);}
export function removeChartStudy(id:string){save(read().filter(study=>study.id!==id));}
export function updateChartStudy(id:string,patch:Partial<Pick<ChartStudy,'config'|'hidden'>>){
  save(read().map(study=>study.id===id?{...study,...patch}:study));
}

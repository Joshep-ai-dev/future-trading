import {BB_MA_TYPES,BB_SOURCES,defaultBollinger,validBollinger,type BollingerConfig} from './bollingerBands';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';

export type IndicatorKind='atr'|'adx'|'rsi';
export type OverlayKind='supertrend'|'bollinger'|'triplema';
/** Settings dialogs: chart indicators plus the strategy's Trend SMA line. */
export type SettingsKind=IndicatorKind|OverlayKind|'trendsma';

export type IndicatorStyle={
  bbBasisColor:string;bbUpperColor:string;bbLowerColor:string;bbWidth:number;
  stUpColor:string;stDownColor:string;stWidth:number;
  maFastColor:string;maMidColor:string;maSlowColor:string;maWidth:number;
  rsiColor:string;rsiWidth:number;
  atrColor:string;atrWidth:number;
  adxWidth:number;
  adxWeakColor:string;adxTrendColor:string;adxStrongColor:string;
  diPlusColor:string;diMinusColor:string;adxBullBgColor:string;adxBearBgColor:string;
  trendSmaColor:string;trendSmaWidth:number;
};
export type IndicatorConfig=IndicatorStyle&{bbLength:number;bbMaType:BollingerConfig['maType'];bbSource:BollingerConfig['source'];bbMultiplier:number;bbOffset:number;supertrendLength:number;supertrendMultiplier:number;atrLength:number;atrThreshold:number;atrSmoothing:'RMA'|'SMA'|'EMA'|'WMA';adxLength:number;diLength:number;showDi:boolean;showStatus:boolean;adxTrendLevel:number;adxStrongLevel:number;showAdxLevels:boolean;rsiLength:number;rsiUpper:number;rsiLower:number;maFast:number;maMid:number;maSlow:number;maType:'SMA'|'EMA';trendSmaLength:number};

/** TradingView built-in defaults (inputs and plot colors). */
const defaultStyle:IndicatorStyle={
  bbBasisColor:'#2962ff',bbUpperColor:'#f23645',bbLowerColor:'#089981',bbWidth:1,
  stUpColor:'#4caf50',stDownColor:'#f23645',stWidth:1,
  maFastColor:'#00ff00',maMidColor:'#ff0000',maSlowColor:'#ffff00',maWidth:2,
  rsiColor:'#7e57c2',rsiWidth:1,
  atrColor:'#b71c1c',atrWidth:1,
  adxWidth:2,
  adxWeakColor:'#787b86',adxTrendColor:'#ff9800',adxStrongColor:'#4caf50',
  diPlusColor:'#00e676',diMinusColor:'#f23645',adxBullBgColor:'#4caf50',adxBearBgColor:'#f23645',
  trendSmaColor:'#ff9800',trendSmaWidth:1,
};
export const defaultIndicators:IndicatorConfig={...defaultStyle,bbLength:defaultBollinger.length,bbMaType:defaultBollinger.maType,bbSource:defaultBollinger.source,bbMultiplier:defaultBollinger.multiplier,bbOffset:defaultBollinger.offset,supertrendLength:10,supertrendMultiplier:3,atrLength:14,atrThreshold:0.03,atrSmoothing:'RMA',adxLength:14,diLength:14,showDi:false,showStatus:true,adxTrendLevel:25,adxStrongLevel:50,showAdxLevels:true,rsiLength:14,rsiUpper:70,rsiLower:30,maFast:20,maMid:50,maSlow:100,maType:'SMA',trendSmaLength:30};

const COLOR_KEYS=Object.keys(defaultStyle).filter(key=>key.endsWith('Color')) as (keyof IndicatorStyle)[];
const WIDTH_KEYS=Object.keys(defaultStyle).filter(key=>key.endsWith('Width')) as (keyof IndicatorStyle)[];
const settingsChanged='silver:chart-indicator-settings-changed';
const storageKey='silver.chart.indicatorSettings';

function validInputs(c:IndicatorConfig){
  return validBollinger({length:c.bbLength,maType:c.bbMaType,source:c.bbSource,multiplier:c.bbMultiplier,offset:c.bbOffset})
    &&Number.isFinite(c.supertrendMultiplier)&&c.supertrendMultiplier>=.01&&c.supertrendMultiplier<=100
    &&Number.isFinite(c.atrThreshold)&&c.atrThreshold>=0
    &&[c.atrLength,c.adxLength,c.diLength,c.rsiLength,c.supertrendLength,c.maFast,c.maMid,c.maSlow,c.trendSmaLength].every(v=>Number.isInteger(v)&&v>=1&&v<=1000)
    &&typeof c.showDi==='boolean'&&typeof c.showAdxLevels==='boolean'
    &&[c.adxTrendLevel,c.adxStrongLevel].every(v=>Number.isFinite(v)&&v>=0&&v<=100)&&c.adxTrendLevel<c.adxStrongLevel
    &&['RMA','SMA','EMA','WMA'].includes(c.atrSmoothing)&&typeof c.showStatus==='boolean'
    &&[c.rsiUpper,c.rsiLower].every(v=>Number.isFinite(v)&&v>=0&&v<=100)&&c.rsiLower<c.rsiUpper
    &&['SMA','EMA'].includes(c.maType);
}
/** Bad style values fall back one by one; bad inputs reset everything, as before. */
function sanitizeStyle(c:IndicatorConfig):IndicatorConfig{
  const next={...c} as Record<string,unknown>;
  for(const key of COLOR_KEYS)if(typeof next[key]!=='string'||!/^#[0-9a-f]{6}$/i.test(next[key] as string))next[key]=defaultStyle[key];
  for(const key of WIDTH_KEYS)if(!Number.isInteger(next[key])||(next[key] as number)<1||(next[key] as number)>4)next[key]=defaultStyle[key];
  return next as IndicatorConfig;
}
/** Validate a stored per-indicator config, falling back to defaults like the saved settings do. */
export function normalizeIndicatorConfig(raw:unknown):IndicatorConfig{
  try{
    const c=sanitizeStyle({...defaultIndicators,...(raw&&typeof raw==='object'?raw:{})} as IndicatorConfig);
    return validInputs(c)?c:defaultIndicators;
  }catch{return defaultIndicators;}
}
export function readIndicatorSettings():IndicatorConfig{
  try{
    const c=sanitizeStyle({...defaultIndicators,...JSON.parse(localStorage.getItem(storageKey)??'{}')});
    return validInputs(c)?c:defaultIndicators;
  }catch{return defaultIndicators;}
}
export function useIndicatorSettings(){
  const [settings,setSettings]=useState(readIndicatorSettings);
  useEffect(()=>{
    const read=()=>setSettings(readIndicatorSettings());
    const storage=(event:StorageEvent)=>{if(event.key===storageKey||event.key===null)read();};
    window.addEventListener(settingsChanged,read);window.addEventListener('storage',storage);
    return()=>{window.removeEventListener(settingsChanged,read);window.removeEventListener('storage',storage);};
  },[]);
  function update(next:IndicatorConfig){
    setSettings(next);
    try{localStorage.setItem(storageKey,JSON.stringify(next));}catch{/* Keep settings for this session. */}
    window.dispatchEvent(new Event(settingsChanged));
  }
  return [settings,update] as const;
}

/** Hex color plus alpha, e.g. alpha('#00ff00', .65). */
export function alpha(hex:string,opacity:number){return `${hex}${Math.round(opacity*255).toString(16).padStart(2,'0')}`;}

const TITLES:Record<SettingsKind,string>={trendsma:'MA',bollinger:'BB',supertrend:'Supertrend',triplema:'Triple MA',rsi:'RSI',adx:'ADX Trend Strength',atr:'ATR'};
const FIELDS:Record<SettingsKind,(keyof IndicatorConfig)[]>={
  trendsma:['trendSmaLength','trendSmaColor','trendSmaWidth'],
  bollinger:['bbLength','bbMaType','bbSource','bbMultiplier','bbOffset','bbBasisColor','bbUpperColor','bbLowerColor','bbWidth'],
  supertrend:['supertrendLength','supertrendMultiplier','stUpColor','stDownColor','stWidth'],
  triplema:['maType','maFast','maMid','maSlow','maFastColor','maMidColor','maSlowColor','maWidth'],
  rsi:['rsiLength','rsiUpper','rsiLower','rsiColor','rsiWidth'],
  adx:['diLength','adxLength','showDi','showStatus','adxTrendLevel','adxStrongLevel','showAdxLevels','adxWeakColor','adxTrendColor','adxStrongColor','diPlusColor','diMinusColor','adxBullBgColor','adxBearBgColor','adxWidth'],
  atr:['atrLength','atrSmoothing','atrThreshold','atrColor','atrWidth'],
};

function Row({label,children}:{label:string;children:ReactNode}){
  return <label className="tv-dialog-row"><span>{label}</span><span className="tv-dialog-control">{children}</span></label>;
}

/** TradingView-style indicator dialog: Inputs / Style tabs, live preview, Cancel reverts. */
export default function IndicatorSettings({kind,value,onApply,onClose}:{kind:SettingsKind;value:IndicatorConfig;onApply:(config:IndicatorConfig)=>void;onClose:()=>void}){
  const original=useRef(value);
  const [draft,setDraft]=useState(value);
  const [tab,setTab]=useState<'inputs'|'style'>('inputs');
  const dialog=useRef<HTMLDialogElement>(null);
  const defaultsMenu=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{const element=dialog.current,previous=document.activeElement as HTMLElement|null;element?.showModal();return ()=>{element?.close();previous?.focus();};},[]);
  const valid=validInputs(draft);
  const error=!valid?(kind==='rsi'&&draft.rsiLower>=draft.rsiUpper?'Lower band must be below the upper band.':kind==='adx'&&draft.adxTrendLevel>=draft.adxStrongLevel?'Level 1 must be below level 2.':'Check the highlighted inputs.'):'';
  function change(next:IndicatorConfig){setDraft(next);if(validInputs(next))onApply(next);}
  function set<K extends keyof IndicatorConfig>(key:K,v:IndicatorConfig[K]){change({...draft,[key]:v});}
  function cancel(){onApply(original.current);onClose();}
  function resetDefaults(){
    const reset={...draft};for(const key of FIELDS[kind])(reset as Record<string,unknown>)[key]=defaultIndicators[key];
    change(reset);if(defaultsMenu.current)defaultsMenu.current.open=false;
  }
  const num=(key:keyof IndicatorConfig,props:{min?:number;max?:number;step?:number|'any'}={})=>
    <input type="number" {...props} value={Number.isFinite(draft[key] as number)?draft[key] as number:''} aria-invalid={!Number.isFinite(draft[key] as number)} onChange={e=>set(key,e.target.valueAsNumber as never)}/>;
  const color=(key:keyof IndicatorStyle,label:string)=><Row label={label}><span className="tv-color"><input type="color" value={draft[key] as string} onChange={e=>set(key,e.target.value as never)} aria-label={`${label} color`}/></span></Row>;
  const width=(key:keyof IndicatorStyle)=><Row label="Line thickness"><span className="tv-widths" role="radiogroup" aria-label="Line thickness">{[1,2,3,4].map(w=><button type="button" key={w} role="radio" aria-checked={draft[key]===w} title={`${w}px`} onClick={()=>set(key,w as never)}><i style={{height:w}}/></button>)}</span></Row>;
  const inputs:Record<SettingsKind,ReactNode>={
    trendsma:<>
      <Row label="Length">{num('trendSmaLength',{min:1,max:1000,step:1})}</Row>
      <Row label="Source"><select disabled value="close"><option value="close">Close</option></select></Row>
    </>,
    bollinger:<>
      <Row label="Length">{num('bbLength',{min:1,step:1})}</Row>
      <Row label="Basis MA type"><select value={draft.bbMaType} onChange={e=>set('bbMaType',e.target.value as IndicatorConfig['bbMaType'])}>{BB_MA_TYPES.map(type=><option key={type}>{type}</option>)}</select></Row>
      <Row label="Source"><select value={draft.bbSource} onChange={e=>set('bbSource',e.target.value as IndicatorConfig['bbSource'])}>{BB_SOURCES.map(source=><option key={source} value={source}>{source[0].toUpperCase()+source.slice(1)}</option>)}</select></Row>
      <Row label="StdDev">{num('bbMultiplier',{min:.001,max:50,step:'any'})}</Row>
      <Row label="Offset">{num('bbOffset',{min:-500,max:500,step:1})}</Row>
    </>,
    supertrend:<>
      <Row label="ATR length">{num('supertrendLength',{min:1,max:1000,step:1})}</Row>
      <Row label="Factor">{num('supertrendMultiplier',{min:.01,max:100,step:'any'})}</Row>
    </>,
    triplema:<>
      <Row label="MA type"><select value={draft.maType} onChange={e=>set('maType',e.target.value as IndicatorConfig['maType'])}><option>SMA</option><option>EMA</option></select></Row>
      <Row label="Fast length">{num('maFast',{min:1,max:1000,step:1})}</Row>
      <Row label="Middle length">{num('maMid',{min:1,max:1000,step:1})}</Row>
      <Row label="Slow length">{num('maSlow',{min:1,max:1000,step:1})}</Row>
    </>,
    rsi:<>
      <Row label="RSI length">{num('rsiLength',{min:1,max:1000,step:1})}</Row>
      <Row label="Source"><select disabled value="close"><option value="close">Close</option></select></Row>
      <Row label="Upper band">{num('rsiUpper',{min:0,max:100,step:.5})}</Row>
      <Row label="Lower band">{num('rsiLower',{min:0,max:100,step:.5})}</Row>
    </>,
    adx:<>
      <Row label="DI length">{num('diLength',{min:1,max:1000,step:1})}</Row>
      <Row label="ADX smoothing">{num('adxLength',{min:1,max:1000,step:1})}</Row>
      <label className="tv-dialog-check"><input type="checkbox" checked={draft.showDi} onChange={e=>set('showDi',e.target.checked)}/>Display DI lines</label>
      <label className="tv-dialog-check"><input type="checkbox" checked={draft.showStatus} onChange={e=>set('showStatus',e.target.checked)}/>Show trend label</label>
      <label className="tv-dialog-check"><input type="checkbox" checked={draft.showAdxLevels} onChange={e=>set('showAdxLevels',e.target.checked)}/>Show threshold lines</label>
      <Row label="Level 1">{num('adxTrendLevel',{min:0,max:100,step:.5})}</Row>
      <Row label="Level 2">{num('adxStrongLevel',{min:0,max:100,step:.5})}</Row>
    </>,
    atr:<>
      <Row label="Length">{num('atrLength',{min:1,max:1000,step:1})}</Row>
      <Row label="Smoothing"><select value={draft.atrSmoothing} onChange={e=>set('atrSmoothing',e.target.value as IndicatorConfig['atrSmoothing'])}>{['RMA','SMA','EMA','WMA'].map(method=><option key={method}>{method}</option>)}</select></Row>
      <Row label="Threshold">{num('atrThreshold',{min:0,step:'any'})}</Row>
    </>,
  };
  const style:Record<SettingsKind,ReactNode>={
    trendsma:<>{color('trendSmaColor','Plot')}{width('trendSmaWidth')}</>,
    bollinger:<>{color('bbBasisColor','Basis')}{color('bbUpperColor','Upper')}{color('bbLowerColor','Lower')}{width('bbWidth')}</>,
    supertrend:<>{color('stUpColor','Up trend')}{color('stDownColor','Down trend')}{width('stWidth')}</>,
    triplema:<>{color('maFastColor','Fast MA')}{color('maMidColor','Middle MA')}{color('maSlowColor','Slow MA')}{width('maWidth')}</>,
    rsi:<>{color('rsiColor','RSI')}{width('rsiWidth')}</>,
    adx:<>
      {color('adxWeakColor',`Weak (below ${draft.adxTrendLevel})`)}
      {color('adxTrendColor',`Trend (${draft.adxTrendLevel}–${draft.adxStrongLevel})`)}
      {color('adxStrongColor',`Strong trend (${draft.adxStrongLevel}+)`)}
      {width('adxWidth')}
      {color('diPlusColor','+DI')}
      {color('diMinusColor','−DI')}
      {color('adxBullBgColor','Background +DI > −DI')}
      {color('adxBearBgColor','Background −DI > +DI')}
    </>,
    atr:<>{color('atrColor','ATR')}{width('atrWidth')}</>,
  };
  return createPortal(<dialog ref={dialog} className="indicator-modal tv-dialog" aria-labelledby="indicator-dialog-title" onCancel={e=>{e.preventDefault();cancel();}} onClick={e=>{if(e.target!==e.currentTarget)return;const rect=e.currentTarget.getBoundingClientRect();if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)cancel();}}>
    <form onSubmit={event=>{event.preventDefault();if(valid)onClose();}}>
      <header className="tv-dialog-header"><h3 id="indicator-dialog-title">{TITLES[kind]}</h3><button type="button" className="tv-dialog-close" aria-label="Close" onClick={cancel}><svg viewBox="0 0 18 18" aria-hidden="true"><path d="M4.5 4.5l9 9M13.5 4.5l-9 9"/></svg></button></header>
      <div className="tv-dialog-tabs" role="tablist">{(['inputs','style'] as const).map(name=><button type="button" key={name} role="tab" aria-selected={tab===name} onClick={()=>setTab(name)}>{name==='inputs'?'Inputs':'Style'}</button>)}</div>
      <div className="tv-dialog-body" role="tabpanel">{tab==='inputs'?inputs[kind]:style[kind]}</div>
      {error&&<p className="tv-dialog-error" role="alert">{error}</p>}
      <footer className="tv-dialog-footer">
        <details className="tv-defaults" ref={defaultsMenu}><summary>Defaults<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M5 7l4 4 4-4"/></svg></summary><div><button type="button" onClick={resetDefaults}>Reset settings</button></div></details>
        <button type="button" className="tv-dialog-cancel" onClick={cancel}>Cancel</button>
        <button type="submit" className="tv-dialog-ok" disabled={!valid}>Ok</button>
      </footer>
    </form>
  </dialog>,document.body);
}

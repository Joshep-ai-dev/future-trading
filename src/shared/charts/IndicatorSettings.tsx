import {BB_MA_TYPES,BB_SOURCES,defaultBollinger,validBollinger,type BollingerConfig} from './bollingerBands';
import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';

export type IndicatorKind='atr'|'adx'|'rsi';

export type IndicatorConfig={bbLength:number;bbMaType:BollingerConfig['maType'];bbSource:BollingerConfig['source'];bbMultiplier:number;bbOffset:number;supertrendLength:number;supertrendMultiplier:number;atrLength:number;atrThreshold:number;atrSmoothing:'RMA'|'SMA'|'EMA'|'WMA';adxLength:number;adxThreshold:number;displaySmoothing:number;showStatus:boolean;rsiLength:number;rsiUpper:number;rsiLower:number};
export const defaultIndicators:IndicatorConfig={bbLength:defaultBollinger.length,bbMaType:defaultBollinger.maType,bbSource:defaultBollinger.source,bbMultiplier:defaultBollinger.multiplier,bbOffset:defaultBollinger.offset,supertrendLength:10,supertrendMultiplier:3,atrLength:14,atrThreshold:0.03,atrSmoothing:'RMA',adxLength:14,adxThreshold:25,displaySmoothing:1,showStatus:true,rsiLength:14,rsiUpper:85,rsiLower:15};
const settingsChanged='silver:chart-indicator-settings-changed';
export function readIndicatorSettings():IndicatorConfig{
  try{
    const c={...defaultIndicators,...JSON.parse(localStorage.getItem('silver.chart.indicatorSettings')??'{}')};
    if(!validBollinger({length:c.bbLength,maType:c.bbMaType,source:c.bbSource,multiplier:c.bbMultiplier,offset:c.bbOffset}))return defaultIndicators;
    if(!Number.isFinite(c.supertrendMultiplier)||c.supertrendMultiplier<.01||c.supertrendMultiplier>100||!Number.isFinite(c.atrThreshold)||c.atrThreshold<0||![c.atrLength,c.adxLength,c.rsiLength,c.supertrendLength].every(v=>Number.isInteger(v)&&v>=1&&v<=1000)||!Number.isInteger(c.displaySmoothing)||c.displaySmoothing<1||c.displaySmoothing>10||!Number.isFinite(c.adxThreshold)||c.adxThreshold<0||c.adxThreshold>100||!['RMA','SMA','EMA','WMA'].includes(c.atrSmoothing)||typeof c.showStatus!=='boolean'||![c.rsiUpper,c.rsiLower].every(v=>Number.isFinite(v)&&v>=0&&v<=100)||c.rsiLower>=c.rsiUpper)return defaultIndicators;
    return c;
  }catch{return defaultIndicators;}
}
export function useIndicatorSettings(){
  const [settings,setSettings]=useState(readIndicatorSettings);
  useEffect(()=>{
    const read=()=>setSettings(readIndicatorSettings());
    const storage=(event:StorageEvent)=>{if(event.key==='silver.chart.indicatorSettings'||event.key===null)read();};
    window.addEventListener(settingsChanged,read);window.addEventListener('storage',storage);
    return()=>{window.removeEventListener(settingsChanged,read);window.removeEventListener('storage',storage);};
  },[]);
  function update(next:IndicatorConfig){
    setSettings(next);
    try{localStorage.setItem('silver.chart.indicatorSettings',JSON.stringify(next));}catch{/* Keep settings for this session. */}
    window.dispatchEvent(new Event(settingsChanged));
  }
  return [settings,update] as const;
}
export default function IndicatorSettings({kind,value,onApply,onClose}:{kind:IndicatorKind|'supertrend'|'bollinger';value:IndicatorConfig;onApply:(config:IndicatorConfig)=>void;onClose:()=>void}){
  const [draft,setDraft]=useState(value);
  const dialog=useRef<HTMLDialogElement>(null);
  const [error,setError]=useState('');
  useEffect(()=>{const element=dialog.current,previous=document.activeElement as HTMLElement|null;element?.showModal();return ()=>{element?.close();previous?.focus();};},[]);
  function defaults(){setError('');setDraft(old=>({...old,...(kind==='bollinger'?{bbLength:defaultIndicators.bbLength,bbMaType:defaultIndicators.bbMaType,bbSource:defaultIndicators.bbSource,bbMultiplier:defaultIndicators.bbMultiplier,bbOffset:defaultIndicators.bbOffset}:kind==='supertrend'?{supertrendLength:defaultIndicators.supertrendLength,supertrendMultiplier:defaultIndicators.supertrendMultiplier}:kind==='atr'?{atrLength:defaultIndicators.atrLength,atrThreshold:defaultIndicators.atrThreshold,atrSmoothing:defaultIndicators.atrSmoothing}:kind==='adx'?{adxLength:defaultIndicators.adxLength,adxThreshold:defaultIndicators.adxThreshold,displaySmoothing:defaultIndicators.displaySmoothing,showStatus:defaultIndicators.showStatus}:{rsiLength:defaultIndicators.rsiLength,rsiUpper:defaultIndicators.rsiUpper,rsiLower:defaultIndicators.rsiLower})}));}
  return createPortal(<dialog ref={dialog} className="indicator-modal" aria-labelledby="indicator-dialog-title" onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{if(e.target!==e.currentTarget)return;const rect=e.currentTarget.getBoundingClientRect();if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)onClose();}}><form className="indicator-settings" onSubmit={event=>{event.preventDefault();if(kind==='bollinger'&&!validBollinger({length:draft.bbLength,maType:draft.bbMaType,source:draft.bbSource,multiplier:draft.bbMultiplier,offset:draft.bbOffset})){setError('Check the Bollinger Bands inputs.');return;}if(kind==='rsi'&&draft.rsiLower>=draft.rsiUpper){setError('Lower level must be below the upper level.');return;}onApply(draft);onClose();}}>
    <div className="indicator-settings-heading"><div><h3 id="indicator-dialog-title">{kind==='bollinger'?'Bollinger Bands':kind.toUpperCase()} settings</h3><p>Chart display only. Indicator settings do not place trades.</p></div><button type="button" className="text-button" aria-label="Close indicator settings" onClick={onClose}>×</button></div>
    <div className="indicator-settings-columns">{kind==='bollinger'&&<fieldset><legend>Bollinger Bands inputs</legend>
      <label>Length<input type="number" min="1" step="1" required value={draft.bbLength||''} onChange={e=>setDraft({...draft,bbLength:Number(e.target.value)})}/></label>
      <label>Basis MA Type<select value={draft.bbMaType} onChange={e=>setDraft({...draft,bbMaType:e.target.value as BollingerConfig['maType']})}>{BB_MA_TYPES.map(type=><option key={type}>{type}</option>)}</select></label>
      <label>Source<select value={draft.bbSource} onChange={e=>setDraft({...draft,bbSource:e.target.value as BollingerConfig['source']})}>{BB_SOURCES.map(source=><option key={source} value={source}>{source.toUpperCase()}</option>)}</select></label>
      <label>StdDev<input type="number" min="0.001" max="50" step="any" required value={draft.bbMultiplier||''} onChange={e=>setDraft({...draft,bbMultiplier:Number(e.target.value)})}/></label>
      <label>Offset (bars)<input type="number" min="-500" max="500" step="1" required value={draft.bbOffset} onChange={e=>setDraft({...draft,bbOffset:Number(e.target.value)})}/></label>
      <p>Population standard deviation of the selected source. Offset shifts the plot in bars. VWMA requires candle volume. The live candle updates until it closes.</p>
    </fieldset>}{kind==='supertrend'&&<fieldset><legend>Supertrend inputs</legend><label>ATR period<input type="number" min="1" max="1000" step="1" required value={draft.supertrendLength||''} onChange={e=>setDraft({...draft,supertrendLength:Number(e.target.value)})}/></label><label>ATR multiplier<input type="number" min="0.01" max="100" step="any" required value={draft.supertrendMultiplier||''} onChange={e=>setDraft({...draft,supertrendMultiplier:Number(e.target.value)})}/></label><p>Pine Supertrend: Wilder ATR, green uptrend and red downtrend. The live candle updates until it closes.</p></fieldset>}{kind==='atr'&&<fieldset><legend>Inputs</legend><label>Length<input type="number" min="1" max="1000" step="1" required value={draft.atrLength||''} onChange={e=>setDraft({...draft,atrLength:Number(e.target.value)})}/></label><label>Smoothing<select value={draft.atrSmoothing} onChange={e=>setDraft({...draft,atrSmoothing:e.target.value as IndicatorConfig['atrSmoothing']})}>{['RMA','SMA','EMA','WMA'].map(method=><option key={method}>{method}</option>)}</select></label><label>Threshold (price units)<input type="number" min="0" step="any" required value={draft.atrThreshold} onChange={e=>setDraft({...draft,atrThreshold:e.target.valueAsNumber})}/></label></fieldset>}
    {kind==='adx'&&<fieldset><legend>ADX Strength · 20 / 25</legend><label>ADX length<input type="number" min="1" max="1000" step="1" required value={draft.adxLength||''} onChange={e=>setDraft({...draft,adxLength:Number(e.target.value)})}/></label><label>Entry threshold<input type="number" min="0" max="100" step="0.5" required value={draft.adxThreshold} onChange={e=>setDraft({...draft,adxThreshold:Number(e.target.value)})}/></label><label>Curve smoothing · display only<input type="number" min="1" max="10" step="1" required value={draft.displaySmoothing||''} onChange={e=>setDraft({...draft,displaySmoothing:Number(e.target.value)})}/></label><label className="indicator-checkbox"><input type="checkbox" checked={draft.showStatus} onChange={e=>setDraft({...draft,showStatus:e.target.checked})}/> Show strength label</label></fieldset>}
    {kind==='rsi'&&<fieldset><legend>RSI inputs ? close price</legend><label>Length<input type="number" min="1" max="1000" step="1" required value={draft.rsiLength||''} onChange={e=>setDraft({...draft,rsiLength:Number(e.target.value)})}/></label><label>Upper level<input type="number" min="0" max="100" step="0.5" required value={draft.rsiUpper} onChange={e=>setDraft({...draft,rsiUpper:Number(e.target.value)})}/></label><label>Lower level<input type="number" min="0" max="100" step="0.5" required value={draft.rsiLower} onChange={e=>setDraft({...draft,rsiLower:Number(e.target.value)})}/></label></fieldset>}</div>
    {error&&<p className="error" role="alert">{error}</p>}
    <div className="indicator-settings-footer"><button type="button" className="secondary" onClick={defaults}>Defaults</button><button type="button" className="secondary" onClick={onClose}>Cancel</button><button type="submit">Apply</button></div>
  </form></dialog>,document.body);
}

import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';

export type IndicatorKind='atr'|'adx'|'rsi';

export type IndicatorConfig={atrLength:number;atrSmoothing:'RMA'|'SMA'|'EMA'|'WMA';adxLength:number;adxThreshold:number;displaySmoothing:number;showStatus:boolean;rsiLength:number;rsiUpper:number;rsiLower:number};
export const defaultIndicators:IndicatorConfig={atrLength:14,atrSmoothing:'RMA',adxLength:14,adxThreshold:25,displaySmoothing:1,showStatus:true,rsiLength:14,rsiUpper:85,rsiLower:15};
export function readIndicatorSettings():IndicatorConfig{
  try{
    const c={...defaultIndicators,...JSON.parse(localStorage.getItem('silver.chart.indicatorSettings')??'{}')};
    if(![c.atrLength,c.adxLength,c.rsiLength].every(v=>Number.isInteger(v)&&v>=1&&v<=1000)||!Number.isInteger(c.displaySmoothing)||c.displaySmoothing<1||c.displaySmoothing>10||!Number.isFinite(c.adxThreshold)||c.adxThreshold<0||c.adxThreshold>100||!['RMA','SMA','EMA','WMA'].includes(c.atrSmoothing)||typeof c.showStatus!=='boolean'||![c.rsiUpper,c.rsiLower].every(v=>Number.isFinite(v)&&v>=0&&v<=100)||c.rsiLower>=c.rsiUpper)return defaultIndicators;
    return c;
  }catch{return defaultIndicators;}
}
export default function IndicatorSettings({kind,value,onApply,onClose}:{kind:IndicatorKind;value:IndicatorConfig;onApply:(config:IndicatorConfig)=>void;onClose:()=>void}){
  const [draft,setDraft]=useState(value);
  const dialog=useRef<HTMLDialogElement>(null);
  const [error,setError]=useState('');
  useEffect(()=>{const element=dialog.current,previous=document.activeElement as HTMLElement|null;element?.showModal();return ()=>{element?.close();previous?.focus();};},[]);
  function defaults(){setError('');setDraft(old=>({...old,...(kind==='atr'?{atrLength:defaultIndicators.atrLength,atrSmoothing:defaultIndicators.atrSmoothing}:kind==='adx'?{adxLength:defaultIndicators.adxLength,adxThreshold:defaultIndicators.adxThreshold,displaySmoothing:defaultIndicators.displaySmoothing,showStatus:defaultIndicators.showStatus}:{rsiLength:defaultIndicators.rsiLength,rsiUpper:defaultIndicators.rsiUpper,rsiLower:defaultIndicators.rsiLower})}));}
  return createPortal(<dialog ref={dialog} className="indicator-modal" aria-labelledby="indicator-dialog-title" onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{if(e.target!==e.currentTarget)return;const rect=e.currentTarget.getBoundingClientRect();if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)onClose();}}><form className="indicator-settings" onSubmit={event=>{event.preventDefault();if(kind==='rsi'&&draft.rsiLower>=draft.rsiUpper){setError('Lower level must be below the upper level.');return;}onApply(draft);onClose();}}>
    <div className="indicator-settings-heading"><div><h3 id="indicator-dialog-title">{kind.toUpperCase()} settings</h3><p>Chart display only. Bot entry and exit rules use Bot settings.</p></div><button type="button" className="text-button" aria-label="Close indicator settings" onClick={onClose}>×</button></div>
    <div className="indicator-settings-columns">{kind==='atr'&&<fieldset><legend>Inputs</legend><label>Length<input type="number" min="1" max="1000" step="1" required value={draft.atrLength||''} onChange={e=>setDraft({...draft,atrLength:Number(e.target.value)})}/></label><label>Smoothing<select value={draft.atrSmoothing} onChange={e=>setDraft({...draft,atrSmoothing:e.target.value as IndicatorConfig['atrSmoothing']})}>{['RMA','SMA','EMA','WMA'].map(method=><option key={method}>{method}</option>)}</select></label></fieldset>}
    {kind==='adx'&&<fieldset><legend>ADX Strength · 20 / 25</legend><label>ADX length<input type="number" min="1" max="1000" step="1" required value={draft.adxLength||''} onChange={e=>setDraft({...draft,adxLength:Number(e.target.value)})}/></label><label>Entry threshold<input type="number" min="0" max="100" step="0.5" required value={draft.adxThreshold} onChange={e=>setDraft({...draft,adxThreshold:Number(e.target.value)})}/></label><label>Curve smoothing · display only<input type="number" min="1" max="10" step="1" required value={draft.displaySmoothing||''} onChange={e=>setDraft({...draft,displaySmoothing:Number(e.target.value)})}/></label><label className="indicator-checkbox"><input type="checkbox" checked={draft.showStatus} onChange={e=>setDraft({...draft,showStatus:e.target.checked})}/> Show strength label</label></fieldset>}
    {kind==='rsi'&&<fieldset><legend>RSI inputs ? close price</legend><label>Length<input type="number" min="1" max="1000" step="1" required value={draft.rsiLength||''} onChange={e=>setDraft({...draft,rsiLength:Number(e.target.value)})}/></label><label>Upper level<input type="number" min="0" max="100" step="0.5" required value={draft.rsiUpper} onChange={e=>setDraft({...draft,rsiUpper:Number(e.target.value)})}/></label><label>Lower level<input type="number" min="0" max="100" step="0.5" required value={draft.rsiLower} onChange={e=>setDraft({...draft,rsiLower:Number(e.target.value)})}/></label></fieldset>}</div>
    {error&&<p className="error" role="alert">{error}</p>}
    <div className="indicator-settings-footer"><button type="button" className="secondary" onClick={defaults}>Defaults</button><button type="button" className="secondary" onClick={onClose}>Cancel</button><button type="submit">Apply</button></div>
  </form></dialog>,document.body);
}

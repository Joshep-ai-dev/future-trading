import {useState} from 'react';

export type IndicatorConfig={atrLength:number;atrSmoothing:'RMA'|'SMA'|'EMA'|'WMA';adxLength:number;adxThreshold:number;displaySmoothing:number;showStatus:boolean};
export const defaultIndicators:IndicatorConfig={atrLength:14,atrSmoothing:'RMA',adxLength:14,adxThreshold:25,displaySmoothing:1,showStatus:true};
export function readIndicatorSettings():IndicatorConfig{
  try{
    const c={...defaultIndicators,...JSON.parse(localStorage.getItem('silver.chart.indicatorSettings')??'{}')};
    if(![c.atrLength,c.adxLength].every(v=>Number.isInteger(v)&&v>=1&&v<=1000)||!Number.isInteger(c.displaySmoothing)||c.displaySmoothing<1||c.displaySmoothing>10||!Number.isFinite(c.adxThreshold)||c.adxThreshold<0||c.adxThreshold>100||!['RMA','SMA','EMA','WMA'].includes(c.atrSmoothing)||typeof c.showStatus!=='boolean')return defaultIndicators;
    return c;
  }catch{return defaultIndicators;}
}
export default function IndicatorSettings({value,onApply,onClose}:{value:IndicatorConfig;onApply:(config:IndicatorConfig)=>void;onClose:()=>void}){
  const [draft,setDraft]=useState(value);
  return <form className="indicator-settings" aria-label="Indicator settings" onSubmit={event=>{event.preventDefault();onApply(draft);onClose();}}>
    <div className="indicator-settings-heading"><div><h3>Indicator settings</h3><p>Chart display only. Bot entry and exit rules use Bot settings.</p></div><button type="button" className="text-button" aria-label="Close indicator settings" onClick={onClose}>×</button></div>
    <div className="indicator-settings-columns"><fieldset><legend>ATR</legend><label>Length<input type="number" min="1" max="1000" step="1" required value={draft.atrLength||''} onChange={e=>setDraft({...draft,atrLength:Number(e.target.value)})}/></label><label>Smoothing<select value={draft.atrSmoothing} onChange={e=>setDraft({...draft,atrSmoothing:e.target.value as IndicatorConfig['atrSmoothing']})}>{['RMA','SMA','EMA','WMA'].map(method=><option key={method}>{method}</option>)}</select></label></fieldset>
    <fieldset><legend>ADX Strength · 20 / 25</legend><label>ADX length<input type="number" min="1" max="1000" step="1" required value={draft.adxLength||''} onChange={e=>setDraft({...draft,adxLength:Number(e.target.value)})}/></label><label>Entry threshold<input type="number" min="0" max="100" step="0.5" required value={draft.adxThreshold} onChange={e=>setDraft({...draft,adxThreshold:Number(e.target.value)})}/></label><label>Curve smoothing · display only<input type="number" min="1" max="10" step="1" required value={draft.displaySmoothing||''} onChange={e=>setDraft({...draft,displaySmoothing:Number(e.target.value)})}/></label><label className="indicator-checkbox"><input type="checkbox" checked={draft.showStatus} onChange={e=>setDraft({...draft,showStatus:e.target.checked})}/> Show strength label</label></fieldset></div>
    <div className="indicator-settings-footer"><button type="button" className="secondary" onClick={()=>setDraft(defaultIndicators)}>Defaults</button><button type="button" className="secondary" onClick={onClose}>Cancel</button><button type="submit">Apply</button></div>
  </form>;
}

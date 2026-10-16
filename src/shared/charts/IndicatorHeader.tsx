import {indicatorColor} from './indicatorColors';
import type {IndicatorKind,IndicatorConfig} from './IndicatorSettings';
import {fmt} from '../types/types';
export default function IndicatorHeader({kind,config,value,hidden,top,onVisibility,onSettings,onRemove}:{kind:IndicatorKind;config:IndicatorConfig;value:number|null;hidden:boolean;top:number;onVisibility:()=>void;onSettings:()=>void;onRemove:()=>void}){
  const title=kind==='atr'?`ATR ${config.atrLength} ${config.atrSmoothing} TH ${config.atrThreshold}`:kind==='adx'?`ADX Strength: 20 / 25  ${config.adxLength} ${config.adxThreshold} ${config.displaySmoothing}`:`RSI ${config.rsiLength} close`;
  return <div className={`indicator-pane-header ${hidden?'is-hidden':''}`} style={{top}} role="group" aria-label={`${kind.toUpperCase()} panel controls`} onPointerDown={e=>e.stopPropagation()} onWheel={e=>e.stopPropagation()}>
    <button className="indicator-pane-name" title="Open indicator settings" onClick={onSettings}>{title}</button><span className={`indicator-pane-value ${kind}`} style={{color:indicatorColor(kind,value,config)}}>{value===null?'—':fmt(value,kind==='atr'?3:2)}</span>
    <div className="indicator-pane-actions">
      <button aria-label={`${hidden?'Show':'Hide'} ${kind.toUpperCase()} curve`} title={hidden?'Show curve':'Hide curve'} aria-pressed={!hidden} onClick={onVisibility}><svg viewBox="0 0 20 20"><path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5Z"/><circle cx="10" cy="10" r="2"/>{hidden&&<path d="m3 3 14 14"/>}</svg></button>
      <button aria-label={`${kind.toUpperCase()} panel settings`} title="Settings" onClick={onSettings}><svg viewBox="0 0 20 20"><path d="m7 3 6 0 1 3 3 1 0 6-3 1-1 3H7l-1-3-3-1V7l3-1Z"/><circle cx="10" cy="10" r="3"/></svg></button>
      <button aria-label={`Remove ${kind.toUpperCase()} panel`} title="Remove indicator" onClick={onRemove}><svg viewBox="0 0 20 20"><path d="M4 5h12M8 3h4M6 5l1 12h6l1-12M9 8v6m2-6v6"/></svg></button>
    </div>
  </div>;
}

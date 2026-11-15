import {indicatorColor} from './indicatorColors';
import type {IndicatorKind,IndicatorConfig} from './IndicatorSettings';
import {fmt} from '../types/types';
import {CloseIcon,EyeIcon,GearIcon} from './ChartLegend';

function label(kind:IndicatorKind,config:IndicatorConfig):[string,string]{
  if(kind==='atr')return ['ATR',`${config.atrLength} ${config.atrSmoothing} · TH ${config.atrThreshold}`];
  if(kind==='adx')return ['ADX',`${config.adxLength} · Entry ${config.adxThreshold} · Smooth ${config.displaySmoothing}`];
  return ['RSI',`${config.rsiLength} close · ${config.rsiLower} / ${config.rsiUpper}`];
}

/** TradingView-style pane legend: name, inputs and value; eye/gear/close on hover. */
export default function IndicatorHeader({kind,config,value,hidden,top,onVisibility,onSettings,onRemove}:{kind:IndicatorKind;config:IndicatorConfig;value:number|null;hidden:boolean;top:number;onVisibility:()=>void;onSettings:()=>void;onRemove:()=>void}){
  const [name,params]=label(kind,config);
  return <div className={`indicator-pane-header ${hidden?'is-hidden':''}`} style={{top}} role="group" aria-label={`${name} panel controls`} onPointerDown={e=>e.stopPropagation()} onWheel={e=>e.stopPropagation()}>
    <button type="button" className="indicator-pane-name" title="Open indicator settings" onClick={onSettings}><b>{name}</b><span>{params}</span></button>
    <span className={`indicator-pane-value ${kind}`} style={{color:indicatorColor(kind,value,config)}}>{value===null?'∅':fmt(value,kind==='atr'?3:2)}</span>
    <div className="indicator-pane-actions">
      <button type="button" aria-label={`${hidden?'Show':'Hide'} ${name}`} title={hidden?'Show':'Hide'} aria-pressed={!hidden} onClick={onVisibility}><EyeIcon off={hidden}/></button>
      <button type="button" aria-label={`${name} settings`} title="Settings" onClick={onSettings}><GearIcon/></button>
      <button type="button" aria-label={`Remove ${name}`} title="Remove" onClick={onRemove}><CloseIcon/></button>
    </div>
  </div>;
}

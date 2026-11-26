import {indicatorColor} from './indicatorColors';
import type {IndicatorKind,IndicatorConfig} from './indicatorConfig';
import {fmt} from '../types/types';
import {CloseIcon,EyeIcon,GearIcon} from './ChartLegend';

function label(kind:IndicatorKind,config:IndicatorConfig):[string,string]{
  if(kind==='atr')return ['ATR',`${config.atrLength} ${config.atrSmoothing} · TH ${config.atrThreshold}`];
  if(kind==='adx')return ['ADX Trend Strength',`${config.diLength} ${config.adxLength}`];
  if(kind==='macd')return ['MACD',`${config.macdFast} ${config.macdSlow} ${config.macdSource} ${config.macdSignal}`];
  return ['RSI',`${config.rsiLength} close · ${config.rsiLower} / ${config.rsiUpper}`];
}

/** TradingView-style pane legend: name, inputs and value; eye/gear/close on hover. */
export default function IndicatorHeader({kind,config,value,extra,hidden,top,onVisibility,onSettings,onRemove}:{kind:IndicatorKind;config:IndicatorConfig;value:number|null;extra?:{value:number|null;color:string}[];hidden:boolean;top:number;onVisibility:()=>void;onSettings:()=>void;onRemove:()=>void}){
  const [name,params]=label(kind,config);
  const digits=kind==='macd'?4:kind==='atr'?3:2;
  return <div className={`indicator-pane-header ${hidden?'is-hidden':''}`} style={{top}} role="group" aria-label={`${name} panel controls`} onPointerDown={e=>e.stopPropagation()} onWheel={e=>e.stopPropagation()}>
    <button type="button" className="indicator-pane-name" title="Open indicator settings" onClick={onSettings}><b>{name}</b><span>{params}</span></button>
    <span className={`indicator-pane-value ${kind}`} style={{color:indicatorColor(kind,value,config)}}>{value===null?'∅':fmt(value,digits)}</span>
    {extra?.map((item,index)=><span key={index} className="indicator-pane-value" style={{color:item.color}}>{item.value===null?'∅':fmt(item.value,digits)}</span>)}
    <div className="indicator-pane-actions">
      <button type="button" aria-label={`${hidden?'Show':'Hide'} ${name}`} title={hidden?'Show':'Hide'} aria-pressed={!hidden} onClick={onVisibility}><EyeIcon off={hidden}/></button>
      <button type="button" aria-label={`${name} settings`} title="Settings" onClick={onSettings}><GearIcon/></button>
      <button type="button" aria-label={`Remove ${name}`} title="Remove" onClick={onRemove}><CloseIcon/></button>
    </div>
  </div>;
}

import {useEffect,useRef} from 'react';
import type {IChartApi} from 'lightweight-charts';

export const chartInteraction = {
  handleScale: {mouseWheel:true,pinch:true,axisPressedMouseMove:{time:true,price:true},axisDoubleClickReset:{time:true,price:true}},
  handleScroll: {mouseWheel:true,pressedMouseMove:true,horzTouchDrag:true,vertTouchDrag:false},
};

// Ignore zero-sized hidden tabs; initialize their viewport only when first visible.
export function resizeChart(chart:IChartApi,element:HTMLDivElement,initialView:()=>void) {
  let initialized=false;
  const resize=()=>{
    const width=element.clientWidth,height=element.clientHeight;
    if(!width||!height)return;
    chart.resize(width,height);
    if(!initialized){initialized=true;initialView();}
  };
  const observer=new ResizeObserver(resize);observer.observe(element);resize();
  return ()=>observer.disconnect();
}

export default function ChartTools({chartRef,valueLabel='Price',horizontalLabel='Time',onFullscreen,fullscreen=false,endLabel='Latest',onLatest,onEarlier,onNavigate,loading=false,hasMore=false,indicators,onToggleIndicator,strategyVisible,onToggleStrategy,follow,onFollowChange,showEarlier=false}: {
  chartRef: {current:IChartApi|null}; valueLabel?:string; onLatest?:()=>void;
  endLabel?:string;horizontalLabel?:string;onFullscreen?:()=>void;fullscreen?:boolean;
  onEarlier?:()=>void; loading?:boolean; hasMore?:boolean;
  onNavigate?:()=>void;
  indicators?:{atr:boolean;adx:boolean;rsi:boolean};onToggleIndicator?:(key:'atr'|'adx'|'rsi')=>void;
  strategyVisible?:boolean;onToggleStrategy?:()=>void;
  follow?:boolean;onFollowChange?:(value:boolean)=>void;showEarlier?:boolean;
}) {
  const menu=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{
    const close=(event:PointerEvent)=>{if(menu.current?.open&&!menu.current.contains(event.target as Node))menu.current.open=false;};
    document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);
  },[]);
  function zoomTime(factor:number) {
    onNavigate?.();
    const scale=chartRef.current?.timeScale(), range=scale?.getVisibleLogicalRange();
    if(!scale||!range)return;
    const middle=(range.from+range.to)/2, span=Math.min(20000,Math.max(8,(range.to-range.from)*factor));
    const next={from:middle-span/2,to:middle+span/2};
    scale.setVisibleLogicalRange(next);
    if(factor>1&&next.from<150&&hasMore&&!loading)onEarlier?.();
  }
  function zoomValue(factor:number) {
    onNavigate?.();
    const scale=chartRef.current?.priceScale('right'),range=scale?.getVisibleRange();
    if(!scale||!range)return;
    const middle=(range.from+range.to)/2,span=Math.max(.00001,(range.to-range.from)*factor);
    scale.setAutoScale(false);scale.setVisibleRange({from:middle-span/2,to:middle+span/2});
  }
  function reset() {
    onNavigate?.();
    chartRef.current?.priceScale('right').setAutoScale(true);
    chartRef.current?.timeScale().fitContent();
  }
  const overlays=strategyVisible!==undefined&&onToggleStrategy,studies=indicators&&onToggleIndicator;
  const activeCount=(overlays&&strategyVisible?1:0)+(studies?(['atr','adx','rsi'] as const).filter(key=>indicators[key]).length:0);
  return <div className="chart-actions tv-toolbar">
    {(overlays||studies)&&<details className="tv-menu" ref={menu}><summary title="Indicators"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 15l4-5 3 3 6-8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>Indicators{activeCount>0&&<span className="tv-count">{activeCount}</span>}</summary>
      <div className="tv-menu-popover" role="group" aria-label="Chart overlays and indicators">
        {overlays&&<label><input type="checkbox" checked={strategyVisible} onChange={onToggleStrategy}/><span>Strategy bands<small>Bollinger bands and trend SMA</small></span></label>}
        {studies&&(['atr','adx','rsi'] as const).map(key=><label key={key}><input type="checkbox" checked={indicators[key]} onChange={()=>onToggleIndicator(key)}/><span>{{atr:'ATR',adx:'ADX',rsi:'RSI'}[key]}<small>{{atr:'Average true range',adx:'Trend strength',rsi:'Relative strength index'}[key]}</small></span></label>)}
      </div>
    </details>}
    {(overlays||studies)&&<i className="tv-divider" aria-hidden="true"/>}
    <div className="tv-group" role="group" aria-label={`${valueLabel} chart controls`}>
      <button type="button" className="tv-icon" title={`Zoom out ${horizontalLabel.toLowerCase()} (show more candles)`} aria-label={`Zoom out ${horizontalLabel.toLowerCase()}`} onClick={()=>zoomTime(2)}><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M6.5 9h5M13 13l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg></button>
      <button type="button" className="tv-icon" title={`Zoom in ${horizontalLabel.toLowerCase()}`} aria-label={`Zoom in ${horizontalLabel.toLowerCase()}`} onClick={()=>zoomTime(.5)}><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M6.5 9h5M9 6.5v5M13 13l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg></button>
      <button type="button" className="tv-icon" title={`Stretch ${valueLabel.toLowerCase()} scale`} aria-label={`Zoom in ${valueLabel.toLowerCase()}`} onClick={()=>zoomValue(.7)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v14M6 6l4-3 4 3M6 14l4 3 4-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg></button>
      <button type="button" className="tv-icon" title={`Compress ${valueLabel.toLowerCase()} scale`} aria-label={`Zoom out ${valueLabel.toLowerCase()}`} onClick={()=>zoomValue(1/.7)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v14M6 3l4 3 4-3M6 17l4-3 4 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg></button>
      <button type="button" className="tv-icon" title="Fit all candles and auto-scale" aria-label="Fit / reset" onClick={reset}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg></button>
      {(onEarlier||showEarlier)&&<button type="button" className="tv-text" title="Load older candles" disabled={loading||!hasMore||!onEarlier} onClick={onEarlier}>{loading?'Loading…':'Load earlier'}</button>}
      {onFullscreen&&<button type="button" className="tv-text" aria-label={fullscreen?'Exit chart fullscreen':'Show chart fullscreen'} aria-pressed={fullscreen} onClick={onFullscreen}>{fullscreen?'Exit fullscreen':'Fullscreen'}</button>}
    </div>
    <div className="tv-spacer"/>
    {follow!==undefined&&onFollowChange&&<label className="tv-follow" title="Keep the latest candle in view"><input type="checkbox" checked={follow} onChange={event=>{onNavigate?.();onFollowChange(event.target.checked);if(event.target.checked)onLatest?.();}}/><i aria-hidden="true"/>Follow</label>}
    {onLatest&&<button type="button" className="tv-text tv-latest" title="Scroll to the latest candle" onClick={onLatest}>{endLabel}<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l5 5-5 5M11 5l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg></button>}
  </div>;
}

import {useEffect,useRef,useState,type ReactNode} from 'react';
import type {IChartApi} from 'lightweight-charts';
import type {StudyKind} from './chartStudies';

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

export default function ChartTools({chartRef,valueLabel='Price',horizontalLabel='Time',onFullscreen,fullscreen=false,endLabel='Latest',onLatest,onEarlier,onNavigate,loading=false,hasMore=false,onAddStudy,follow,onFollowChange,showEarlier=false,onAnalyzePattern,patternSelecting=false,actions,header,endActions,patternActions}: {
  patternActions?:ReactNode;endActions?:ReactNode;header?:ReactNode;actions?:ReactNode;onAnalyzePattern?:()=>void;patternSelecting?:boolean;
  chartRef: {current:IChartApi|null}; valueLabel?:string; onLatest?:()=>void;
  endLabel?:string;horizontalLabel?:string;onFullscreen?:()=>void;fullscreen?:boolean;
  onEarlier?:()=>void; loading?:boolean; hasMore?:boolean;
  onNavigate?:()=>void;
  /** Adds another instance of an indicator; the same indicator can be added repeatedly. */
  onAddStudy?:(kind:StudyKind)=>void;
  follow?:boolean;onFollowChange?:(value:boolean)=>void;showEarlier?:boolean;
}) {
  const menu=useRef<HTMLDetailsElement>(null);
  const [query,setQuery]=useState('');
  useEffect(()=>{
    const close=(event:PointerEvent)=>{if(menu.current?.open&&!menu.current.contains(event.target as Node))menu.current.open=false;};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&menu.current?.open)menu.current.open=false;};
    document.addEventListener('pointerdown',close);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',escape);};
  },[]);
  function snapshot(){
    const canvas=chartRef.current?.takeScreenshot();if(!canvas)return;
    const link=document.createElement('a');
    link.download=`chart-${new Date().toISOString().replace(/[:.]/g,'-')}.png`;
    link.href=canvas.toDataURL('image/png');link.click();
  }
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
  const studyList=(['ma','triplema','bollinger','supertrend','zigzag','rsi','adx','atr'] as const).map(key=>({key,name:STUDY_NAMES[key][0],description:STUDY_NAMES[key][1]}));
  const needle=query.trim().toLowerCase();
  const matches=(text:string)=>!needle||text.toLowerCase().includes(needle);
  return <div className="chart-actions tv-toolbar compact-chart-toolbar">
    {header&&<div className="chart-toolbar-heading">{header}</div>}

    {onAddStudy&&<details className="tv-menu" ref={menu} onToggle={event=>{if(!(event.currentTarget as HTMLDetailsElement).open)setQuery('');}}><summary className="tv-indicators-trigger" title="Indicators" aria-label="Indicators"><svg viewBox="0 0 28 28" aria-hidden="true"><path d="M10.5 22c2 0 2.6-1.6 3-4l1.6-9c.4-2.3 1-4 3.4-4M10 11h8M15.5 15l5 6M20.5 15l-5 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg></summary>
      <div className="tv-menu-popover" role="group" aria-label="Chart overlays and indicators">
        <div className="tv-menu-search"><svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="1.4"/><path d="M12 12l4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg><input type="search" placeholder="Search" aria-label="Search indicators" value={query} onChange={event=>setQuery(event.target.value)}/></div>
        <p className="tv-menu-section">Script name</p>
        {studyList.filter(study=>matches(`${study.name} ${study.description}`)).map(study=><button type="button" key={study.key} className="tv-menu-item" title={`Add ${study.name}`} onClick={()=>onAddStudy(study.key)}><span>{study.name}<small>{study.description}</small></span></button>)}
      </div>
    </details>}
    {onAddStudy&&<i className="tv-divider" aria-hidden="true"/>}
    <div className="tv-group" role="group" aria-label={`${valueLabel} chart controls`}>
      <button type="button" className="tv-icon" title={`Zoom out ${horizontalLabel.toLowerCase()} (show more candles)`} aria-label={`Zoom out ${horizontalLabel.toLowerCase()}`} onClick={()=>zoomTime(2)}><svg viewBox="0 0 28 28" aria-hidden="true"><circle cx="12.5" cy="12.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.4"/><path d="M9.5 12.5h6M17.5 17.5l5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg></button>
      <button type="button" className="tv-icon" title={`Zoom in ${horizontalLabel.toLowerCase()}`} aria-label={`Zoom in ${horizontalLabel.toLowerCase()}`} onClick={()=>zoomTime(.5)}><svg viewBox="0 0 28 28" aria-hidden="true"><circle cx="12.5" cy="12.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.4"/><path d="M9.5 12.5h6M12.5 9.5v6M17.5 17.5l5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg></button>
      <button type="button" className="tv-icon" title={`Stretch ${valueLabel.toLowerCase()} scale`} aria-label={`Zoom in ${valueLabel.toLowerCase()}`} onClick={()=>zoomValue(.7)}><svg viewBox="0 0 28 28" aria-hidden="true"><path d="M14 5v18M10 9l4-4 4 4M10 19l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg></button>
      <button type="button" className="tv-icon" title={`Compress ${valueLabel.toLowerCase()} scale`} aria-label={`Zoom out ${valueLabel.toLowerCase()}`} onClick={()=>zoomValue(1/.7)}><svg viewBox="0 0 28 28" aria-hidden="true"><path d="M14 5v18M10 5l4 4 4-4M10 23l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg></button>
      <button type="button" className="tv-icon" title="Reset chart view" aria-label="Fit / reset" onClick={reset}><svg viewBox="0 0 28 28" aria-hidden="true"><path d="M7 14a7 7 0 1 0 2.2-5.1M7 6v4h4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg></button>
      <button type="button" className="tv-icon" title="Take a snapshot (download PNG)" aria-label="Take a snapshot" onClick={snapshot}><svg viewBox="0 0 28 28" aria-hidden="true"><path d="M5.5 10.5a2 2 0 0 1 2-2h2.3l1.7-2.5h5l1.7 2.5h2.3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/><circle cx="14" cy="14.5" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.4"/></svg></button>
      {onAnalyzePattern&&<i className="tv-divider chart-pattern-divider" aria-hidden="true"/>}
      {onAnalyzePattern&&<button type="button" className="tv-icon tv-pattern-analyze" aria-label={patternSelecting?"Cancel pattern selection":"Analyze pattern"} aria-pressed={patternSelecting} title="Select a candle range and find similar chart patterns" onClick={onAnalyzePattern}><svg viewBox="0 0 28 28" aria-hidden="true"><path d="M4 7V4h3M21 4h3v3M24 21v3h-3M7 24H4v-3M6 18l5-9 6 8 5-10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><g fill="currentColor"><circle cx="6" cy="18" r="1.5"/><circle cx="11" cy="9" r="1.5"/><circle cx="17" cy="17" r="1.5"/><circle cx="22" cy="7" r="1.5"/></g></svg></button>}
      {patternActions&&<><i className="tv-divider chart-pattern-divider" aria-hidden="true"/>{patternActions}</>}
      {!header&&(onEarlier||showEarlier)&&<button type="button" className="tv-icon" aria-label={loading?"Loading earlier candles":"Load earlier candles"} title="Load older candles" disabled={loading||!hasMore||!onEarlier} onClick={onEarlier}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5l-7 7 7 7M4 12h16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg></button>}
      {onFullscreen&&<button type="button" className="tv-icon" title={fullscreen?'Exit fullscreen':'Fullscreen mode'} aria-label={fullscreen?'Exit chart fullscreen':'Show chart fullscreen'} aria-pressed={fullscreen} onClick={onFullscreen}>{fullscreen?<svg viewBox="0 0 28 28" aria-hidden="true"><path d="M11 6v5H6M17 6v5h5M11 22v-5H6M17 22v-5h5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>:<svg viewBox="0 0 28 28" aria-hidden="true"><path d="M6 11V6h5M22 11V6h-5M6 17v5h5M22 17v5h-5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>}</button>}
    </div>
    {actions&&<div className="chart-navigation-tools">{actions}</div>}<div className="tv-spacer"/>
    {follow!==undefined&&onFollowChange&&<label className="tv-follow" title="Keep the latest candle in view"><input type="checkbox" checked={follow} onChange={event=>{onNavigate?.();onFollowChange(event.target.checked);if(event.target.checked)onLatest?.();}}/><i aria-hidden="true"/>Follow</label>}
    {endActions&&<div className="chart-toolbar-end">{endActions}</div>}
    {!header&&onLatest&&<button type="button" className="tv-text tv-latest" title="Scroll to the most recent bar" onClick={onLatest}>{endLabel}<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l5 5-5 5M11 5l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg></button>}
  </div>;
}

const STUDY_NAMES={zigzag:['Zig Zag','Swing highs and lows - percentage reversal'],ma:['MA','Simple moving average'],triplema:['Triple MA','Three moving averages · 20 / 50 / 100'],atr:['Average True Range','ATR · volatility'],adx:['Average Directional Index','ADX · trend strength'],rsi:['Relative Strength Index','RSI · momentum oscillator'],supertrend:['Supertrend','ATR trend overlay'],bollinger:['Bollinger Bands','BB · moving average and standard-deviation bands']} as const;

/** Small round button over the chart, like TradingView's "scroll to realtime". */
export function ScrollToLatest({onClick}:{onClick:()=>void}){
  return <button type="button" className="tv-scroll-latest" title="Scroll to the most recent bar" aria-label="Scroll to the most recent bar" onClick={onClick}><svg viewBox="0 0 18 18" aria-hidden="true"><path d="M4 4.5 8.5 9 4 13.5M9.5 4.5 14 9l-4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg></button>;
}

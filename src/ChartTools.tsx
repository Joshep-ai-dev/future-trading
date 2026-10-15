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

export default function ChartTools({chartRef,valueLabel='Price',horizontalLabel='Time',endLabel='Latest',onLatest,onEarlier,onNavigate,loading=false,hasMore=false,indicators,onToggleIndicator,follow,onFollowChange,showEarlier=false}: {
  chartRef: {current:IChartApi|null}; valueLabel?:string; onLatest?:()=>void;
  endLabel?:string;horizontalLabel?:string;
  onEarlier?:()=>void; loading?:boolean; hasMore?:boolean;
  onNavigate?:()=>void;
  indicators?:{atr:boolean;adx:boolean;rsi:boolean};onToggleIndicator?:(key:'atr'|'adx'|'rsi')=>void;
  follow?:boolean;onFollowChange?:(value:boolean)=>void;showEarlier?:boolean;
}) {
  function zoomTime(factor:number) {
    onNavigate?.();
    const scale=chartRef.current?.timeScale(), range=scale?.getVisibleLogicalRange();
    if(!scale||!range)return;
    const middle=(range.from+range.to)/2, span=Math.max(8,(range.to-range.from)*factor);
    scale.setVisibleLogicalRange({from:middle-span/2,to:middle+span/2});
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
  return <div className="chart-actions">
    <div className="chart-toolbar" role="group" aria-label={`${valueLabel} chart controls`}>
      <div><span>{horizontalLabel}</span><button className="secondary" type="button" aria-label={`Zoom in ${horizontalLabel.toLowerCase()}`} onClick={()=>zoomTime(.7)}>+</button><button className="secondary" type="button" aria-label={`Zoom out ${horizontalLabel.toLowerCase()}`} onClick={()=>zoomTime(1/.7)}>−</button></div>
      <div><span>{valueLabel}</span><button className="secondary" type="button" aria-label={`Zoom in ${valueLabel.toLowerCase()}`} onClick={()=>zoomValue(.7)}>+</button><button className="secondary" type="button" aria-label={`Zoom out ${valueLabel.toLowerCase()}`} onClick={()=>zoomValue(1/.7)}>−</button></div>
      <button className="secondary" type="button" onClick={reset}>Fit / reset</button>
      {onLatest&&<button className="secondary" type="button" onClick={onLatest}>{endLabel}</button>}
      {(onEarlier||showEarlier)&&<button className="secondary" type="button" disabled={loading||!hasMore||!onEarlier} onClick={onEarlier}>{loading?'Loading history…':hasMore?'Load earlier':'Load earlier'}</button>}
    </div>
    {indicators&&onToggleIndicator&&<div className="indicator-switch" role="group" aria-label="Chart indicators"><span>Indicators</span>{(['atr','adx','rsi'] as const).map(key=><button key={key} type="button" aria-pressed={indicators[key]} onClick={()=>onToggleIndicator(key)}>{key.toUpperCase()}</button>)}</div>}
    {follow!==undefined&&onFollowChange&&<label className="follow-toggle"><input type="checkbox" checked={follow} onChange={event=>{onNavigate?.();onFollowChange(event.target.checked);if(event.target.checked)onLatest?.();}}/> Follow price</label>}
  </div>;
}

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

export default function ChartTools({chartRef,valueLabel='Price',onLatest,onEarlier,loading=false,hasMore=false}: {
  chartRef: {current:IChartApi|null}; valueLabel?:string; onLatest?:()=>void;
  onEarlier?:()=>void; loading?:boolean; hasMore?:boolean;
}) {
  function zoomTime(factor:number) {
    const scale=chartRef.current?.timeScale(), range=scale?.getVisibleLogicalRange();
    if(!scale||!range)return;
    const middle=(range.from+range.to)/2, span=Math.max(8,(range.to-range.from)*factor);
    scale.setVisibleLogicalRange({from:middle-span/2,to:middle+span/2});
  }
  function zoomValue(factor:number) {
    const scale=chartRef.current?.priceScale('right'),range=scale?.getVisibleRange();
    if(!scale||!range)return;
    const middle=(range.from+range.to)/2,span=Math.max(.00001,(range.to-range.from)*factor);
    scale.setAutoScale(false);scale.setVisibleRange({from:middle-span/2,to:middle+span/2});
  }
  function reset() {
    chartRef.current?.priceScale('right').setAutoScale(true);
    chartRef.current?.timeScale().fitContent();
  }
  return <div className="chart-toolbar" role="group" aria-label={`${valueLabel} chart controls`}>
    <div><span>Time</span><button className="secondary" type="button" aria-label="Zoom in time" onClick={()=>zoomTime(.7)}>+</button><button className="secondary" type="button" aria-label="Zoom out time" onClick={()=>zoomTime(1/.7)}>−</button></div>
    <div><span>{valueLabel}</span><button className="secondary" type="button" aria-label={`Zoom in ${valueLabel.toLowerCase()}`} onClick={()=>zoomValue(.7)}>+</button><button className="secondary" type="button" aria-label={`Zoom out ${valueLabel.toLowerCase()}`} onClick={()=>zoomValue(1/.7)}>−</button></div>
    <button className="secondary" type="button" onClick={reset}>Fit / reset</button>
    {onLatest&&<button className="secondary" type="button" onClick={onLatest}>Latest</button>}
    {onEarlier&&<button className="secondary" type="button" disabled={loading||!hasMore} onClick={onEarlier}>{loading?'Loading history…':hasMore?'Load earlier':'Start of history'}</button>}
    <small>Scroll / pinch to zoom · drag to pan · drag lower-right corner to resize</small>
  </div>;
}

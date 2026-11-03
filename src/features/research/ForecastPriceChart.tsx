import {useEffect,useRef,useState} from 'react';
import {ColorType,CrosshairMode,LineSeries,LineStyle,createChart,type IChartApi,type ISeriesApi,type IPriceLine,type UTCTimestamp,type Time} from 'lightweight-charts';
import {fmt} from '../../shared/types/types';
export type PricePoint={time:number;close:number};
export type ForecastPoint={path?:PricePoint[];originTime:number;targetTime:number;originClose:number;predictedClose:number;predictedHigh:number;predictedLow:number};
const stamp=(time:Time)=>typeof time==='number'?new Date(time*1000).toISOString().replace('T',' ').slice(0,19):typeof time==='string'?time:`${time.year}-${time.month}-${time.day}`;
const ordered=(points:PricePoint[])=>[...new Map(points.filter(p=>Number.isFinite(p.time)&&Number.isFinite(p.close)).map(p=>[Math.floor(p.time),{time:Math.floor(p.time) as UTCTimestamp,value:p.close}])).values()].sort((a,b)=>a.time-b.time);

export default function ForecastPriceChart({history,actual=[],forecast,predictions=[]}:{history:PricePoint[];actual?:PricePoint[];forecast?:ForecastPoint;predictions?:PricePoint[]}){
  const host=useRef<HTMLDivElement>(null),frame=useRef<HTMLDivElement>(null),chart=useRef<IChartApi|null>(null),realSeries=useRef<ISeriesApi<'Line'>|null>(null),predictionSeries=useRef<ISeriesApi<'Line'>|null>(null),guides=useRef<IPriceLine[]>([]);
  const [span,setSpan]=useState(3600),[follow,setFollow]=useState(true),[showReal,setShowReal]=useState(true),[showPrediction,setShowPrediction]=useState(true),[showGuides,setShowGuides]=useState(false),[expanded,setExpanded]=useState(false),[readout,setReadout]=useState('Move the crosshair to compare actual and predicted prices.');
  const viewport=useRef({left:0,right:0,anchor:0});
  function resetView(seconds=span){const current=chart.current,range=viewport.current;if(!current||!range.left)return;if(seconds===0||range.right<=range.left)current.timeScale().fitContent();else current.timeScale().setVisibleRange({from:Math.max(range.left,range.anchor-seconds*.65) as UTCTimestamp,to:Math.min(range.right,range.anchor+seconds*.35) as UTCTimestamp});}
  useEffect(()=>{
    if(!host.current)return;
    const instance=createChart(host.current,{autoSize:true,layout:{background:{type:ColorType.Solid,color:'#0b111b'},textColor:'#94a3b8',fontFamily:'Inter, system-ui, sans-serif',fontSize:11},grid:{vertLines:{color:'#182331'},horzLines:{color:'#182331'}},crosshair:{mode:CrosshairMode.Normal,vertLine:{color:'#728198',labelBackgroundColor:'#34455d'},horzLine:{color:'#728198',labelBackgroundColor:'#34455d'}},rightPriceScale:{borderColor:'#263344',scaleMargins:{top:.12,bottom:.12}},timeScale:{borderColor:'#263344',timeVisible:true,secondsVisible:false,rightOffset:5,barSpacing:9,fixLeftEdge:false},localization:{timeFormatter:(time:Time)=>`${stamp(time)} UTC`},handleScroll:{mouseWheel:true,pressedMouseMove:true,horzTouchDrag:true,vertTouchDrag:false},handleScale:{mouseWheel:true,pinch:true,axisPressedMouseMove:true}});
    chart.current=instance;
    const options={lineStyle:LineStyle.Solid,lineWidth:2 as const,pointMarkersVisible:false,crosshairMarkerVisible:false,priceFormat:{type:'price' as const,precision:4,minMove:.0001},lastValueVisible:true,priceLineVisible:true};
    const real=instance.addSeries(LineSeries,{...options,color:'#42d5ac',title:'Actual'}),predicted=instance.addSeries(LineSeries,{...options,color:'#82aaff',title:'Forecast'});
    realSeries.current=real;predictionSeries.current=predicted;
    instance.subscribeCrosshairMove(event=>{if(!event.time){setReadout('Move the crosshair to compare actual and predicted prices.');return;}const observed=event.seriesData.get(real),estimate=event.seriesData.get(predicted);const a=observed&&'value' in observed?observed.value:null,p=estimate&&'value' in estimate?estimate.value:null;setReadout(`${stamp(event.time)} UTC | Actual ${a==null?'-':fmt(a,4)} | Prediction ${p==null?'-':fmt(p,4)}${a!=null&&p!=null?` | Difference ${fmt(p-a,4)}`:''}`);});
    return()=>{instance.remove();chart.current=null;realSeries.current=null;predictionSeries.current=null;guides.current=[];};
  },[]);
  useEffect(()=>{
    const instance=chart.current,real=realSeries.current,predicted=predictionSeries.current;if(!instance||!real||!predicted)return;
    // Display the latest live quote within each candle interval, rather than
    // making every polled tick a separate equal-width chart bar.
    const gaps=history.slice(1).map((point,index)=>point.time-history[index].time).filter(value=>value>=60).sort((a,b)=>a-b);
    const interval=gaps[Math.floor(gaps.length/2)]||300,anchor=forecast?.originTime||history.at(-1)?.time||0;
    const liveBuckets=new Map<number,PricePoint>();for(const point of actual)liveBuckets.set(Math.floor((point.time-anchor)/interval),point);
    const realData=ordered([...history,...liveBuckets.values()]);
    const predictionPoints=[...predictions,...(forecast?.path||[])];
    if(forecast&&!predictions.some(point=>point.time===forecast.originTime))predictionPoints.push({time:forecast.originTime,close:forecast.originClose});
    if(forecast&&!forecast.path?.length)predictionPoints.push({time:forecast.targetTime,close:forecast.predictedClose});
    const predictedData=ordered(predictionPoints);
    real.setData(realData);predicted.setData(predictedData);
    real.applyOptions({visible:showReal});predicted.applyOptions({visible:showPrediction});
    for(const guide of guides.current)predicted.removePriceLine(guide);guides.current=[];
    if(showGuides&&forecast)for(const [price,title] of [[forecast.predictedHigh,'Est. high'],[forecast.predictedLow,'Est. low']] as const)guides.current.push(predicted.createPriceLine({price,title,color:'#647baf',lineWidth:1,lineStyle:LineStyle.Dashed,axisLabelVisible:true}));
    const times=[...realData,...predictedData].map(point=>Number(point.time));if(times.length){viewport.current={left:Math.min(...times),right:Math.max(...times),anchor};if(follow)resetView();}
  },[history,actual,forecast,predictions,span,follow,showReal,showPrediction,showGuides]);
  return <div ref={frame} className={`forecast-terminal-chart ${expanded?'is-expanded':''}`}>
    <div className="forecast-terminal-toolbar"><div className="forecast-chart-symbol"><strong>XAG / USDT</strong><span>OKX | Silver perpetual</span></div><div className="forecast-chart-periods" role="group" aria-label="Chart time range">{[[900,'15m'],[1800,'30m'],[3600,'1h'],[7200,'2h'],[86400,'1D'],[0,'All']].map(([value,label])=><button type="button" key={value} aria-pressed={span===value} onClick={()=>{setSpan(Number(value));setFollow(true);}}>{label}</button>)}</div><div className="forecast-chart-actions"><button type="button" aria-pressed={follow} onClick={()=>{setFollow(true);resetView();}}>Follow</button><button type="button" onClick={()=>{setSpan(0);setFollow(true);resetView(0);}}>Fit</button><button type="button" aria-pressed={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?'Collapse':'Expand'}</button></div></div>
    <div className="forecast-terminal-legend"><button type="button" aria-pressed={showReal} className="forecast-actual" onClick={()=>setShowReal(!showReal)}><i/>Actual price</button><button type="button" aria-pressed={showPrediction} className="forecast-predicted" onClick={()=>setShowPrediction(!showPrediction)}><i/>Prediction</button><label className="forecast-guides-toggle"><input type="checkbox" checked={showGuides} onChange={event=>setShowGuides(event.target.checked)}/> Range guides</label><span>UTC | USDT</span></div>
    <div className="forecast-crosshair-readout" role="status">{readout}</div>
    <div ref={host} className="forecast-chart-canvas" onPointerDown={()=>setFollow(false)} onWheel={()=>setFollow(false)}/>
    <div className="forecast-chart-status"><span>{follow?'Following latest prices':'Manual view | drag to pan'} | Scroll to zoom | Drag price scale to resize</span><span>{forecast?`Forecast target ${stamp(forecast.targetTime as UTCTimestamp)} UTC`:'Historical prediction comparison'}</span></div>
  </div>;
}

import {StopOverlay} from './StopOverlay';
import {useEffect,useRef,useState} from 'react';
import {CandlestickSeries,ColorType,createChart,createSeriesMarkers,LineSeries,type IChartApi,type UTCTimestamp,type SeriesMarker} from 'lightweight-charts';
import {fillMarker,FillLabels} from './fillMarkers';
import ChartTools,{chartInteraction,resizeChart} from './ChartTools';
import {fmt,type Analysis} from './types';
import type {PaperTrade,Position} from './PaperTrading';

type Point={time:number;bbBasis:number|null;bbUpper:number|null;bbLower:number|null;trendSma:number|null};
type Data={candles:Analysis['candles'];indicators:Point[];stops:{time:number;price:number|null}[];trades:PaperTrade[];position:Position|null};
type Props=Data&{sessionId:number;showSma:boolean};

export default function PaperPriceChart(props:Props) {
  const container=useRef<HTMLDivElement>(null),chartRef=useRef<IChartApi|null>(null);
  const update=useRef<(data:Data)=>void>(()=>{});
  const following=useRef(true),count=useRef(0);
  const [follow,setFollow]=useState(true),[readout,setReadout]=useState('Hover for candle time and prices.');
  function latest(){following.current=true;setFollow(true);chartRef.current?.timeScale().setVisibleLogicalRange({from:Math.max(0,count.current-150),to:count.current+5});}
  useEffect(()=>{
    if(!container.current)return;
    following.current=true;setFollow(true);
    const chart=createChart(container.current,{autoSize:false,...chartInteraction,layout:{background:{type:ColorType.Solid,color:'#10141d'},textColor:'#7d8da5'},timeScale:{timeVisible:true,minBarSpacing:.001,lockVisibleTimeRangeOnResize:true},grid:{vertLines:{visible:false},horzLines:{color:'#202836'}}});
    chartRef.current=chart;
    const price=chart.addSeries(CandlestickSeries,{borderVisible:false,upColor:'#26a69a',downColor:'#ef5350',wickUpColor:'#26a69a',wickDownColor:'#ef5350',priceFormat:{type:'price',precision:3,minMove:.001}});
    price.priceScale().applyOptions({scaleMargins:{top:.18,bottom:.22}});
    const markers=createSeriesMarkers(price,[]);
    const fillLabels=new FillLabels();price.attachPrimitive(fillLabels);
    const overlays=([['bbBasis','#63d6d0','BB middle'],['bbUpper','#7d8da5','BB upper'],['bbLower','#7d8da5','BB lower'],['trendSma','#d7ad69','Trend SMA']] as const).filter(([key])=>key!=='trendSma'||props.showSma).map(([key,color,title])=>({key,series:chart.addSeries(LineSeries,{color,lineWidth:1,title,priceLineVisible:false,lastValueVisible:false})}));
    const stopOverlay=new StopOverlay();price.attachPrimitive(stopOverlay);
    const entry=chart.addSeries(LineSeries,{color:'#88bfff',lineWidth:2,title:'Open entry',priceLineVisible:false});
    let byTime=new Map<number,Analysis['candles'][number]>(),previousTime:number|undefined,previous:Data|null=null;
    let fillReadouts=new Map<number,string[]>();
    update.current=data=>{
      const visible=chart.timeScale().getVisibleRange();
      byTime=new Map(data.candles.map(c=>[c.time,c]));count.current=data.candles.length;
      const stamp=data.candles.at(-1)?.time;
      if(previous&&stamp===previousTime&&data.candles.length===previous.candles.length&&data.candles.length){const last=data.candles.at(-1)!;price.update({...last,time:last.time as UTCTimestamp});}
      else price.setData(data.candles.map(c=>({...c,time:c.time as UTCTimestamp})));
      if(!previous||data.indicators.at(-1)!==previous.indicators.at(-1)||data.indicators.length!==previous.indicators.length)
        for(const {key,series} of overlays)series.setData(data.indicators.map(p=>p[key]===null?{time:p.time as UTCTimestamp}:{time:p.time as UTCTimestamp,value:p[key]}));
      const p=data.position,first=data.candles[0]?.time;
      if(p&&stamp!==undefined&&first!==undefined){
        const from=Math.max(first,p.entry_time);
        entry.setData((from===stamp?[from]:[from,stamp]).map(time=>({time:time as UTCTimestamp,value:p.entry_price})));
      }else entry.setData([]);
      stopOverlay.setPaths([...data.trades,...(p?[p]:[])].map(t=>{
        const to='exit_time' in t?Number(t.exit_time):stamp??t.entry_time;
        const initial=t.initial_stop??t.stop;
        const fallback=[{time:t.entry_time,price:initial,reason:'initial'},...data.stops.filter(h=>h.time>t.entry_time&&h.time<to&&h.price!==null).map(h=>({time:h.time,price:h.price!,reason:h.price===initial?'initial':'trailing'}))];
        return {from:t.entry_time,to,history:t.stop_history??fallback};
      }),first,stamp);
      const points:SeriesMarker<UTCTimestamp>[]=[];
      const addEntry=(position:Position,label:string,id:string)=>{if(byTime.has(position.entry_time))points.push(fillMarker(position.entry_time,position.entry_price,label,'entry',position.direction,id,position.quantity));};
      for(const t of data.trades){
        addEntry(t,`${t.direction===1?'BUY':'SELL'} #${t.id}`,`entry-${t.id}`);
        if(byTime.has(t.exit_time))points.push(fillMarker(t.exit_time,t.exit_price,`CLOSE #${t.id}`,'close',t.direction,`close-${t.id}`,t.quantity));
      }
      if(p)addEntry(p,`${p.direction===1?'BUY':'SELL'} OPEN`,'entry-open');
      fillReadouts=new Map();
      for(const point of points){const time=Number(point.time);fillReadouts.set(time,[...(fillReadouts.get(time)??[]),point.text!.replaceAll("\n"," ")]);}
      fillLabels.setMarkers(points,data.candles);
      markers.setMarkers(points.sort((a,b)=>Number(a.time)-Number(b.time)).map(m=>({...m,text:undefined,size:0})));
      if(following.current&&(stamp!==previousTime||previousTime===undefined))chart.timeScale().setVisibleLogicalRange({from:Math.max(0,count.current-150),to:count.current+5});
      else if(!following.current&&visible)chart.timeScale().setVisibleRange(visible);
      previousTime=stamp;previous=data;
    };
    chart.subscribeCrosshairMove(event=>{
      const c=typeof event.time==='number'?byTime.get(event.time):undefined;
      if(c)setReadout(`${new Date(c.time*1000).toISOString()} · O ${fmt(c.open,3)} H ${fmt(c.high,3)} L ${fmt(c.low,3)} C ${fmt(c.close,3)}${fillReadouts.has(c.time)?` | ${fillReadouts.get(c.time)!.join(" | ")}`:""}`);
    });
    const stopResize=resizeChart(chart,container.current,()=>{if(following.current)latest();});
    return ()=>{stopResize();update.current=()=>{};chartRef.current=null;chart.remove();};
  },[props.sessionId,props.showSma]);
  useEffect(()=>{update.current(props);},[props]);
  return <><div className="chart-actions"><ChartTools chartRef={chartRef} onLatest={latest}/><label className="follow-toggle"><input type="checkbox" checked={follow} onChange={e=>{following.current=e.target.checked;setFollow(e.target.checked);if(e.target.checked)latest();}}/> Follow price</label></div><p className="readout">{readout}</p><div className="chart-resize"><div ref={container} className="chart-container position-chart" aria-label="Virtual bot price chart with buys, sells, exits and trailing stops"/></div></>;
}

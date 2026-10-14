import IndicatorSettings,{readIndicatorSettings,type IndicatorConfig} from './IndicatorSettings';
import {AdxDecoration,displayAdx} from './adxDisplay';
import {chartOscillators} from './chartOscillators';
import {TIMEFRAMES} from './chartTimeframe';
import {StopOverlay} from './StopOverlay';
import {api} from './api';
import {mergeHistory} from './candleHistory';
import {candleLogical,captureViewport,restoreViewport} from './chartViewport';
import {useEffect,useRef,useState} from 'react';
import {CandlestickSeries,ColorType,createChart,createSeriesMarkers,LineSeries,LineStyle,type ISeriesApi,type IChartApi,type UTCTimestamp,type SeriesMarker} from 'lightweight-charts';
import {fillMarker,FillLabels} from './fillMarkers';
import ChartTools,{chartInteraction,resizeChart} from './ChartTools';
import {fmt,type Analysis} from './types';
import type {PaperTrade,Position} from './PaperTrading';

type Point={time:number;bbBasis:number|null;bbUpper:number|null;bbLower:number|null;trendSma:number|null};
type Data={candles:Analysis['candles'];indicators:Point[];stops:{time:number;price:number|null}[];trades:PaperTrade[];position:Position|null;indicatorClock:number};
type Props=Data&{sessionId:number;showSma:boolean;timeframe:string;atrLength:number;adxLength:number};

export default function PaperPriceChart(props:Props) {
  const container=useRef<HTMLDivElement>(null),chartRef=useRef<IChartApi|null>(null);
  const update=useRef<(data:Data)=>void>(()=>{});
  const [selectedIndicators,setSelectedIndicators]=useState<{atr:boolean;adx:boolean}>(()=>{try{const saved=JSON.parse(localStorage.getItem('silver.chart.oscillators')??'{}');return {atr:saved.atr===true,adx:saved.adx===true};}catch{return {atr:false,adx:false};}});
  const [indicatorConfig,setIndicatorConfig]=useState(readIndicatorSettings),[settingsOpen,setSettingsOpen]=useState(false);
  const configRef=useRef(indicatorConfig);configRef.current=indicatorConfig;
  function applyIndicatorConfig(config:IndicatorConfig){setIndicatorConfig(config);try{localStorage.setItem('silver.chart.indicatorSettings',JSON.stringify(config));}catch{}}
  const changePanels=useRef<(selection:{atr:boolean;adx:boolean},config:IndicatorConfig)=>void>(()=>{});
  function toggleIndicator(key:'atr'|'adx'){setSelectedIndicators(old=>{const next={...old,[key]:!old[key]};try{localStorage.setItem('silver.chart.oscillators',JSON.stringify(next));}catch{}return next;});}
  const loadEarlier=useRef<()=>void>(()=>{});
  const [loading,setLoading]=useState(false),[hasMore,setHasMore]=useState(true),[historyError,setHistoryError]=useState('');
  const following=useRef(true),lastTime=useRef<number|undefined>(undefined);
  const [follow,setFollow]=useState(true),[readout,setReadout]=useState('Hover for candle time and prices.');
  function holdView(){following.current=false;setFollow(false);}
  function latest(){
    following.current=true;setFollow(true);
    const chart=chartRef.current;if(!chart)return;
    const index=candleLogical(chart,lastTime.current);if(index===null)return;
    const range=chart.timeScale().getVisibleLogicalRange(),span=range?range.to-range.from:155;
    chart.timeScale().setVisibleLogicalRange({from:index+6-span,to:index+6});
  }
  useEffect(()=>{
    if(!container.current)return;
    following.current=true;setFollow(true);
    const chart=createChart(container.current,{autoSize:false,...chartInteraction,layout:{background:{type:ColorType.Solid,color:'#10141d'},textColor:'#7d8da5'},timeScale:{timeVisible:true,minBarSpacing:2,rightOffset:6,fixRightEdge:false,lockVisibleTimeRangeOnResize:true,shiftVisibleRangeOnNewBar:false,allowShiftVisibleRangeOnWhitespaceReplacement:false},grid:{vertLines:{visible:false},horzLines:{color:'#202836'}}});
    chartRef.current=chart;
    const price=chart.addSeries(CandlestickSeries,{borderVisible:false,upColor:'#26a69a',downColor:'#ef5350',wickUpColor:'#26a69a',wickDownColor:'#ef5350',priceFormat:{type:'price',precision:3,minMove:.001}});
    price.priceScale().applyOptions({scaleMargins:{top:.18,bottom:.22}});
    const markers=createSeriesMarkers(price,[]);
    const fillLabels=new FillLabels();price.attachPrimitive(fillLabels);
    const overlays=([['bbBasis','#63d6d0','BB middle'],['bbUpper','#7d8da5','BB upper'],['bbLower','#7d8da5','BB lower'],['trendSma','#d7ad69','Trend SMA']] as const).filter(([key])=>key!=='trendSma'||props.showSma).map(([key,color,title])=>({key,series:chart.addSeries(LineSeries,{color,lineWidth:1,title,priceLineVisible:false,lastValueVisible:false})}));
    const stopOverlay=new StopOverlay();price.attachPrimitive(stopOverlay);
    const entry=chart.addSeries(LineSeries,{color:'#88bfff',lineWidth:2,title:'Open entry',priceLineVisible:false});
    let oscillatorData:ReturnType<typeof chartOscillators>=[],oscillatorKey='',panelConfig=configRef.current;
    const oscillatorSeries=new Map<'atr'|'adx',ISeriesApi<'Line'>>();
    let adxHalo:ISeriesApi<'Line'>|null=null,adxDecoration:AdxDecoration|null=null;
    function paintOscillators(){
      for(const [key,series] of oscillatorSeries){
        if(key==='atr')series.setData(oscillatorData.map(p=>p.atr===null?{time:p.time as UTCTimestamp}:{time:p.time as UTCTimestamp,value:p.atr}));
        else{
          const displayed=displayAdx(oscillatorData,panelConfig.displaySmoothing);
          series.setData(displayed.map(p=>p.display===null?{time:p.time as UTCTimestamp}:{time:p.time as UTCTimestamp,value:p.display,color:p.color}));
          adxHalo?.setData(displayed.map(p=>p.display===null?{time:p.time as UTCTimestamp}:{time:p.time as UTCTimestamp,value:p.display,color:p.color+'26'}));
          adxDecoration?.update(oscillatorData.at(-1)?.adx??null,oscillatorData.at(-2)?.adx??null);
        }
      }
    }
    changePanels.current=(selection,config)=>{
      const viewport=captureViewport(chart,lastTime.current);
      panelConfig=config;oscillatorKey='';
      if(adxHalo){chart.removeSeries(adxHalo);adxHalo=null;}adxDecoration=null;
      for(const series of oscillatorSeries.values())chart.removeSeries(series);
      oscillatorSeries.clear();
      for(const key of ['atr','adx'] as const)if(selection[key]){
        const pane=chart.panes().length;
        if(key==='adx')adxHalo=chart.addSeries(LineSeries,{color:'#90a4ae26',lineWidth:4,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false},pane);
        const series=chart.addSeries(LineSeries,{color:key==='atr'?'#38d9ff':'#90a4ae',lineWidth:key==='atr'?2:3,title:key==='atr'?`ATR (${config.atrLength}, ${config.atrSmoothing})`:`ADX (${config.adxLength})`,priceLineVisible:false,priceFormat:{type:'price',precision:key==='atr'?3:2,minMove:key==='atr'?.001:.01}},pane);
        series.priceScale().applyOptions({scaleMargins:{top:.23,bottom:.12}});oscillatorSeries.set(key,series);
        if(key==='adx'){
          for(const [value,color,title,style] of [[20,'#90a4aea6','20 Weak',LineStyle.Dotted],[25,'#26a69acc','25 Trend',LineStyle.Dashed],[config.adxThreshold,'#ff40ff','Entry',LineStyle.Dashed]] as const)
            series.createPriceLine({price:value,color,title,lineStyle:style,lineWidth:1,axisLabelVisible:true});
          adxDecoration=new AdxDecoration(config.showStatus,config.adxThreshold);series.attachPrimitive(adxDecoration);
        }
      }
      chart.panes().forEach((pane,index)=>pane.setStretchFactor(index===0?3:1));
      if(latestData)update.current(latestData);else paintOscillators();
      restoreViewport(chart,viewport,lastTime.current,false);
    };
    let byTime=new Map<number,Analysis['candles'][number]>(),previousTime:number|undefined,previous:Data|null=null;
    let cached:Data['candles']=[],indicators:Point[]=[],latestData:Data|null=null;
    let pending=false,more=true,failed=false,disposed=false,timer:ReturnType<typeof setTimeout>|undefined;
    const abort=new AbortController();
    setLoading(false);setHasMore(true);setHistoryError('');
    async function earlier(){
      const before=cached[0]?.time;
      if(pending||!more||before===undefined||!latestData)return;
      pending=true;failed=false;setLoading(true);setHistoryError('');
      try{
        const page=await api<{candles:Data['candles'];hasMore:boolean}>('/api/candles',{method:'POST',headers:{'Content-Type':'application/json'},signal:abort.signal,body:JSON.stringify({timeframe:props.timeframe,before,limit:1000})});
        if(disposed)return;
        const older=page.candles.filter(c=>c.time<before);
        cached=mergeHistory(older,cached);
        more=page.hasMore&&older.length>0;setHasMore(more);
        update.current(latestData);
        chart.timeScale().applyOptions({fixLeftEdge:!more});
      }catch(error){if(!disposed){failed=true;setHistoryError(`Could not load earlier candles: ${String(error)}`);}}
      finally{pending=false;if(!disposed){setLoading(false);scheduleHistory();}}
    }
    function scheduleHistory(){
      if(timer)clearTimeout(timer);
      timer=setTimeout(()=>{
        if(disposed||pending||!more||failed)return;
        const range=chart.timeScale().getVisibleLogicalRange(),first=candleLogical(chart,cached[0]?.time);
        if(range&&first!==null&&range.from<first+100)void earlier();
      },150);
    }
    loadEarlier.current=()=>{void earlier();};
    chart.timeScale().subscribeVisibleLogicalRangeChange(scheduleHistory);
    let fillReadouts=new Map<number,string[]>();
    update.current=data=>{
      latestData=data;
      const viewport=captureViewport(chart,previousTime);
      cached=mergeHistory(cached,data.candles);
      indicators=mergeHistory(indicators,data.indicators);
      data={...data,candles:cached,indicators};
      byTime=new Map(data.candles.map(c=>[c.time,c]));
      const stamp=data.candles.at(-1)?.time;
      if(previous&&stamp===previousTime&&data.candles.length===previous.candles.length&&data.candles.length){const last=data.candles.at(-1)!;price.update({...last,time:last.time as UTCTimestamp});}
      else price.setData(data.candles.map(c=>({...c,time:c.time as UTCTimestamp})));
      if(!previous||data.indicators.at(-1)!==previous.indicators.at(-1)||data.indicators.length!==previous.indicators.length)
        for(const {key,series} of overlays)series.setData(data.indicators.map(p=>p[key]===null?{time:p.time as UTCTimestamp}:{time:p.time as UTCTimestamp,value:p[key]}));
      const duration=TIMEFRAMES[props.timeframe as keyof typeof TIMEFRAMES];
      const completed=data.candles.filter(c=>c.time+duration<=data.indicatorClock);
      const nextKey=`${completed.length}:${completed[0]?.time}:${completed.at(-1)?.time}`;
      if(nextKey!==oscillatorKey){oscillatorKey=nextKey;oscillatorData=chartOscillators(completed,duration,panelConfig.atrLength,panelConfig.adxLength,panelConfig.atrSmoothing);paintOscillators();}
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
        if(byTime.has(t.exit_time))points.push(fillMarker(t.exit_time,t.exit_price,`CLOSE #${t.id}`,'close',t.direction,`close-${t.id}`,t.quantity,t.pnl));
      }
      if(p)addEntry(p,`${p.direction===1?'BUY':'SELL'} OPEN`,'entry-open');
      fillReadouts=new Map();
      for(const point of points){const time=Number(point.time);fillReadouts.set(time,[...(fillReadouts.get(time)??[]),point.text!.replaceAll("\n"," ")]);}
      fillLabels.setMarkers(points,data.candles);
      markers.setMarkers(points.sort((a,b)=>Number(a.time)-Number(b.time)).map(m=>({...m,text:undefined,size:0})));
      lastTime.current=stamp;
      if(previousTime===undefined&&stamp!==undefined){
        const index=candleLogical(chart,stamp);
        if(index!==null)chart.timeScale().setVisibleLogicalRange({from:Math.max(0,index-149),to:index+6});
      }else restoreViewport(chart,viewport,stamp,following.current);
      previousTime=stamp;previous=data;
    };
    chart.subscribeCrosshairMove(event=>{
      const c=typeof event.time==='number'?byTime.get(event.time):undefined;
      const oscillator=c?oscillatorData.find(p=>p.time===c.time):undefined;
      const indicatorReadout=oscillator?[...oscillatorSeries.keys()].map(key=>` | ${key.toUpperCase()} ${fmt(oscillator[key],key==='atr'?3:2)}`).join(''):'';
      if(c)setReadout(`${new Date(c.time*1000).toISOString()} · O ${fmt(c.open,3)} H ${fmt(c.high,3)} L ${fmt(c.low,3)} C ${fmt(c.close,3)}${indicatorReadout}${fillReadouts.has(c.time)?` | ${fillReadouts.get(c.time)!.join(" | ")}`:""}`);
    });
    const stopResize=resizeChart(chart,container.current,()=>{if(following.current)latest();});
    return ()=>{disposed=true;abort.abort();if(timer)clearTimeout(timer);chart.timeScale().unsubscribeVisibleLogicalRangeChange(scheduleHistory);stopResize();changePanels.current=()=>{};loadEarlier.current=()=>{};update.current=()=>{};chartRef.current=null;chart.remove();};
  },[props.sessionId,props.showSma,props.timeframe]);
  useEffect(()=>{update.current(props);},[props]);
  useEffect(()=>{changePanels.current(selectedIndicators,indicatorConfig);},[selectedIndicators,indicatorConfig,props.sessionId,props.showSma,props.timeframe]);
  return <><div className="chart-actions"><ChartTools chartRef={chartRef} onLatest={latest} onNavigate={holdView} onEarlier={()=>loadEarlier.current()} loading={loading} hasMore={hasMore}/><div className="indicator-switch" role="group" aria-label="Chart indicators"><span>Indicators</span>{(['atr','adx'] as const).map(key=><button key={key} type="button" aria-pressed={selectedIndicators[key]} onClick={()=>toggleIndicator(key)}>{key.toUpperCase()}</button>)}<button type="button" aria-expanded={settingsOpen} aria-controls="chart-indicator-settings" onClick={()=>setSettingsOpen(!settingsOpen)}>Settings</button></div><label className="follow-toggle"><input type="checkbox" checked={follow} onChange={e=>{following.current=e.target.checked;setFollow(e.target.checked);if(e.target.checked)latest();}}/> Follow price</label></div>{settingsOpen&&<div id="chart-indicator-settings"><IndicatorSettings value={indicatorConfig} onApply={applyIndicatorConfig} onClose={()=>setSettingsOpen(false)}/></div>}<p className="readout">{readout}</p>{historyError&&<p className="chart-history-status error" role="alert">{historyError} <button type="button" className="text-button" onClick={()=>loadEarlier.current()}>Retry</button></p>}<div className="chart-history-status" role="status">{loading?"Loading earlier candles...":hasMore?"Pan left to load history":"Beginning of available history"}<span>Pan right for newer candles ? Latest returns to the current price</span></div><div className="chart-resize"><div ref={container} onWheelCapture={holdView} onPointerDownCapture={holdView} className="chart-container position-chart" aria-label="Virtual bot price chart with buys, sells, exits and trailing stops"/></div></>;
}

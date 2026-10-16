import {StopOverlay} from './StopOverlay';
import {useEffect, useRef, useState} from 'react';
import {CandlestickSeries, ColorType, createChart, createSeriesMarkers, HistogramSeries, LineSeries, BaselineSeries, LineStyle, LineType, type IChartApi, type ISeriesApi, type UTCTimestamp, type SeriesMarker} from 'lightweight-charts';
import {fillMarker,FillLabels} from './fillMarkers';
import ChartTools,{chartInteraction,resizeChart} from './ChartTools';
import {captureViewport,restoreViewport} from './chartViewport';
import {chartTimeOptions,formatChartTime,readChartTimeZone,useChartTimeZone} from './chartTimeZone';
import {chartOscillators} from './chartOscillators';
import IndicatorSettings,{useIndicatorSettings,type IndicatorKind} from './IndicatorSettings';
import {useChartIndicatorSelection,toggleChartIndicator} from './chartIndicatorSelection';
import {fmt, type Analysis, type PeriodResult, type Trade, type IndicatorPoint, type BacktestSettings} from '../types/types';
import {chartVolume} from './chartVolume';
import {indicatorColor} from './indicatorColors';
import {displayAdx} from './adxDisplay';
import IndicatorHeader from './IndicatorHeader';

export function EquityChart({period,initialValue=0,trades}: {
  period: Pick<PeriodResult,'name'>; initialValue?:number; trades:{pnl:number}[];
}) {
  const fullscreenRef=useRef<HTMLDivElement>(null);
  const [fullscreen,setFullscreen]=useState(false);
  const [fullscreenError,setFullscreenError]=useState('');
  async function toggleFullscreen(){
    setFullscreenError('');
    try{
      if(document.fullscreenElement===fullscreenRef.current)await document.exitFullscreen();
      else if(fullscreenRef.current?.requestFullscreen)await fullscreenRef.current.requestFullscreen();
      else setFullscreenError('Fullscreen is unavailable in this browser.');
    }catch{setFullscreenError('The browser blocked fullscreen. Try opening the app in a browser tab.');}
  }
  useEffect(()=>{
    const changed=()=>setFullscreen(document.fullscreenElement===fullscreenRef.current);
    document.addEventListener('fullscreenchange',changed);
    return ()=>document.removeEventListener('fullscreenchange',changed);
  },[]);
  useEffect(()=>{
    const frame=requestAnimationFrame(()=>chartRef.current?.timeScale().fitContent());
    return ()=>cancelAnimationFrame(frame);
  },[fullscreen]);
  const ref=useRef<HTMLDivElement>(null);
  const chartRef=useRef<IChartApi|null>(null);
  const lineRef=useRef<ISeriesApi<'Line'>|null>(null);
  const hasData=useRef(false);
  const tradeLabel=(time:unknown)=>Number(time)===86400?'Start':`Trade #${Math.round(Number(time)/86400)-1}`;
  useEffect(()=>{
    if(!ref.current)return;
    const chart=createChart(ref.current,{autoSize:false,...chartInteraction,
      localization:{timeFormatter:tradeLabel},
      layout:{background:{type:ColorType.Solid,color:'#12161c'},textColor:'#7d8da5'},
      rightPriceScale:{scaleMargins:{top:.16,bottom:.16},borderColor:'#263246'},
      timeScale:{timeVisible:false,minBarSpacing:.2,lockVisibleTimeRangeOnResize:true,tickMarkMaxCharacterLength:5,tickMarkFormatter:(time:unknown)=>Number(time)===86400?'Start':`#${Math.round(Number(time)/86400)-1}`},
      grid:{vertLines:{visible:false},horzLines:{color:'#1b2028'}}});
    chartRef.current=chart;
    lineRef.current=chart.addSeries(LineSeries,{color:'#6ce4bc',lineWidth:2,priceLineVisible:false,lastValueVisible:false,
      crosshairMarkerVisible:true,priceFormat:{type:'price',precision:2,minMove:.01},title:''});
    const stopResize=resizeChart(chart,ref.current,()=>chart.timeScale().fitContent());
    return ()=>{stopResize();lineRef.current=null;chartRef.current=null;hasData.current=false;chart.remove();};
  },[]);
  useEffect(()=>{
    let balance=initialValue;
    const points=[{time:86400 as UTCTimestamp,value:balance},...trades.map((trade,index)=>{
      balance+=trade.pnl;
      return {time:((index+2)*86400) as UTCTimestamp,value:balance};
    })];
    lineRef.current?.setData(points);
    if(!hasData.current&&trades.length){chartRef.current?.timeScale().fitContent();hasData.current=true;}
  },[trades,initialValue]);
  return <div className="balance-chart-shell" ref={fullscreenRef}>{fullscreen&&<div className="balance-fullscreen-heading"><h2>Balance by trade</h2><span>Press Esc to return</span></div>}<ChartTools chartRef={chartRef} valueLabel="Amount" horizontalLabel="Trades" fullscreen={fullscreen} onFullscreen={()=>void toggleFullscreen()}/>{fullscreenError&&<p role="alert">{fullscreenError}</p>}<div className="chart-resize equity-resize"><div ref={ref} className="chart-container equity-chart" aria-label={`${period.name} account balance after each closed trade, including trading costs`}/></div></div>;
}

export default function BacktestChart({candles,trades,selected,onSelect,indicators,barSeconds,timeframe,indicatorSettings}: {indicatorSettings: BacktestSettings; indicators: IndicatorPoint[]; barSeconds: number; timeframe: string; candles: Analysis['candles']; trades: Trade[]; selected: Trade | null; onSelect: (trade: Trade)=>void}) {
  const timeZone=useChartTimeZone();
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi|null>(null);
  const viewportRef = useRef<{dataKey:string;selectedId:number|null;viewport:ReturnType<typeof captureViewport>}|null>(null);
  const onSelectRef = useRef(onSelect);onSelectRef.current=onSelect;
  const [readout,setReadout] = useState('Hover for candle time and prices.');
  const selectedIndicators=useChartIndicatorSelection();
  const [follow,setFollow]=useState(true);
  const [strategyVisible,setStrategyVisible]=useState(true);
  const [indicatorConfig,setIndicatorConfig]=useIndicatorSettings();
  const [settingsOpen,setSettingsOpen]=useState<IndicatorKind|null>(null);
  const [paneHeaders,setPaneHeaders]=useState<{kind:IndicatorKind;top:number}[]>([]);
  const [paneValues,setPaneValues]=useState<Record<IndicatorKind,number|null>>({atr:null,adx:null,rsi:null});
  const [hiddenIndicators,setHiddenIndicators]=useState<Record<IndicatorKind,boolean>>({atr:false,adx:false,rsi:false});
  const indicatorSeries=useRef(new Map<IndicatorKind,ISeriesApi<'Line'>>());
  function toggleIndicator(key:'atr'|'adx'|'rsi'){
    toggleChartIndicator(key);
  }
  function latest(){setFollow(true);chartRef.current?.timeScale().setVisibleLogicalRange({from:Math.max(0,candles.length-180),to:candles.length+5});}
  function holdView(){setFollow(false);}
  useEffect(()=>{
    if (!ref.current || !candles.length) return;
    const dataKey=`${candles.length}:${candles[0]?.time}:${candles.at(-1)?.time}`;
    const saved=viewportRef.current?.dataKey===dataKey?viewportRef.current:null;
    const newlySelected=selected!==null&&selected.id!==saved?.selectedId;
    const focus = selected ? candles.findIndex(c=>c.time>=selected.signalTime) : -1;
    const exit = selected ? candles.findIndex(c=>c.time>=selected.exitTime) : -1;
    const view = candles;
    const chart = createChart(ref.current,{autoSize:false,...chartInteraction,localization:chartTimeOptions(readChartTimeZone()).localization,layout:{background:{type:ColorType.Solid,color:'#12161c'},textColor:'#7d8da5'},timeScale:{timeVisible:true,minBarSpacing:.2,lockVisibleTimeRangeOnResize:true,...chartTimeOptions(readChartTimeZone()).timeScale},grid:{vertLines:{visible:false},horzLines:{color:'#1b2028'}}});
    chartRef.current=chart;
    const price = chart.addSeries(CandlestickSeries,{borderVisible:false,upColor:'#26a69a',downColor:'#ef5350',wickUpColor:'#26a69a',wickDownColor:'#ef5350',priceFormat:{type:'price',precision:3,minMove:.001}});
    price.priceScale().applyOptions({scaleMargins:{top:.18,bottom:.22}});
    price.setData(view.map(c=>({...c,time:c.time as UTCTimestamp})));
    const volume=chart.addSeries(HistogramSeries,{priceScaleId:'',priceFormat:{type:'volume'},lastValueVisible:false,priceLineVisible:false});
    volume.priceScale().applyOptions({scaleMargins:{top:.8,bottom:0}});
    volume.setData(chartVolume(view));
    const oscillatorData=chartOscillators(view,barSeconds,indicatorConfig.atrLength,indicatorConfig.adxLength,indicatorConfig.atrSmoothing,indicatorConfig.rsiLength);
    const lastOscillator=oscillatorData.at(-1);
    setPaneValues({atr:lastOscillator?.atr??null,adx:lastOscillator?.adx??null,rsi:lastOscillator?.rsi??null});
    const oscillatorKinds=(['atr','adx','rsi'] as const).filter(key=>selectedIndicators[key]);
    indicatorSeries.current.clear();
    for(const [index,key] of oscillatorKinds.entries()){
      const colors={atr:'#38d9ff',adx:'#90a4ae',rsi:'#bd93f9'};
      const series=chart.addSeries(LineSeries,{color:colors[key],lineWidth:1,title:key==='atr'?`ATR (${indicatorConfig.atrLength})`:key==='adx'?`ADX (${indicatorConfig.adxLength})`:`RSI (${indicatorConfig.rsiLength})`,priceLineVisible:false,priceFormat:{type:'price',precision:key==='atr'?3:2,minMove:key==='atr'?.001:.01},...(key==='rsi'?{autoscaleInfoProvider:()=>({priceRange:{minValue:0,maxValue:100}})}:{})},index+1);
      series.applyOptions({visible:!hiddenIndicators[key]});indicatorSeries.current.set(key,series);
      if(key==='adx')series.setData(displayAdx(oscillatorData,indicatorConfig.displaySmoothing).map(point=>point.display===null?{time:point.time as UTCTimestamp}:{time:point.time as UTCTimestamp,value:point.display,color:point.color}));
      else series.setData(oscillatorData.map(point=>point[key]===null?{time:point.time as UTCTimestamp}:{time:point.time as UTCTimestamp,value:point[key],color:indicatorColor(key,point[key],indicatorConfig)}));
      if(key==='rsi')for(const [value,color,title] of [[indicatorConfig.rsiUpper,'#ff8191','Upper'],[50,'#61718b','Mid'],[indicatorConfig.rsiLower,'#43d9a5','Lower']] as const)series.createPriceLine({price:value,color,title,lineStyle:LineStyle.Dashed,lineWidth:1,axisLabelVisible:true});
      if(key==='atr')series.createPriceLine({price:indicatorConfig.atrThreshold,color:'#ffb74d',title:'Threshold',lineStyle:LineStyle.Dashed,lineWidth:1,axisLabelVisible:true});
      if(key==='adx')for(const [value,color,title] of [[20,'#90a4aea6','20 Weak'],[25,'#26a69acc','25 Trend'],[indicatorConfig.adxThreshold,'#ff40ff','Entry']] as const)series.createPriceLine({price:value,color,title,lineStyle:LineStyle.Dashed,lineWidth:1,axisLabelVisible:true});
    }
    if(oscillatorKinds.length)chart.panes().forEach((pane,index)=>pane.setStretchFactor(index===0?3:1));
    let paneResize:ResizeObserver|null=null,paneFrame=0;
    const measurePanes=()=>{
      const root=ref.current;if(!root)return;
      const base=root.getBoundingClientRect().top;
      const headers=[...indicatorSeries.current].flatMap(([kind,series])=>{const element=series.getPane().getHTMLElement();return element?[{kind,top:element.getBoundingClientRect().top-base+6}]:[];});
      setPaneHeaders(old=>JSON.stringify(old)===JSON.stringify(headers)?old:headers);
    };
    paneFrame=requestAnimationFrame(()=>{measurePanes();paneResize=new ResizeObserver(measurePanes);if(ref.current)paneResize.observe(ref.current);for(const series of indicatorSeries.current.values()){const element=series.getPane().getHTMLElement();if(element)paneResize.observe(element);}});
    if(indicators.length) {
      if(indicatorSettings.strategy==='chartart_v12'||indicatorSettings.strategy==='bb_outer_reversal'||indicatorSettings.strategy==='ml_ensemble') {
        for(const [key,color,title] of [['bbBasis','#63d6d0','BB basis'],['bbUpper','#7d8da5','BB upper'],['bbLower','#7d8da5','BB lower']] as const) {
          chart.addSeries(LineSeries,{color,lineWidth:1,title,visible:strategyVisible,priceLineVisible:false,lastValueVisible:false}).setData(
            indicators.map(p=>p[key]==null?{time:p.time as UTCTimestamp}:{time:p.time as UTCTimestamp,value:p[key]}));
        }
      } else {
      for(const [key,color,title] of [['ema20','#e0c278',`EMA ${indicatorSettings.ema_fast}`],['ema50','#88bfff',`EMA ${indicatorSettings.ema_slow}`]] as const) {
        chart.addSeries(LineSeries,{color,lineWidth:1,title,visible:strategyVisible,priceLineVisible:false,lastValueVisible:false}).setData(
          indicators.map(p=>p[key]===null?{time:p.time as UTCTimestamp}:{time:p.time as UTCTimestamp,value:p[key]}));
      }
      }
      if((indicatorSettings.strategy==='bb_outer_reversal'&&indicatorSettings.bb_reversal.use_sma_trend_adjustment!==false)||indicatorSettings.strategy==='ml_ensemble') {
        chart.addSeries(LineSeries,{color:'#d7ad69',lineWidth:2,title:indicatorSettings.strategy==='ml_ensemble'?'EMA 50':'Trend SMA',visible:strategyVisible,priceLineVisible:false,lastValueVisible:false}).setData(
          indicators.map(p=>p.trendSma==null?{time:p.time as UTCTimestamp}:{time:p.time as UTCTimestamp,value:p.trendSma}));
      }
      if(indicatorSettings.strategy!=='bb_outer_reversal'&&indicatorSettings.strategy!=='ml_ensemble'&&(indicatorSettings.strategy!=='mtf'||indicatorSettings.rsi_active)) {
      const rsi=chart.addSeries(LineSeries,{color:'#be9bf3',lineWidth:1,title:`RSI ${indicatorSettings.rsi_period}`,priceLineVisible:false,
        autoscaleInfoProvider:()=>({priceRange:{minValue:0,maxValue:100}})},1);
      rsi.setData(indicators.map(p=>p.rsi20===null?{time:p.time as UTCTimestamp}:{time:p.time as UTCTimestamp,value:p.rsi20}));
      rsi.createPriceLine({price:indicatorSettings.rsi_threshold,color:'#71818e',lineWidth:1,lineStyle:LineStyle.Dashed,axisLabelVisible:true,title:String(indicatorSettings.rsi_threshold)});
      chart.panes()[0].setStretchFactor(3);
      chart.panes()[1].setStretchFactor(1);
      rsi.priceScale().applyOptions({scaleMargins:{top:.1,bottom:.1}});
      }
    }
    const present = new Set(view.map(c=>c.time));
    const visibleTrades = trades.filter(t=>present.has(t.entryTime)||present.has(t.exitTime));
    const markers: SeriesMarker<UTCTimestamp>[] = [];
    for (const t of visibleTrades) {
      if(present.has(t.entryTime)) markers.push(fillMarker(t.entryTime,t.entry,`${t.direction===1?'BUY':'SELL'} #${t.id}`,'entry',t.direction,`entry-${t.id}`,t.quantity));
      if(present.has(t.exitTime)) markers.push(fillMarker(t.exitTime,t.exit,`CLOSE #${t.id}`,'close',t.direction,`close-${t.id}`,t.quantity,t.netPnl));
    }
    if(selected && present.has(selected.signalTime)) markers.push({time:selected.signalTime as UTCTimestamp,position:selected.direction===1?'belowBar':'aboveBar',shape:'square',color:'#e0c278',text:selected.signalLabel?'SIGNAL':'SWEEP'});
    if(selected?.exitSignal && present.has(selected.exitSignal.time)) markers.push({time:selected.exitSignal.time as UTCTimestamp,position:'aboveBar',shape:'square',color:'#be9bf3',text:'CLOSE SIGNAL'});
    const fillLabels=new FillLabels();price.attachPrimitive(fillLabels);fillLabels.setMarkers(markers,view);
    createSeriesMarkers(price,markers.sort((a,b)=>Number(a.time)-Number(b.time)).map(m=>m.price===undefined?m:{...m,text:undefined,size:0}));
    if(selected && selected.stop !== null && selected.target !== null && present.has(selected.entryTime)) {
      const from = selected.entryTime as UTCTimestamp;
      const to = Math.max(selected.exitTime,selected.entryTime+barSeconds) as UTCTimestamp;
      for (const [label,value,color] of [['Entry',selected.entry,'#88bfff'],['Target 2R',selected.target,'#6ce4bc']] as const) {
        const line = chart.addSeries(LineSeries,{color,lineWidth:2,lineStyle:LineStyle.Dashed,title:label,priceLineVisible:false,lastValueVisible:true,priceFormat:{type:'price',precision:3,minMove:.001}});
        line.setData([{time:from,value},{time:to,value}]);
      }
      const history=selected.stopHistory?.length?selected.stopHistory:[{time:selected.entryTime,price:selected.stop,reason:'initial'}];
      const stopPoints=new Map(history.filter(h=>h.time<=selected.exitTime).map(h=>[h.time,h.price]));
      stopPoints.set(Number(to),selected.finalStop??selected.stop);
      chart.addSeries(LineSeries,{color:'#ff8291',lineWidth:2,lineType:LineType.WithSteps,title:'Active stop',priceLineVisible:false,
        priceFormat:{type:'price',precision:3,minMove:.001}}).setData([...stopPoints].sort((a,b)=>a[0]-b[0]).map(([time,value])=>({time:time as UTCTimestamp,value})));
      for (const [value,color] of [[selected.target,'rgba(108,228,188,0.14)'],[selected.stop,'rgba(255,130,145,0.14)']] as const) {
        chart.addSeries(BaselineSeries,{baseValue:{type:'price',price:selected.entry},topFillColor1:color,topFillColor2:color,bottomFillColor1:color,bottomFillColor2:color,topLineColor:'transparent',bottomLineColor:'transparent',priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false}).setData([{time:from,value},{time:to,value}]);
      }
      if(selected.sweepLevel!==null) {
      const sweep = chart.addSeries(LineSeries,{color:'#e0c278',lineWidth:1,lineStyle:LineStyle.Dotted,title:'Swept level',priceLineVisible:false,lastValueVisible:false});
      sweep.setData([{time:selected.signalTime as UTCTimestamp,value:selected.sweepLevel},{time:to,value:selected.sweepLevel}]);
      }
    }
    if(selected && selected.target===null && present.has(selected.entryTime)) {
      chart.addSeries(LineSeries,{color:'#88bfff',lineWidth:2,lineStyle:LineStyle.Dashed,title:'Entry',priceLineVisible:false}).setData([{time:selected.entryTime as UTCTimestamp,value:selected.entry},{time:Math.max(selected.exitTime,selected.entryTime+barSeconds) as UTCTimestamp,value:selected.entry}]);
    }
    const stopOverlay=new StopOverlay();price.attachPrimitive(stopOverlay);
    stopOverlay.setPaths(visibleTrades.filter(t=>t.target===null&&t.stop!==null).map(t=>({from:t.entryTime,to:t.exitTime,history:t.stopHistory??[{time:t.entryTime,price:t.stop!,reason:'initial'}]})),view[0]?.time,view.at(-1)?.time);
    const fillReadouts=new Map<number,string[]>();
    for(const marker of markers.filter(m=>m.price!==undefined)){const time=Number(marker.time);fillReadouts.set(time,[...(fillReadouts.get(time)??[]),marker.text!.replaceAll("\n"," ")]);}
    const byTime = new Map(view.map(c=>[c.time,c]));
    const indicatorByTime = new Map(indicators.map(p=>[p.time,p]));
    chart.subscribeCrosshairMove(p=>{
      const c = typeof p.time==='number' ? byTime.get(p.time) : undefined;
      if(c) {
        const indicator=indicatorByTime.get(c.time);
        const oscillator=oscillatorData.find(point=>point.time===c.time)??lastOscillator;
        setPaneValues({atr:oscillator?.atr??null,adx:oscillator?.adx??null,rsi:oscillator?.rsi??null});
        const extra=indicatorSettings.strategy==='bb_outer_reversal'&&indicator?` Â· ADX ${fmt(indicator.adx??null)} Â· ATR ${fmt(indicator.atr??null,3)} Â· BB width ${fmt(indicator.bbWidthPct??null)}%`:'';
        setReadout(`${formatChartTime(c.time,readChartTimeZone())} Â· O ${fmt(c.open,3)} H ${fmt(c.high,3)} L ${fmt(c.low,3)} C ${fmt(c.close,3)}${extra}${fillReadouts.has(c.time)?` | ${fillReadouts.get(c.time)!.join(" | ")}`:""}`);
      }
    });
    chart.subscribeClick(p=>{
      const trade = visibleTrades.find(t=>p.hoveredObjectId===`entry-${t.id}`||p.hoveredObjectId===`close-${t.id}`)??visibleTrades.find(t=>t.entryTime===p.time||t.exitTime===p.time);
      if(trade) onSelectRef.current(trade);
    });
    const stopResize=resizeChart(chart,ref.current,()=>{
      if(newlySelected && focus>=0) chart.timeScale().setVisibleLogicalRange({from:Math.max(0,focus-70),to:Math.min(candles.length+5,Math.max(focus+100,exit+35))});
      else if(saved) restoreViewport(chart,saved.viewport,view.at(-1)?.time,false);
      else chart.timeScale().setVisibleLogicalRange({from:Math.max(0,view.length-180),to:view.length+5});
    });
    return ()=>{
      viewportRef.current={dataKey,selectedId:selected?.id??null,viewport:captureViewport(chart,view.at(-1)?.time)};
      paneResize?.disconnect();cancelAnimationFrame(paneFrame);indicatorSeries.current.clear();setPaneHeaders([]);
      stopResize();chartRef.current=null;chart.remove();
    };
  },[candles,trades,selected,indicators,barSeconds,indicatorSettings,selectedIndicators,indicatorConfig,hiddenIndicators,strategyVisible]);
  useEffect(()=>{const options=chartTimeOptions(timeZone);chartRef.current?.applyOptions({localization:options.localization,timeScale:options.timeScale});},[timeZone]);
  return <><ChartTools chartRef={chartRef} endLabel="Latest" onLatest={latest} onNavigate={holdView} showEarlier indicators={selectedIndicators} onToggleIndicator={toggleIndicator} strategyVisible={strategyVisible} onToggleStrategy={()=>setStrategyVisible(value=>!value)} follow={follow} onFollowChange={setFollow}/>{settingsOpen&&<IndicatorSettings key={settingsOpen} kind={settingsOpen} value={indicatorConfig} onApply={setIndicatorConfig} onClose={()=>setSettingsOpen(null)}/>}<div className="chart-history-status" role="status">All candles in this backtest are loaded<span>Latest returns to the end of the test period</span></div><div className="chart-resize"><p className="readout tv-legend">{readout}</p>{paneHeaders.map(({kind,top})=><IndicatorHeader key={kind} kind={kind} top={top} config={indicatorConfig} value={paneValues[kind]} hidden={hiddenIndicators[kind]} onSettings={()=>setSettingsOpen(kind)} onVisibility={()=>setHiddenIndicators(old=>({...old,[kind]:!old[kind]}))} onRemove={()=>{setHiddenIndicators(old=>({...old,[kind]:false}));toggleIndicator(kind);}}/>)}<div ref={ref} className="chart-container position-chart" aria-label={`${timeframe} trade positions, indicators, entries, exits, stop and target zones`}/></div></>;
}

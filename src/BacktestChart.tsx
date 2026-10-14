import {StopOverlay} from './StopOverlay';
import {useEffect, useRef, useState} from 'react';
import {CandlestickSeries, ColorType, createChart, createSeriesMarkers, LineSeries, BaselineSeries, LineStyle, LineType, type IChartApi, type ISeriesApi, type UTCTimestamp, type SeriesMarker} from 'lightweight-charts';
import {fillMarker,FillLabels} from './fillMarkers';
import ChartTools,{chartInteraction,resizeChart} from './ChartTools';
import {captureViewport,restoreViewport} from './chartViewport';
import {fmt, type Analysis, type PeriodResult, type Trade, type IndicatorPoint, type BacktestSettings} from './types';

export function EquityChart({period}: {period: Pick<PeriodResult,'name'|'equity'>}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi|null>(null);
  const lineRef = useRef<ISeriesApi<'Line'>|null>(null);
  const hasData = useRef(false);
  const seriesName = useRef(period.name);
  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {autoSize:false, ...chartInteraction, layout:{background:{type:ColorType.Solid,color:'#10141d'},textColor:'#7d8da5'},timeScale:{timeVisible:true,minBarSpacing:2,lockVisibleTimeRangeOnResize:true},grid:{vertLines:{visible:false},horzLines:{color:'#202836'}}});
    chartRef.current=chart;
    lineRef.current=chart.addSeries(LineSeries,{color:'#6ce4bc',priceLineVisible:false,title:'Net equity'});
    const stopResize=resizeChart(chart,ref.current,()=>chart.timeScale().fitContent());
    return ()=>{stopResize();lineRef.current=null;chartRef.current=null;hasData.current=false;chart.remove();};
  },[]);
  useEffect(()=>{
    lineRef.current?.setData(period.equity.map(p=>({...p,time:p.time as UTCTimestamp})));
    if((!hasData.current||seriesName.current!==period.name)&&period.equity.length){chartRef.current?.timeScale().fitContent();hasData.current=true;}
    seriesName.current=period.name;
  },[period.equity,period.name]);
  return <><ChartTools chartRef={chartRef} valueLabel="Amount"/><div className="chart-resize equity-resize"><div ref={ref} className="chart-container equity-chart" aria-label={`${period.name} equity after trading costs`}/></div></>;
}

export default function BacktestChart({candles,trades,selected,onSelect,indicators,barSeconds,timeframe,indicatorSettings}: {indicatorSettings: BacktestSettings; indicators: IndicatorPoint[]; barSeconds: number; timeframe: string; candles: Analysis['candles']; trades: Trade[]; selected: Trade | null; onSelect: (trade: Trade)=>void}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi|null>(null);
  const viewportRef = useRef<{dataKey:string;selectedId:number|null;viewport:ReturnType<typeof captureViewport>}|null>(null);
  const onSelectRef = useRef(onSelect);onSelectRef.current=onSelect;
  const [readout,setReadout] = useState('Hover for UTC candle prices. Click an entry or exit to select its trade.');
  useEffect(()=>{
    if (!ref.current || !candles.length) return;
    const dataKey=`${candles.length}:${candles[0]?.time}:${candles.at(-1)?.time}`;
    const saved=viewportRef.current?.dataKey===dataKey?viewportRef.current:null;
    const newlySelected=selected!==null&&selected.id!==saved?.selectedId;
    const focus = selected ? candles.findIndex(c=>c.time>=selected.signalTime) : -1;
    const exit = selected ? candles.findIndex(c=>c.time>=selected.exitTime) : -1;
    const view = candles;
    const chart = createChart(ref.current,{autoSize:false,...chartInteraction,layout:{background:{type:ColorType.Solid,color:'#10141d'},textColor:'#7d8da5'},timeScale:{timeVisible:true,minBarSpacing:2,lockVisibleTimeRangeOnResize:true},grid:{vertLines:{visible:false},horzLines:{color:'#202836'}}});
    chartRef.current=chart;
    const price = chart.addSeries(CandlestickSeries,{borderVisible:false,upColor:'#26a69a',downColor:'#ef5350',wickUpColor:'#26a69a',wickDownColor:'#ef5350',priceFormat:{type:'price',precision:3,minMove:.001}});
    price.priceScale().applyOptions({scaleMargins:{top:.18,bottom:.22}});
    price.setData(view.map(c=>({...c,time:c.time as UTCTimestamp})));
    if(indicators.length) {
      if(indicatorSettings.strategy==='chartart_v12'||indicatorSettings.strategy==='bb_outer_reversal') {
        for(const [key,color,title] of [['bbBasis','#63d6d0','BB basis'],['bbUpper','#7d8da5','BB upper'],['bbLower','#7d8da5','BB lower']] as const) {
          chart.addSeries(LineSeries,{color,lineWidth:1,title,priceLineVisible:false,lastValueVisible:false}).setData(
            indicators.map(p=>p[key]==null?{time:p.time as UTCTimestamp}:{time:p.time as UTCTimestamp,value:p[key]}));
        }
      } else {
      for(const [key,color,title] of [['ema20','#e0c278',`EMA ${indicatorSettings.ema_fast}`],['ema50','#88bfff',`EMA ${indicatorSettings.ema_slow}`]] as const) {
        chart.addSeries(LineSeries,{color,lineWidth:1,title,priceLineVisible:false,lastValueVisible:false}).setData(
          indicators.map(p=>p[key]===null?{time:p.time as UTCTimestamp}:{time:p.time as UTCTimestamp,value:p[key]}));
      }
      }
      if(indicatorSettings.strategy==='bb_outer_reversal'&&indicatorSettings.bb_reversal.use_sma_trend_adjustment!==false) {
        chart.addSeries(LineSeries,{color:'#d7ad69',lineWidth:2,title:'Trend SMA',priceLineVisible:false,lastValueVisible:false}).setData(
          indicators.map(p=>p.trendSma==null?{time:p.time as UTCTimestamp}:{time:p.time as UTCTimestamp,value:p.trendSma}));
      }
      if(indicatorSettings.strategy!=='bb_outer_reversal'&&(indicatorSettings.strategy!=='mtf'||indicatorSettings.rsi_active)) {
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
        const extra=indicatorSettings.strategy==='bb_outer_reversal'&&indicator?` · ADX ${fmt(indicator.adx??null)} · ATR ${fmt(indicator.atr??null,3)} · BB width ${fmt(indicator.bbWidthPct??null)}%`:'';
        setReadout(`${new Date(c.time*1000).toISOString()} · O ${fmt(c.open,3)} H ${fmt(c.high,3)} L ${fmt(c.low,3)} C ${fmt(c.close,3)}${extra}${fillReadouts.has(c.time)?` | ${fillReadouts.get(c.time)!.join(" | ")}`:""}`);
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
      stopResize();chartRef.current=null;chart.remove();
    };
  },[candles,trades,selected,indicators,barSeconds,indicatorSettings]);
  return <><ChartTools chartRef={chartRef} endLabel="End" onLatest={()=>chartRef.current?.timeScale().setVisibleLogicalRange({from:Math.max(0,candles.length-180),to:candles.length+5})}/><p className="readout">{readout}</p><div className="chart-resize"><div ref={ref} className="chart-container position-chart" aria-label={`${timeframe} trade positions, indicators, entries, exits, stop and target zones`}/></div></>;
}

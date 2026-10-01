import {useEffect, useRef, useState} from 'react';
import {CandlestickSeries, ColorType, createChart, createSeriesMarkers, LineSeries, BaselineSeries, LineStyle, LineType, type IChartApi, type UTCTimestamp, type SeriesMarker} from 'lightweight-charts';
import ChartTools,{chartInteraction,resizeChart} from './ChartTools';
import {fmt, type Analysis, type PeriodResult, type Trade, type IndicatorPoint, type BacktestSettings} from './types';

export function EquityChart({period}: {period: PeriodResult}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi|null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {autoSize:false, ...chartInteraction, layout:{background:{type:ColorType.Solid,color:'#111e29'},textColor:'#aebfcb'},timeScale:{timeVisible:true,minBarSpacing:.001,lockVisibleTimeRangeOnResize:true},grid:{vertLines:{visible:false},horzLines:{color:'#22323f'}}});
    chartRef.current=chart;
    chart.addSeries(LineSeries,{color:'#6ce4bc',priceLineVisible:false,title:'Net equity'}).setData(period.equity.map(p=>({...p,time:p.time as UTCTimestamp})));
    const stopResize=resizeChart(chart,ref.current,()=>chart.timeScale().fitContent());
    return ()=>{stopResize();chartRef.current=null;chart.remove();};
  },[period]);
  return <><ChartTools chartRef={chartRef} valueLabel="Amount"/><div className="chart-resize equity-resize"><div ref={ref} className="chart-container equity-chart" aria-label={`${period.name} equity after trading costs`}/></div></>;
}

export default function BacktestChart({candles,trades,selected,onSelect,indicators,barSeconds,timeframe,indicatorSettings}: {indicatorSettings: BacktestSettings; indicators: IndicatorPoint[]; barSeconds: number; timeframe: string; candles: Analysis['candles']; trades: Trade[]; selected: Trade | null; onSelect: (trade: Trade)=>void}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi|null>(null);
  const [readout,setReadout] = useState('Hover for UTC candle prices. Click an entry or exit to select its trade.');
  useEffect(()=>{
    if (!ref.current || !candles.length) return;
    const focus = selected ? candles.findIndex(c=>c.time>=selected.signalTime) : -1;
    const exit = selected ? candles.findIndex(c=>c.time>=selected.exitTime) : -1;
    const view = candles;
    const chart = createChart(ref.current,{autoSize:false,...chartInteraction,layout:{background:{type:ColorType.Solid,color:'#111e29'},textColor:'#aebfcb'},timeScale:{timeVisible:true,minBarSpacing:.001,lockVisibleTimeRangeOnResize:true},grid:{vertLines:{visible:false},horzLines:{color:'#22323f'}}});
    chartRef.current=chart;
    const price = chart.addSeries(CandlestickSeries,{borderVisible:false,upColor:'#84bba1',downColor:'#c57f86',wickUpColor:'#84bba1',wickDownColor:'#c57f86',priceFormat:{type:'price',precision:3,minMove:.001}});
    price.setData(view.map(c=>({...c,time:c.time as UTCTimestamp})));
    if(indicators.length) {
      for(const [key,color,title] of [['ema20','#e0c278',`EMA ${indicatorSettings.ema_fast}`],['ema50','#88bfff',`EMA ${indicatorSettings.ema_slow}`]] as const) {
        chart.addSeries(LineSeries,{color,lineWidth:1,title,priceLineVisible:false,lastValueVisible:false}).setData(
          indicators.map(p=>p[key]===null?{time:p.time as UTCTimestamp}:{time:p.time as UTCTimestamp,value:p[key]}));
      }
      if(indicatorSettings.strategy!=='mtf'||indicatorSettings.rsi_active) {
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
      if(present.has(t.entryTime)) markers.push({time:t.entryTime as UTCTimestamp,position:t.direction===1?'belowBar':'aboveBar',shape:t.direction===1?'arrowUp':'arrowDown',color:t.direction===1?'#6ce4bc':'#ff8291',text:`${t.direction===1?'BUY':'SELL'} #${t.id}`});
      if(present.has(t.exitTime)) markers.push({time:t.exitTime as UTCTimestamp,position:t.direction===1?'aboveBar':'belowBar',shape:'circle',color:t.netPnl>=0?'#6ce4bc':'#ff8291',text:`EXIT #${t.id} ${fmt(t.netPnl)}`});
    }
    if(selected && present.has(selected.signalTime)) markers.push({time:selected.signalTime as UTCTimestamp,position:selected.direction===1?'belowBar':'aboveBar',shape:'square',color:'#e0c278',text:selected.signalLabel?'SIGNAL':'SWEEP'});
    if(selected?.exitSignal && present.has(selected.exitSignal.time)) markers.push({time:selected.exitSignal.time as UTCTimestamp,position:'aboveBar',shape:'square',color:'#be9bf3',text:'CLOSE SIGNAL'});
    createSeriesMarkers(price,markers.sort((a,b)=>Number(a.time)-Number(b.time)));
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
      if(selected.stop!==null) chart.addSeries(LineSeries,{color:'#ff8291',lineWidth:2,title:'ATR stop',priceLineVisible:false}).setData([{time:selected.entryTime as UTCTimestamp,value:selected.stop},{time:Math.max(selected.exitTime,selected.entryTime+barSeconds) as UTCTimestamp,value:selected.stop}]);
      chart.addSeries(LineSeries,{color:'#88bfff',lineWidth:2,lineStyle:LineStyle.Dashed,title:'Entry',priceLineVisible:false}).setData([{time:selected.entryTime as UTCTimestamp,value:selected.entry},{time:Math.max(selected.exitTime,selected.entryTime+barSeconds) as UTCTimestamp,value:selected.entry}]);
    }
    const byTime = new Map(view.map(c=>[c.time,c]));
    chart.subscribeCrosshairMove(p=>{
      const c = typeof p.time==='number' ? byTime.get(p.time) : undefined;
      if(c) setReadout(`${new Date(c.time*1000).toISOString()} · O ${fmt(c.open,3)} H ${fmt(c.high,3)} L ${fmt(c.low,3)} C ${fmt(c.close,3)}`);
    });
    chart.subscribeClick(p=>{
      const trade = visibleTrades.find(t=>t.entryTime===p.time||t.exitTime===p.time);
      if(trade) onSelect(trade);
    });
    const stopResize=resizeChart(chart,ref.current,()=>{
    if(selected && focus>=0) chart.timeScale().setVisibleLogicalRange({from:Math.max(0,focus-70),to:Math.min(candles.length+5,Math.max(focus+100,exit+35))});
    else chart.timeScale().setVisibleLogicalRange({from:Math.max(0,view.length-180),to:view.length+5});
    });
    return ()=>{stopResize();chartRef.current=null;chart.remove();};
  },[candles,trades,selected,onSelect,indicators,barSeconds,indicatorSettings]);
  return <><ChartTools chartRef={chartRef} onLatest={()=>chartRef.current?.timeScale().setVisibleLogicalRange({from:Math.max(0,candles.length-180),to:candles.length+5})}/><p className="readout">{readout}</p><div className="chart-resize"><div ref={ref} className="chart-container position-chart" aria-label={`${timeframe} trade positions, indicators, entries, exits, stop and target zones`}/></div></>;
}

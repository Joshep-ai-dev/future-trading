import {useEffect, useRef, useState} from 'react';
import {CandlestickSeries, ColorType, createChart, createSeriesMarkers, LineSeries, BaselineSeries, LineStyle, type UTCTimestamp, type SeriesMarker} from 'lightweight-charts';
import {fmt, type Analysis, type PeriodResult, type Trade} from './types';

export function EquityChart({period}: {period: PeriodResult}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {autoSize:true, layout:{background:{type:ColorType.Solid,color:'#111e29'},textColor:'#aebfcb'},timeScale:{timeVisible:true},grid:{vertLines:{visible:false},horzLines:{color:'#22323f'}}});
    chart.addSeries(LineSeries,{color:'#6ce4bc',priceLineVisible:false,title:'Net equity'}).setData(period.equity.map(p=>({...p,time:p.time as UTCTimestamp})));
    chart.timeScale().fitContent();
    return ()=>chart.remove();
  },[period]);
  return <div ref={ref} className="chart-container equity-chart" aria-label={`${period.name} equity after trading costs`}/>;
}

export default function BacktestChart({candles,trades,selected,onSelect}: {candles: Analysis['candles']; trades: Trade[]; selected: Trade | null; onSelect: (trade: Trade)=>void}) {
  const ref = useRef<HTMLDivElement>(null);
  const [readout,setReadout] = useState('Hover for UTC candle prices. Click an entry or exit to select its trade.');
  useEffect(()=>{
    if (!ref.current || !candles.length) return;
    const focus = selected ? candles.findIndex(c=>c.time>=selected.signalTime) : -1;
    const exit = selected ? candles.findIndex(c=>c.time>=selected.exitTime) : -1;
    const view = focus>=0 ? candles.slice(Math.max(0,focus-70),Math.max(focus+100,exit+35)) : candles.slice(-5000);
    const chart = createChart(ref.current,{autoSize:true,layout:{background:{type:ColorType.Solid,color:'#111e29'},textColor:'#aebfcb'},timeScale:{timeVisible:true},grid:{vertLines:{visible:false},horzLines:{color:'#22323f'}}});
    const price = chart.addSeries(CandlestickSeries,{borderVisible:false,upColor:'#84bba1',downColor:'#c57f86',wickUpColor:'#84bba1',wickDownColor:'#c57f86',priceFormat:{type:'price',precision:3,minMove:.001}});
    price.setData(view.map(c=>({...c,time:c.time as UTCTimestamp})));
    const present = new Set(view.map(c=>c.time));
    const visibleTrades = trades.filter(t=>present.has(t.entryTime)||present.has(t.exitTime));
    const markers: SeriesMarker<UTCTimestamp>[] = [];
    for (const t of visibleTrades) {
      if(present.has(t.entryTime)) markers.push({time:t.entryTime as UTCTimestamp,position:t.direction===1?'belowBar':'aboveBar',shape:t.direction===1?'arrowUp':'arrowDown',color:t.direction===1?'#6ce4bc':'#ff8291',text:`${t.direction===1?'BUY':'SELL'} #${t.id}`});
      if(present.has(t.exitTime)) markers.push({time:t.exitTime as UTCTimestamp,position:t.direction===1?'aboveBar':'belowBar',shape:'circle',color:t.netPnl>=0?'#6ce4bc':'#ff8291',text:`EXIT #${t.id} ${fmt(t.netPnl)}`});
    }
    if(selected && present.has(selected.signalTime)) markers.push({time:selected.signalTime as UTCTimestamp,position:selected.direction===1?'belowBar':'aboveBar',shape:'square',color:'#e0c278',text:'SWEEP'});
    createSeriesMarkers(price,markers.sort((a,b)=>Number(a.time)-Number(b.time)));
    if(selected && present.has(selected.entryTime)) {
      const from = selected.entryTime as UTCTimestamp;
      const to = Math.max(selected.exitTime,selected.entryTime+300) as UTCTimestamp;
      for (const [label,value,color] of [['Entry',selected.entry,'#88bfff'],['Stop',selected.stop,'#ff8291'],['Target 2R',selected.target,'#6ce4bc']] as const) {
        const line = chart.addSeries(LineSeries,{color,lineWidth:2,lineStyle:LineStyle.Dashed,title:label,priceLineVisible:false,lastValueVisible:true,priceFormat:{type:'price',precision:3,minMove:.001}});
        line.setData([{time:from,value},{time:to,value}]);
      }
      for (const [value,color] of [[selected.target,'rgba(108,228,188,0.14)'],[selected.stop,'rgba(255,130,145,0.14)']] as const) {
        chart.addSeries(BaselineSeries,{baseValue:{type:'price',price:selected.entry},topFillColor1:color,topFillColor2:color,bottomFillColor1:color,bottomFillColor2:color,topLineColor:'transparent',bottomLineColor:'transparent',priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false}).setData([{time:from,value},{time:to,value}]);
      }
      const sweep = chart.addSeries(LineSeries,{color:'#e0c278',lineWidth:1,lineStyle:LineStyle.Dotted,title:'Swept level',priceLineVisible:false,lastValueVisible:false});
      sweep.setData([{time:selected.signalTime as UTCTimestamp,value:selected.sweepLevel},{time:to,value:selected.sweepLevel}]);
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
    if(selected) chart.timeScale().fitContent();
    else chart.timeScale().setVisibleLogicalRange({from:Math.max(0,view.length-180),to:view.length+5});
    return ()=>chart.remove();
  },[candles,trades,selected,onSelect]);
  return <><p className="readout">{readout}</p><div ref={ref} className="chart-container position-chart" aria-label="5-minute trade positions, entry arrows, exits, stop and target zones"/></>;
}

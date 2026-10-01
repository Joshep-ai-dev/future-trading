import {useEffect, useRef, useState} from 'react';
import {CandlestickSeries, ColorType, createChart, type UTCTimestamp} from 'lightweight-charts';
import type {Analysis} from './types';
import {fmt} from './types';
export default function Chart({data}: {data: Analysis}) {
  const ref = useRef<HTMLDivElement>(null);
  const [readout,setReadout] = useState('Hover for UTC time, OHLC.');
  useEffect(() => {
    if (!ref.current) return;
    setReadout('Hover for UTC time, OHLC.');
    const chart = createChart(ref.current, {autoSize:true,
      layout:{background:{type:ColorType.Solid,color:'#111e29'},textColor:'#aebfcb'},
      grid:{vertLines:{visible:false},horzLines:{color:'#22323f'}},timeScale:{timeVisible:true}});
      const price = chart.addSeries(CandlestickSeries,{borderVisible:false,upColor:'#84bba1',downColor:'#c57f86',wickUpColor:'#84bba1',wickDownColor:'#c57f86'});
      price.setData(data.candles.map(c => ({...c,time:c.time as UTCTimestamp})));
      const byTime = new Map(data.candles.map(c => [c.time,c]));
      chart.subscribeCrosshairMove(p => {
        const c = typeof p.time === 'number' ? byTime.get(p.time) : undefined;
        setReadout(c ? `${new Date(c.time*1000).toISOString()} · O ${fmt(c.open,3)} H ${fmt(c.high,3)} L ${fmt(c.low,3)} C ${fmt(c.close,3)}` : 'Hover for UTC time, OHLC.');
      });
      chart.timeScale().setVisibleLogicalRange({from:Math.max(0,data.candles.length-168),to:data.candles.length+5});
    return () => chart.remove();
  },[data]);
  return <><p className="readout">{readout}</p>
    <div ref={ref} className="chart-container" aria-label="Price chart"/></>;
}

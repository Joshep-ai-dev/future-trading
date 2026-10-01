import {useEffect, useRef, useState} from 'react';
import {CandlestickSeries, ColorType, createChart, type IChartApi, type UTCTimestamp} from 'lightweight-charts';
import type {Analysis,CandlePage} from './types';
import {fmt} from './types';
import {api} from './api';
import ChartTools,{chartInteraction,resizeChart} from './ChartTools';
export default function Chart({data}: {data: Analysis}) {
  const ref=useRef<HTMLDivElement>(null),chartRef=useRef<IChartApi|null>(null);
  const earlier=useRef<()=>void>(()=>{}),latest=useRef<()=>void>(()=>{});
  const [readout,setReadout]=useState('Hover for UTC time and OHLC.');
  const [history,setHistory]=useState({count:data.candles.length,first:data.candles[0]?.time,hasMore:(data.history?.hasMore??data.candles.length<data.quality.completeBars)});
  const [loading,setLoading]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    if(!ref.current)return;
    let candles=[...data.candles],hasMore=(data.history?.hasMore??data.candles.length<data.quality.completeBars),pending=false,disposed=false;
    const abort=new AbortController();
    setReadout('Hover for UTC time and OHLC.');setError('');setLoading(false);
    setHistory({count:candles.length,first:candles[0]?.time,hasMore});
    const chart=createChart(ref.current,{autoSize:false,...chartInteraction,
      layout:{background:{type:ColorType.Solid,color:'#111e29'},textColor:'#aebfcb'},
      grid:{vertLines:{visible:false},horzLines:{color:'#22323f'}},timeScale:{timeVisible:true,minBarSpacing:.001,lockVisibleTimeRangeOnResize:true}});
    chartRef.current=chart;
    const price=chart.addSeries(CandlestickSeries,{borderVisible:false,upColor:'#84bba1',downColor:'#c57f86',wickUpColor:'#84bba1',wickDownColor:'#c57f86'});
    const byTime=new Map(candles.map(c=>[c.time,c]));
    const setCandles=()=>price.setData(candles.map(c=>({...c,time:c.time as UTCTimestamp})));
    setCandles();
    chart.subscribeCrosshairMove(p=>{
      const c=typeof p.time==='number'?byTime.get(p.time):undefined;
      if(c)setReadout(`${new Date(c.time*1000).toISOString()} · O ${fmt(c.open,3)} H ${fmt(c.high,3)} L ${fmt(c.low,3)} C ${fmt(c.close,3)}`);
    });
    async function loadEarlier() {
      if(pending||!hasMore||disposed||!candles.length)return;
      pending=true;let loaded=false;setLoading(true);setError('');
      try {
        const page=await api<CandlePage>('/api/candles',{method:'POST',headers:{'Content-Type':'application/json'},signal:abort.signal,body:JSON.stringify({timeframe:data.params.timeframe,before:candles[0].time,limit:5000})});
        if(disposed)return;
        const older=page.candles.filter(c=>c.time<candles[0].time);
        const visible=chart.timeScale().getVisibleLogicalRange();
        candles=[...older,...candles];hasMore=page.hasMore&&older.length>0;
        older.forEach(c=>byTime.set(c.time,c));setCandles();
        // Prepending shifts logical indices; hold the same timestamps under the viewport.
        if(visible)chart.timeScale().setVisibleLogicalRange({from:visible.from+older.length,to:visible.to+older.length});
        setHistory({count:candles.length,first:candles[0]?.time,hasMore});loaded=true;
      } catch(e) {if(!disposed)setError(String(e));}
      finally {
        pending=false;
        if(!disposed){
          setLoading(false);
          if(loaded&&hasMore&&(chart.timeScale().getVisibleLogicalRange()?.from??Infinity)<100)void loadEarlier();
        }
      }
    }
    earlier.current=()=>void loadEarlier();
    latest.current=()=>{chart.priceScale('right').setAutoScale(true);chart.timeScale().setVisibleLogicalRange({from:Math.max(0,candles.length-168),to:candles.length+5});};
    const stopResize=resizeChart(chart,ref.current,()=>latest.current());
    chart.timeScale().subscribeVisibleLogicalRangeChange(range=>{
      if(range&&range.from<100)void loadEarlier();
    });
    return ()=>{disposed=true;stopResize();abort.abort();earlier.current=()=>{};latest.current=()=>{};chartRef.current=null;chart.remove();};
  },[data]);
  return <><ChartTools chartRef={chartRef} onLatest={()=>latest.current()} onEarlier={()=>earlier.current()} loading={loading} hasMore={history.hasMore}/>
    <p className="history-status" role="status">{history.count.toLocaleString()} / {data.quality.completeBars.toLocaleString()} candles loaded · from {history.first?new Date(history.first*1000).toISOString().slice(0,16).replace('T',' '):'—'} UTC · {history.hasMore?'Pan to the left edge for earlier history.':'Beginning of available history reached.'}</p>
    {error&&<p className="error" role="alert">Could not load earlier candles. {error} Use Load earlier to retry.</p>}
    <p className="readout">{readout}</p><div className="chart-resize"><div ref={ref} className="chart-container" aria-label="Price chart"/></div></>;
}

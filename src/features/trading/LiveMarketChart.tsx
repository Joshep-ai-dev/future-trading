import {memo,useCallback,useEffect,useMemo,useState,type ReactNode} from 'react';
import {api} from '../../shared/api/api';
import PaperPriceChart from '../../shared/charts/PaperPriceChart';
import TradingChartHeader from '../../shared/charts/TradingChartHeader';
import {TIMEFRAMES} from '../../shared/charts/chartTimeframe';
import type {ExchangeVenue} from '../../shared/api/exchangeVenue';
import type {Analysis,BacktestSettings} from '../../shared/types/types';
import {useExchangeStream} from '../../shared/api/useExchangeStream';
import {instrumentDetails,useExchangeInstrument} from '../../shared/api/exchangeInstrument';

type Candle=Analysis['candles'][number];
const StreamingPriceChart=memo(PaperPriceChart);
const emptyStops:[]=[];
const emptyTrades:[]=[];
export default function LiveMarketChart({venue,settings,overlay}:{venue:ExchangeVenue;settings:BacktestSettings;overlay?:ReactNode}){
  const {data,connected}=useExchangeStream(venue);
  const asset=instrumentDetails(useExchangeInstrument()).base;
  const [timeframe,setTimeframe]=useState<BacktestSettings['entry_timeframe']>(settings.entry_timeframe);
  const [candles,setCandles]=useState<Candle[]>([]),[error,setError]=useState(''),[loaded,setLoaded]=useState(false);
  const duration=TIMEFRAMES[timeframe];
  const available=!!data?.symbol&&!data?.errors.connection;
  useEffect(()=>{setTimeframe(settings.entry_timeframe);},[settings.entry_timeframe]);
  function changeTimeframe(value:string){
    if(!(value in TIMEFRAMES)||value===timeframe)return;
    setLoaded(false);setCandles([]);setError('');
    setTimeframe(value as BacktestSettings['entry_timeframe']);
  }
  useEffect(()=>{
    const abort=new AbortController();setLoaded(false);setCandles([]);setError('');
    if(!available)return()=>abort.abort();
    async function load(){
      try{
        const result=await api<{candles:number[][]}>(`/api/exchange/candles?venue=${venue}&timeframe=${timeframe}`,{signal:abort.signal});
        const buckets=new Map<number,Candle>();
        for(const [timestamp,open,high,low,close,volume=0] of result.candles){
          const time=Math.floor(timestamp/1000/duration)*duration,previous=buckets.get(time);
          buckets.set(time,previous?{...previous,high:Math.max(previous.high,high),low:Math.min(previous.low,low),close,volume:(previous.volume??0)+volume}:{time,open,high,low,close,volume});
        }
        if(!abort.signal.aborted){setCandles([...buckets.values()].sort((a,b)=>a.time-b.time));setLoaded(true);}
      }catch(reason){if(!abort.signal.aborted)setError(String(reason));}
    }
    void load();return()=>abort.abort();
  },[venue,timeframe,duration,available]);
  useEffect(()=>{
    if(!loaded||!data?.candle)return;
    const [timestamp,open,high,low,close,volume=0]=data.candle;
    const time=Math.floor(timestamp/1000/duration)*duration;
    setCandles(previous=>{
      const last=previous.at(-1);
      if(last&&time<last.time)return previous;
      const next=last?.time===time?{...last,high:Math.max(last.high,high),low:Math.min(last.low,low),close,volume}:{time,open,high,low,close,volume};
      return [...(last?.time===time?previous.slice(0,-1):previous),next].slice(-1000);
    });
  },[data?.candle,loaded,duration]);
  const indicators=useMemo(()=>candles.map((c,index)=>{
    const length=settings.bb_reversal.bb_length,rows=candles.slice(Math.max(0,index-length+1),index+1);
    const basis=rows.length===length?rows.reduce((sum,row)=>sum+row.close,0)/length:null;
    const deviation=basis===null?null:Math.sqrt(rows.reduce((sum,row)=>sum+(row.close-basis)**2,0)/length)*settings.bb_reversal.bb_mult;
    const smaLength=settings.bb_reversal.sma_length,smaRows=candles.slice(Math.max(0,index-smaLength+1),index+1);
    return {time:c.time,bbBasis:basis,bbUpper:basis===null||deviation===null?null:basis+deviation,bbLower:basis===null||deviation===null?null:basis-deviation,trendSma:smaRows.length===smaLength?smaRows.reduce((sum,row)=>sum+row.close,0)/smaLength:null};
  }),[candles,settings.bb_reversal.bb_length,settings.bb_reversal.bb_mult,settings.bb_reversal.sma_length]);
  const loadHistory=useCallback(async(before:number)=>{
    const result=await api<{candles:number[][];hasMore:boolean}>(`/api/exchange/candles?venue=${venue}&timeframe=${timeframe}&before=${before}`);
    const buckets=new Map<number,Candle>();
    for(const [timestamp,open,high,low,close,volume=0] of result.candles){
      const time=Math.floor(timestamp/1000/duration)*duration,previous=buckets.get(time);
      buckets.set(time,previous?{...previous,high:Math.max(previous.high,high),low:Math.min(previous.low,low),close,volume:(previous.volume??0)+volume}:{time,open,high,low,close,volume});
    }
    return {candles:[...buckets.values()].filter(c=>c.time<before).sort((a,b)=>a.time-b.time),hasMore:result.hasMore};
  },[venue,timeframe,duration]);
  return <section className="terminal-panel price-panel live-price-panel"><TradingChartHeader timeframe={timeframe} onTimeframeChange={changeTimeframe} mode={`${venue.toUpperCase()} LIVE MARKET`} caption={`${timeframe} exchange candles · streaming updates`}/>{overlay}
    {(error||data?.errors.connection||data?.errors.candleStream||!connected)&&<p className="exchange-inline-error" role="status">{error||data?.errors.connection||data?.errors.candleStream||'Connecting to exchange stream…'}</p>}
    {candles.length?<StreamingPriceChart key={`${venue}-${asset}-${timeframe}`} sessionId={0} allowLocalHistory={false} loadHistory={loadHistory} historyLabel="Pan left to load exchange history" showSma={settings.bb_reversal.use_sma_trend_adjustment} timeframe={timeframe} atrLength={settings.bb_reversal.atr_length} adxLength={settings.bb_reversal.adx_length} candles={candles} indicators={indicators} stops={emptyStops} trades={emptyTrades} position={null} indicatorClock={(data?.sectionTimes.candle??data?.sectionTimes.market??0)/1000}/>:<div className="chart-empty"><h3>{error?'Exchange chart unavailable':'Connecting to live market'}</h3><p>{venue.toUpperCase()} {asset}/USDT perpetual candles</p></div>}
  </section>;
}

import MarketHistoryDownload from './MarketHistoryDownload';
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
function exchangeBuckets(rows: number[][], duration: number): Candle[] {
  const buckets = new Map<number, Candle>();
  for (const [timestamp, open, high, low, close, volume] of rows) {
    const time = Math.floor(timestamp / 1000 / duration) * duration;
    const previous = buckets.get(time);
    buckets.set(time, previous ? {
      ...previous,
      high: Math.max(previous.high, high),
      low: Math.min(previous.low, low),
      close,
      volume: previous.volume === undefined || volume === undefined ? undefined : previous.volume + volume,
    } : { time, open, high, low, close, volume });
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

const StreamingPriceChart=memo(PaperPriceChart);
const emptyStops:[]=[];
const emptyTrades:[]=[];
export default function LiveMarketChart({venue,settings,overlay,toolbarEnd,onTimeframeChange}:{venue:ExchangeVenue;settings:BacktestSettings;overlay?:ReactNode;toolbarEnd?:ReactNode;onTimeframeChange?:(value:BacktestSettings['entry_timeframe'])=>void}){
  const {data,connected}=useExchangeStream(venue);
  const asset=instrumentDetails(useExchangeInstrument()).base;
  const [timeframe,setTimeframe]=useState<BacktestSettings['entry_timeframe']>(settings.entry_timeframe);
  const [candles,setCandles]=useState<Candle[]>([]),[error,setError]=useState(''),[loaded,setLoaded]=useState(false);
  useEffect(()=>{onTimeframeChange?.(timeframe);},[timeframe,onTimeframeChange]);
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
    let retry:ReturnType<typeof setTimeout>|undefined;
    async function load(){
      try{
        const result=await api<{candles:number[][]}>(`/api/exchange/candles?venue=${venue}&timeframe=${timeframe}`,{signal:abort.signal});
        if(!result.candles.length)throw new Error('Waiting for exchange candle history. Retrying automatically.');
        if (!abort.signal.aborted) {
          setCandles(exchangeBuckets(result.candles, duration));
          setLoaded(true);
          setError('');
        }
      }catch(reason){if(!abort.signal.aborted){setError(String(reason));retry=setTimeout(()=>void load(),5000);}}
    }
    void load();return()=>{abort.abort();if(retry)clearTimeout(retry);};
  },[venue,timeframe,duration,available,data?.symbol]);
  useEffect(()=>{
    if(!loaded||!data?.candle)return;
    const [timestamp,open,high,low,close,volume]=data.candle;
    const time=Math.floor(timestamp/1000/duration)*duration;
    setCandles(previous=>{
      const index=previous.findIndex(candle=>candle.time===time);
      const existing=index>=0?previous[index]:undefined;
      const last=previous.at(-1);
      if(last&&time<last.time&&!existing)return previous;
      // The feed sends cumulative 1m snapshots. Larger buckets get their
      // volume from REST, since their initial totals overlap the stream.
      const next = duration === 60
        ? { time, open, high, low, close, volume }
        : existing
          ? { ...existing, high: Math.max(existing.high, high), low: Math.min(existing.low, low), close }
          : { time, open, high, low, close };
      const updated=existing?previous.map((candle,i)=>i===index?next:candle):[...previous,next];
      return updated.slice(-1000);
    });
  },[data?.candle,loaded,duration]);
  useEffect(() => {
    if (!loaded || !connected || duration === 60) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refreshVolume() {
      try {
        const result = await api<{ candles: number[][] }>(
          `/api/exchange/candles?venue=${venue}&timeframe=${timeframe}&recent=true`,
          { signal: abort.signal },
        );
        if (abort.signal.aborted || !result.candles.length) return;
        const first = result.candles[0][0] / 1000;
        const volumes = new Map(exchangeBuckets(result.candles, duration)
          .filter((candle) => candle.time >= first && candle.volume !== undefined)
          .map((candle) => [candle.time, candle.volume]));
        setCandles((previous) => {
          if (!previous.some((candle) => volumes.has(candle.time) && volumes.get(candle.time) !== candle.volume)) {
            return previous;
          }
          return previous.map((candle) => volumes.has(candle.time)
            ? { ...candle, volume: volumes.get(candle.time) }
            : candle);
        });
      } catch {
        // Keep the last exchange volume while the snapshot is unavailable.
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(() => void refreshVolume(), 10000);
      }
    }
    timer = setTimeout(() => void refreshVolume(), 10000);
    return () => {
      abort.abort();
      if (timer) clearTimeout(timer);
    };
  }, [loaded, connected, venue, timeframe, duration, data?.symbol]);
  useEffect(()=>{
    const lastPrice=data?.market?.last;
    const timestamp=data?.market?.timestamp??data?.sectionTimes.market;
    if(!loaded||!connected||lastPrice==null||!Number.isFinite(lastPrice)||lastPrice<=0||!timestamp)return;
    // Prefer exchange candle updates when they are newer than the ticker.
    if((data?.sectionTimes.candle??0)>(data?.sectionTimes.market??0))return;
    const time=Math.floor(timestamp/1000/duration)*duration;
    setCandles(previous=>{
      const last=previous.at(-1);
      if(!last||time<last.time)return previous;
      if(time===last.time){
        if(last.close===lastPrice)return previous;
        return [...previous.slice(0,-1),{...last,close:lastPrice,high:Math.max(last.high,lastPrice),low:Math.min(last.low,lastPrice)}];
      }
      return [...previous,{time,open:lastPrice,high:lastPrice,low:lastPrice,close:lastPrice}].slice(-1000);
    });
  },[loaded,connected,data?.market?.last,data?.market?.timestamp,data?.sectionTimes.market,data?.sectionTimes.candle,duration]);
  const indicators=useMemo(()=>candles.map((c,index)=>{
    const length=settings.bb_reversal.bb_length,rows=candles.slice(Math.max(0,index-length+1),index+1);
    const basis=rows.length===length?rows.reduce((sum,row)=>sum+row.close,0)/length:null;
    const deviation=basis===null?null:Math.sqrt(rows.reduce((sum,row)=>sum+(row.close-basis)**2,0)/length)*settings.bb_reversal.bb_mult;
    const smaLength=settings.bb_reversal.sma_length,smaRows=candles.slice(Math.max(0,index-smaLength+1),index+1);
    return {time:c.time,bbBasis:basis,bbUpper:basis===null||deviation===null?null:basis+deviation,bbLower:basis===null||deviation===null?null:basis-deviation,trendSma:smaRows.length===smaLength?smaRows.reduce((sum,row)=>sum+row.close,0)/smaLength:null};
  }),[candles,settings.bb_reversal.bb_length,settings.bb_reversal.bb_mult,settings.bb_reversal.sma_length]);
  const loadHistory=useCallback(async(before:number)=>{
    const result=await api<{candles:number[][];hasMore:boolean}>(`/api/exchange/candles?venue=${venue}&timeframe=${timeframe}&before=${before}`);
    return {
      candles: exchangeBuckets(result.candles, duration).filter((candle) => candle.time < before),
      hasMore: result.hasMore,
    };
  },[venue,timeframe,duration]);
  const historyDownload=<MarketHistoryDownload key={`${venue}-${asset}`} venue={venue} symbol={data?.symbol??`${asset}/${venue==='hyperliquid'?'USDC':'USDT'}`} connected={connected}/>;
  const chartHeader=<TradingChartHeader symbol={data?.symbol??`${asset}/${venue==='hyperliquid'?'USDC':'USDT'}`} timeframe={timeframe} onTimeframeChange={changeTimeframe} mode={`${venue.toUpperCase()} LIVE MARKET`} caption={`${timeframe} exchange candles - streaming updates`}/>;
  return <section className={`terminal-panel price-panel live-price-panel ${candles.length?'has-live-candles':''}`}>{!candles.length&&<div className="chart-actions tv-toolbar compact-chart-toolbar chart-loading-toolbar"><div className="chart-toolbar-heading">{chartHeader}</div><div className="chart-navigation-tools">{historyDownload}</div>{toolbarEnd&&<div className="chart-toolbar-end">{toolbarEnd}</div>}</div>}{overlay}
    {(error||data?.errors.connection||data?.errors.candleStream||!connected)&&<p className="exchange-inline-error" role="status">{error||data?.errors.connection||data?.errors.candleStream||'Connecting to exchange stream…'}</p>}
    {candles.length?<StreamingPriceChart toolbarActions={historyDownload} toolbarEnd={toolbarEnd} header={chartHeader} key={`${venue}-${asset}-${timeframe}`} sessionId={0} allowLocalHistory={false} loadHistory={loadHistory} historyLabel="Pan left to load exchange history" symbol={data?.symbol??`${asset}/${venue==='hyperliquid'?'USDC':'USDT'}`} showSma={settings.bb_reversal.use_sma_trend_adjustment} timeframe={timeframe} atrLength={settings.bb_reversal.atr_length} adxLength={settings.bb_reversal.adx_length} candles={candles} indicators={indicators} stops={emptyStops} trades={emptyTrades} position={null} livePositions={data?.positions} indicatorClock={(data?.sectionTimes.candle??data?.sectionTimes.market??0)/1000}/>:<div className="chart-empty"><h3>{error?'Exchange chart unavailable':'Connecting to live market'}</h3><p>{venue.toUpperCase()} {asset}/USDT perpetual candles</p></div>}
  </section>;
}

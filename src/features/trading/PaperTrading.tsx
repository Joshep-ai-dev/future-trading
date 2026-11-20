import {useMarketTitle} from '../../shared/ui/useDocumentTitle';
import {MarketSyncContext} from '../../shared/api/useMarketSync';
import MarketDataInfo from '../../shared/ui/MarketDataInfo';
import MarketHeader from '../../shared/ui/MarketHeader';
import PaperMarketPicker from './PaperMarketPicker';
import ExecutionPanel,{ExecutionMessage} from './ExecutionPanel';
import BotPanel from './BotPanel';
import PaperOrderTicket from './PaperOrderTicket';
import type {ExchangeVenue} from '../../shared/api/exchangeVenue';
import type {ExecutionMode} from './ExecutionModeContext';
import {useMarketDatasets} from '../../shared/api/useMarketDatasets';
import {useDatasetSync} from '../../shared/api/useDatasetSync';
import {useLiveMarketMinutes} from '../../shared/charts/useLiveMarketMinutes';
import {mergeHistory} from '../../shared/charts/candleHistory';
import {useMarketDataRevision} from '../../shared/charts/marketDataRevision';
import {StatusBadge,TabBar,TableFrame} from '../../shared/ui/ui';
import {useChartTimeframe} from '../../shared/charts/useChartTimeframe';
import {TIMEFRAMES,chartPosition} from '../../shared/charts/chartTimeframe';
import TradeView from '../../shared/ui/TradeView';
import {STOP_COLORS,type StopPoint} from '../../shared/charts/StopOverlay';
import {FILL_COLORS} from '../../shared/charts/fillMarkers';
import {useContext,useEffect,useMemo,useRef,useState} from 'react';
import {api} from '../../shared/api/api';
import {EquityChart} from '../../shared/charts/BacktestChart';
import PaperPriceChart,{type ChartFocus} from '../../shared/charts/PaperPriceChart';
import {fmt,type Analysis,type BacktestSettings} from '../../shared/types/types';
import {candleAt,useReplayAnimation,type Candle} from './replayAnimation';
import {accountAt} from './replayAccount';
import {formatTradingTime,useTradingTimeZone,type TradingTimeZone} from '../../shared/charts/tradingTime';
import TradingChartHeader from '../../shared/charts/TradingChartHeader';
import TerminalSplitter from '../../shared/ui/TerminalSplitter';
import BotStatusPanel,{BotChartBadge} from './BotStatusPanel';
import {PaperSessionHistory} from './TradingHistory';
import PatternPanel from './PatternPanel';
import type {SavedSetup} from '../strategy/SetupPicker';
import type {StrategyState} from '../../shared/api/exchangeTypes';
import TradingWorkspaceTools,{PanelToggles,useWorkspacePanels} from './TradingWorkspaceTools';
import {PublicOrderBook} from './OrderBook';

export type Position={direction:number;entry_time:number;entry_price:number;quantity:number;stop:number;initial_stop?:number;trailing_active:boolean;stop_history?:StopPoint[];margin?:number;leverage?:number;take_profit?:number|null};
/** Resting virtual limit entry; it fills when the market trades at or through `price`. */
export type PendingOrder={id:string;type:'limit';direction:number;quantity:number;leverage:number;price:number;stop?:number|null;take_profit?:number|null;created_at:number};
export type PaperTrade=Position&{id:number;exit_time:number;exit_price:number;exit_reason:string;pnl:number};
type Session={executionMode?:ExecutionMode;pendingOrder?:PendingOrder|null;animationMinutes?:Candle[];formingCandle?:Candle|null;displayPrice?:number|null;displayEquity?:number;quoteError?:string|null;quoteTime?:number|null;chartCandles?:Candle[];chartIndicators?:{time:number;bbBasis:number|null;bbUpper:number|null;bbLower:number|null;trendSma:number|null}[];chartStops?:{time:number;price:number|null}[];mode?:'live'|'replay';speed?:number;virtualTime?:number;replayEnd?:number|null;completed?:boolean;running:boolean;startedAt:number;tradingFrom:number;lastProcessed:number|null;lastCheck:number|null;balance:number;equity:number;openPosition:Position|null;trades:PaperTrade[];equityHistory:{time:number;value:number}[];halted:boolean;latestPrice:number|null;signals:number;settings:BacktestSettings;strategyState?:StrategyState|null};
type Response={session:Session|null;error:string|null};
const date=(t:number|null,timeZone:TradingTimeZone)=>t===null?'Waiting':formatTradingTime(t,timeZone);

const compactNumber=new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:2});
const compact=(value:number|null)=>value===null||!Number.isFinite(value)?'—':compactNumber.format(value);
const signed=(value:number|null,digits:number)=>value===null?'—':`${value>=0?'+':''}${fmt(value,digits)}`;

/** Exchange-style 24h statistics from the loaded candles, plus the direction of the latest move. */
function tickerStats(candles:Analysis['candles'],duration:number,price:number|null){
  const last=candles.at(-1);
  if(!last)return {change:null,percent:null,high:null,low:null,volume:null,tick:'flat' as const};
  const cutoff=last.time+duration-86400;
  const day=candles.filter(c=>c.time>=cutoff);
  const open=day[0].open,close=price??last.close;
  let high=-Infinity,low=Infinity,volume=0;
  // Volume is in exchange contracts (the market files store volume_contracts).
  for(const c of day){high=Math.max(high,c.high);low=Math.min(low,c.low);volume+=c.volume??0;}
  const previous=candles.at(-2)?.close??open;
  return {change:close-open,percent:open?(close-open)/open*100:null,high,low,volume:volume||null,
    tick:close>previous?'up' as const:close<previous?'down' as const:'flat' as const};
}

export default function PaperTrading({settings,onChange,onConfigure,visible,profiles,onApplySetup,focus=null}:{settings:BacktestSettings;onChange:(s:BacktestSettings)=>void;onConfigure:()=>void;visible:boolean;profiles:SavedSetup[];onApplySetup:(setup:SavedSetup)=>void;focus?:ChartFocus|null}) {
  const datasets=useMarketDatasets();
  const marketSync=useContext(MarketSyncContext);
  const chosenDataset=datasets.find(item=>item.id===settings.market);
  const tradingTimeZone=useTradingTimeZone();
  const marketDataRevision=useMarketDataRevision();
  const [chartTimeframe,setChartTimeframe]=useState<BacktestSettings['entry_timeframe']>(settings.entry_timeframe);
  const [data,setData]=useState<Response>({session:null,error:null});
  const showingSession=!!data.session&&(data.session.running&&data.session.executionMode!=='manual'||data.session.settings.market===settings.market);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [panels,togglePanel]=useWorkspacePanels('silver.paper.panels');
  const controlsOpen=panels.order;
  const [executionMode,setExecutionMode]=useState<ExecutionMode>('manual');
  const [manualLeverage,setManualLeverage]=useState('1');
  useEffect(()=>{if(data.session?.executionMode==='manual')setManualLeverage(String(data.session.settings.max_leverage));},[data.session?.startedAt]);
  useEffect(()=>{if(data.session?.running&&data.session.executionMode!=='manual')setExecutionMode('bot');},[data.session?.startedAt]);
  // Public real-time XAG feed: the preview chart, and the display of a running live XAG session.
  const liveSession=showingSession&&data.session?.mode==='live'&&data.session.settings.market===settings.market;
  const liveMarket=useLiveMarketMinutes(visible&&(settings.market==='xag'||settings.market.startsWith('dataset:'))&&(!showingSession||!!liveSession),settings.market);
  const revision=useRef(0);
  const [bottomTab,setBottomTab]=useState<'position'|'history'|'equity'|'sessions'|'patterns'>('position');
  const [preview,setPreview]=useState<Analysis['candles']>([]),[previewError,setPreviewError]=useState('');
  useEffect(()=>{setPreview([]);setPreviewError('');},[settings.market]);
  useEffect(()=>{
    if(!visible||showingSession)return;
    const abort=new AbortController();
    void api<Analysis>('/api/analyze',{method:'POST',headers:{'Content-Type':'application/json'},signal:abort.signal,body:JSON.stringify({timeframe:'1m',...(settings.market==='xag'?{}:{market:settings.market})})}).then(value=>{setPreview(value.candles);setPreviewError('');}).catch(e=>{if(!abort.signal.aborted)setPreviewError(String(e));});
    return ()=>abort.abort();
  },[visible,showingSession,marketDataRevision,settings.market]);
  useEffect(()=>{
    let active=true,pending=false;
    async function poll(){
      if(pending)return;pending=true;const requestRevision=revision.current;
      try{const value=await api<Response>('/api/paper');if(active&&requestRevision===revision.current){setData(value);setError('');}}
      catch(e){if(active)setError(String(e));}finally{pending=false;}
    }
    void poll();const timer=setInterval(poll,visible?1000:5000);
    return ()=>{active=false;clearInterval(timer);};
  },[visible]);
  async function action(action:'start'|'pause'|'resume') {
    if(settings.strategy==='none'&&action!=='pause')return;
    revision.current++;setBusy(true);setError('');
    try{
      if(action==='start'&&data.session?.openPosition)throw new Error('Close the existing paper position before starting a new session.');
      if(action==='start'&&data.session?.executionMode==='manual'&&data.session.running)await api('/api/paper/pause',{method:'POST'});
      setData(await api<Response>(`/api/paper/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},...(action==='start'?{body:JSON.stringify({...settings,execution_mode:'bot',paper_mode:settings.market==='stable'?'replay':'live',...(settings.market!=='stable'?{}:{replay_start:chosenDataset?.startDate??settings.start_date,replay_end:chosenDataset?.endDate??settings.end_date})})}:{})}));}
    catch(e){setError(String(e));}finally{revision.current++;setBusy(false);}
  }
  async function manualAction(path:string,body:unknown){
    if(busy)return false;
    setBusy(true);setError('');revision.current++;
    try{
      let current=data.session;
      if(path.endsWith('/order')&&(!current||current.executionMode!=='manual'||current.settings.market!==settings.market)){
        if(current?.openPosition||current?.running&&current.executionMode!=='manual')throw new Error('Pause the bot and close its position before manual trading.');
        if(current?.running)await api('/api/paper/pause',{method:'POST'});
        const started=await api<Response>('/api/paper/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...settings,strategy:'none',execution_mode:'manual',paper_mode:'live',max_leverage:Number(manualLeverage)})});
        current=started.session;setData(started);
      }
      const result=await api<Response>(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      setData(result);return true;
    }catch(reason){setError(String(reason));return false;}
    finally{revision.current++;setBusy(false);}
  }
  const s=showingSession?data.session:null;
  const activeMarket=s?.settings.market??settings.market;
  const datasetSync=useDatasetSync(activeMarket,visible);
  const activeDataset=datasets.find(item=>item.id===activeMarket);
  const paperSymbol=activeDataset?.symbol??(activeMarket==='stable'?'STABLE/USDT':'XAG/USDT');
  const paperBase=paperSymbol.split('/')[0],paperQuote=paperSymbol.split('/')[1]?.split(':')[0]??'USDT';
  const previewMinutes=useMemo(()=>mergeHistory(preview,liveMarket.minutes),[preview,liveMarket.minutes,settings.market]);
  const durations=TIMEFRAMES;
  const duration=durations[s?.settings.entry_timeframe??settings.entry_timeframe];
  const tradeDuration=s?.executionMode==='manual'?0:duration;
  const displayClock=useReplayAnimation(visible&&s?.mode==='replay',s?.startedAt??0,s?.virtualTime??0);
  // Display only: a live session's forming candle follows the real-time ticker between session polls.
  const tick=liveSession?liveMarket.minutes.at(-1):undefined;
  const sessionForming=s?.formingCandle&&tick&&tick.time>=s.formingCandle.time&&tick.time<s.formingCandle.time+duration
    ?{...s.formingCandle,close:tick.close,high:Math.max(s.formingCandle.high,tick.close),low:Math.min(s.formingCandle.low,tick.close)}
    :s?.formingCandle;
  const animated=s?.mode==='replay'&&s.animationMinutes?.length?candleAt(s.animationMinutes,displayClock,duration):sessionForming;
  const chartCandles=s?[...(s.chartCandles??[]).filter(c=>(s.mode!=='replay'||c.time+duration<=displayClock)&&(!animated||c.time<animated.time)),...(animated?[animated]:[])]:[];
  const chartIndicators=(s?.chartIndicators??[]).filter(row=>s?.mode!=='replay'||row.time+duration<=displayClock);
  const chartStops=(s?.chartStops??[]).filter(row=>s?.mode!=='replay'||row.time+duration<=displayClock);
  useEffect(()=>{if(s)setChartTimeframe(s.settings.entry_timeframe);},[s?.startedAt]);
  const config=s?.running?s.settings:settings;
  const price=s?(s.mode==='replay'?(animated?.close??chartCandles.at(-1)?.close??null):(tick&&sessionForming!==s.formingCandle?tick.close:(s.displayPrice??s.latestPrice))):liveMarket.minutes.at(-1)?.close??preview.at(-1)?.close??null;

  const replay=s?.mode==='replay'?accountAt(s.trades,s.openPosition,s.settings.capital,displayClock,duration,price,chartStops):null;
  const p=replay?.open??(replay?null:s?.openPosition??null);
  const chartTrades=replay?.closed??s?.trades??[];
  const balance=replay?.balance??s?.balance??settings.capital;
  const equity=replay?.equity??(s?(s.displayEquity??s.equity):settings.capital);
  const active=s?.settings??settings;
  const botRunning=!!s?.running&&s.executionMode!=='manual';
  const sessionError=error||data.error||s?.quoteError;
  const leverage=(s?.settings??settings).max_leverage,unrealized=equity-balance,margin=p?p.entry_price*p.quantity/Math.max(1,leverage):0;
  const status=s?.halted?(balance>0?'Risk limit reached':'Balance depleted'):s?.completed?'Replay complete':s?.running?'Running':s?'Paused':'Ready to start';
  const chartDuration=TIMEFRAMES[chartTimeframe];
  const alternate=!!s&&chartTimeframe!==s.settings.entry_timeframe;
  const chartView=useChartTimeframe(s?chartTimeframe:settings.entry_timeframe,s?.startedAt??0,s?(s.mode==='replay'?displayClock:s.quoteTime??s.virtualTime??0):liveMarket.checkedAt??Date.now()/1000,visible,s?.animationMinutes??previewMinutes,(s?.settings??settings).bb_reversal,s?.mode==='replay',activeMarket);
  const view=chartView.view;
  const viewForming=view.forming;
  const visibleCandles=alternate||!s?(view?[...view.candles.filter(c=>(s?.mode!=='replay'||c.time+chartDuration<=displayClock)&&(!viewForming||c.time<viewForming.time)),...(viewForming?[viewForming]:[])]:[]):s?chartCandles:preview;
  const visibleIndicators=alternate||!s?(view?.indicators??[]).filter(c=>s?.mode!=='replay'||c.time+chartDuration<=displayClock):chartIndicators;
  const visibleTrades=alternate?chartTrades.map(t=>chartPosition(t,duration,chartDuration)):chartTrades;
  const visiblePosition=alternate&&p?chartPosition(p,duration,chartDuration):p;
  const hasChart=visibleCandles.length>0;
  const ticker=useMemo(()=>tickerStats(visibleCandles,chartDuration,price),[visibleCandles,chartDuration,price]);
  function changeChartTimeframe(value:BacktestSettings['entry_timeframe']){setChartTimeframe(value);if(!s){onChange({...settings,entry_timeframe:value});}}
  const chartHeader=<TradingChartHeader symbol={paperSymbol} timeframe={s?chartTimeframe:settings.entry_timeframe} onTimeframeChange={value=>changeChartTimeframe(value as BacktestSettings['entry_timeframe'])} mode={s?s.executionMode==='manual'?'MANUAL PAPER':s.mode==='replay'?'HISTORICAL REPLAY':'PAPER SESSION':'MARKET PREVIEW'} caption={s?.executionMode==='manual'?'Manual orders use virtual funds and current exchange prices':s?`Bot executes on ${s.settings.entry_timeframe} candles`:'Choose a timeframe to view the market chart'}/>;
  useMarketTitle(visible,price==null?null:fmt(price,3),`${paperBase}/${paperQuote}`);
  const panelToggles=<PanelToggles panels={panels} onToggle={togglePanel} bookId="paper-order-book" actionId="paper-execution-sidebar"/>;
  return <div id="page-paper" role="tabpanel" aria-labelledby="tab-paper" hidden={!visible}>
    <div className="terminal-grid" data-controls={controlsOpen?'visible':'hidden'}><div className={panels.book?"terminal-main has-order-book":"terminal-main"}>
    <MarketHeader
      analysisTimeframe={s?chartTimeframe:settings.entry_timeframe}
      analysisSymbol={paperSymbol}
      active={visible}
      icon={paperBase==='XAG'?'Ag':paperBase.slice(0,2)}
      selector={<PaperMarketPicker symbol={paperSymbol} market={activeMarket} datasets={datasets} disabled={busy||!!data.session?.openPosition||!!data.session?.running&&data.session.executionMode!=='manual'} onChange={market=>onChange({...settings,market})}/>}
      price={fmt(price,3)}
      quote={paperQuote}
      direction={ticker.tick}
      info={<MarketDataInfo source={activeDataset?.venue.toUpperCase()??'OKX'} timestamp={activeDataset?(datasetSync.lastSuccess??activeDataset.end)*1000:marketSync?.lastSuccess?marketSync.lastSuccess*1000:null} label={activeDataset&&!datasetSync.lastSuccess?'Last candle':'Synced'} syncing={activeDataset?datasetSync.running:!!marketSync?.running} error={activeDataset?datasetSync.error:!!marketSync?.error}/>}
      metrics={[
        {label:'24h change',value:ticker.change===null?'\u2014':`${signed(ticker.change,3)} ${signed(ticker.percent,2)}%`,tone:(ticker.change??0)<0?'negative':'positive'},
        {label:'24h high / low',value:`${fmt(ticker.high,3)} / ${fmt(ticker.low,3)}`},
        {label:'24h volume',value:compact(ticker.volume),unit:'Cont.'},
      ]}
      actions={<TradingWorkspaceTools mode="paper" open={controlsOpen} onToggle={()=>togglePanel('order')} panelId="paper-execution-sidebar"/>}
    />
      <section className="terminal-panel price-panel">{!hasChart&&<div className="chart-actions tv-toolbar compact-chart-toolbar chart-loading-toolbar"><div className="chart-toolbar-heading">{chartHeader}</div><div className="chart-toolbar-end">{panelToggles}</div></div>}<BotChartBadge state={s?.strategyState} running={!!s?.running&&s.executionMode!=='manual'}/>
        {hasChart?<PaperPriceChart key={`${activeMarket}-${s?.startedAt??0}`} market={activeMarket} symbol={paperSymbol} toolbarEnd={panelToggles} header={chartHeader} focus={focus} atrLength={(s?.settings??settings).bb_reversal.atr_length} adxLength={(s?.settings??settings).bb_reversal.adx_length} indicatorClock={s?(s.mode==='replay'?displayClock:s.quoteTime??s.virtualTime??0):Date.now()/1000} timeframe={s?chartTimeframe:settings.entry_timeframe} sessionId={s?.startedAt??0} candles={visibleCandles} indicators={visibleIndicators} stops={alternate?[]:chartStops} trades={visibleTrades} position={visiblePosition??null} showSma={settings.strategy!=='none'&&(s?.settings??settings).bb_reversal.use_sma_trend_adjustment!==false}/>:<div className="chart-empty"><span className="empty-chart-icon">⌁</span><h3>{chartView.error||previewError?'Chart unavailable':'Preparing your chart'}</h3><p>{previewError||'Loading downloaded market candles…'}</p></div>}
        {alternate&&chartView.error&&hasChart&&<p className="chart-history-status error" role="alert">{chartView.error}</p>}
        <div className="chart-legend"><span><b style={{color:FILL_COLORS.buy}}>↑</b> Buy / close short</span><span><b style={{color:FILL_COLORS.sell}}>↓</b> Sell / close long</span><span><i className="legend-line" style={{borderColor:STOP_COLORS.initial}}/> Stop loss</span><span><i className="legend-line" style={{borderColor:STOP_COLORS.trailing}}/> Trailing stop / TRAIL activation</span></div>
        {!s&&(liveMarket.error||liveMarket.stale)&&<p className="chart-history-status" role="status">{liveMarket.error||'Waiting for fresh public market candles. Existing history remains visible.'}</p>}
      </section>
      {panels.book&&<PublicOrderBook active={visible} base={paperBase} unavailable={settings.market!=='xag'||s?.mode==='replay'?'The order book is available for live XAG paper trading only.':undefined}/>}
      <TerminalSplitter/>
      <section className="terminal-panel activity-panel exchange-activity">
        <TabBar items={[
          {value:'position',label:'Open position',count:p?1:0,controls:'activity-position'},
          {value:'history',label:'Trade history',count:chartTrades.length,controls:'activity-history'},
          {value:'equity',label:'Equity',controls:'activity-equity'},
          {value:'sessions',label:'Past sessions',controls:'activity-sessions'},
          {value:'patterns',label:'Patterns',controls:'activity-patterns'},
        ] as const} value={bottomTab} onChange={setBottomTab} label="Paper account activity" idPrefix="activity-tab" trailing={<StatusBadge>Paper account</StatusBadge>}/>
        <div id="activity-position" role="tabpanel" aria-labelledby="activity-tab-position" hidden={bottomTab!=='position'}>{p?<TableFrame label={`Open ${paperBase} paper position`} columns={['Contract','Mark price','Entry price',`Margin (${paperQuote})`,'Unrealized PnL','PnL (%)','Stop price',`Size (${paperBase})`,'Opened']}><tr>
          <td><strong>{paperBase}/{paperQuote} <small>Perpetual</small></strong><div className="exchange-position-tags"><StatusBadge tone={p.direction===1?'positive':'negative'}>{p.direction===1?'LONG':'SHORT'}</StatusBadge><StatusBadge>{fmt(leverage,1)}x</StatusBadge><StatusBadge>{p.trailing_active?'Trailing':'Initial stop'}</StatusBadge></div></td>
          <td>{fmt(price,3)}</td><td>{fmt(p.entry_price,3)}</td><td>{fmt(margin,4)}</td>
          <td className={unrealized<0?'negative':'positive'}>{unrealized>=0?'+':''}{fmt(unrealized,4)} <small>{paperQuote}</small></td>
          <td className={unrealized<0?'negative':'positive'}>{margin?fmt(unrealized/margin*100,2):'—'}%</td>
          <td>{p.stop?fmt(p.stop,3):'Off'}</td><td>{fmt(p.quantity,4)}</td><td>{date(p.entry_time+tradeDuration,tradingTimeZone)}</td>
        </tr></TableFrame>:<div className="empty-position"><span className="empty-state-symbol">◇</span><h3>{s?.running?'Watching for your next setup':'No open position'}</h3><p>{s?.running?(active.strategy==='adx_supertrend'?'The bot opens a trade when ADX confirms a Supertrend trend and every enabled filter passes.':active.strategy==='st_scalper'?'The bot enters at the next open after a filtered SuperTrend flip.':'The bot is scanning each completed candle for its next entry.'):settings.strategy==='none'?'No automated strategy is configured. Market viewing and past sessions remain available.':'Start a virtual session to see entries, stops and position P&L here.'}</p></div>}</div>
        <div id="activity-history" role="tabpanel" aria-labelledby="activity-tab-history" hidden={bottomTab!=='history'}><TradeView key={s?.startedAt??0} scope="Session" capital={s?.settings.capital??settings.capital} timeZone={tradingTimeZone} unrealized={equity-balance} trades={chartTrades.map(t=>({id:t.id,direction:t.direction,pnl:t.pnl,entry:t.entry_price,exit:t.exit_price,quantity:t.quantity,exitTime:t.exit_time+tradeDuration}))}>{chartTrades.length?<div className="table-scroll"><table><thead><tr>{['ID','Side','Leverage',`Entry time (${tradingTimeZone})`,'Entry','Exit','Quantity','P&L','Exit reason'].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{chartTrades.slice(-100).reverse().map(t=><tr key={t.id}><td>#{t.id}</td><td><span className={`side-badge ${t.direction===1?'long':'short'}`}>{t.direction===1?'LONG':'SHORT'}</span></td><td>{fmt(leverage,1)}x</td><td>{date(t.entry_time+tradeDuration,tradingTimeZone)}</td><td>{fmt(t.entry_price,3)}</td><td>{fmt(t.exit_price,3)}</td><td>{fmt(t.quantity,4)}</td><td className={t.pnl>=0?'positive':'negative'}>{t.pnl>=0?'+':''}{fmt(t.pnl)}</td><td>{t.exit_reason==='rsi_price_exit'?'RSI + price exit':t.exit_reason.replaceAll('_',' ')}</td></tr>)}</tbody></table></div>:<div className="empty-position"><h3>Your trade history starts here</h3><p>Closed virtual trades appear automatically as the bot runs.</p></div>}</TradeView></div>
        <div id="activity-equity" role="tabpanel" aria-labelledby="activity-tab-equity" hidden={bottomTab!=='equity'}>{chartTrades.length?<EquityChart key={s?.startedAt??0} period={{name:'Paper trading'}} initialValue={s?.settings.capital??settings.capital} trades={chartTrades.map(t=>({pnl:t.pnl}))}/>:<div className="empty-position"><h3>No closed trades yet</h3><p>The balance curve adds one point after each trade closes.</p></div>}</div>
        <div id="activity-patterns" role="tabpanel" aria-labelledby="activity-tab-patterns" hidden={bottomTab!=='patterns'}>{bottomTab==='patterns'&&<PatternPanel key={activeMarket} market={activeMarket} defaultTimeframe={(s?.settings??settings).entry_timeframe}/>}</div>
        <div id="activity-sessions" role="tabpanel" aria-labelledby="activity-tab-sessions" hidden={bottomTab!=='sessions'}>{bottomTab==='sessions'&&<PaperSessionHistory refreshKey={s?.startedAt}/>}</div>
      </section>
    </div>
    <aside id="paper-execution-sidebar" className="terminal-sidebar" aria-label="Paper trading controls" hidden={!controlsOpen}>
      <ExecutionPanel prefix="paper-execution" mode={executionMode} onModeChange={setExecutionMode}
        status={<div className="ticket-connection"><StatusBadge tone="positive" dot>Virtual funds · {(activeDataset?.venue??'okx').toUpperCase()} prices</StatusBadge></div>}
        manual={<PaperOrderTicket key={activeMarket} asset={paperBase} venue={(activeDataset?.venue??'okx') as ExchangeVenue} price={price} balance={balance} position={p} pendingOrder={s?.pendingOrder??null} busy={busy} botRunning={botRunning||s?.mode==='replay'} fresh={!liveMarket.stale&&!liveMarket.error&&liveMarket.checkedAt!=null&&Date.now()/1000-liveMarket.checkedAt<20} leverage={manualLeverage} onLeverageChange={setManualLeverage} onRun={manualAction} initialBalance={s?undefined:{value:settings.capital,onChange:capital=>onChange({...settings,capital})}}/>}
        bot={<BotPanel settings={config} onSettingsChange={onChange} profiles={profiles} onApplySetup={onApplySetup} onConfigure={onConfigure}
          running={botRunning} busy={busy} locked={busy||botRunning}
          funds={{label:'Starting balance',value:config.capital,unit:paperQuote,onChange:capital=>onChange({...settings,capital})}}
          leverage={{value:String(config.max_leverage),min:1,max:100,step:.5,onChange:value=>onChange({...settings,max_leverage:Number(value)})}}
          allocation={{amountLabel:'Amount per trade',amountCap:config.capital,amountHint:'Allocation before leverage. Capped at available balance.'}}
          canStart={!busy} startLabel={s?'＋ Start new session':'▶ Start virtual bot'} stopLabel="Ⅱ Pause bot" onStart={()=>void action('start')} onStop={()=>void action('pause')}
          secondaryActions={s&&s.executionMode!=='manual'&&!s.halted&&!s.completed&&<button type="button" className="secondary resume-button" disabled={busy} onClick={()=>void action('resume')}>Resume saved session</button>}
          emptyText="The market chart and account history remain available. Automated paper trading is disabled." emptyStopLabel="Pause existing session">
          <p className="ticket-help">Paper session: {status}</p>
        </BotPanel>}
        footer={sessionError&&<ExecutionMessage text={sessionError} error/>}/>
    <BotStatusPanel state={s?.strategyState} running={!!s?.running&&s.executionMode!=='manual'} timeLabel={s?.strategyState?.timestamp?date(s.strategyState.timestamp+duration,tradingTimeZone):undefined} emptyHint={settings.strategy==='none'?'No automated strategy is configured. The market chart and past sessions remain available.':s?'Readiness appears after the bot processes its first completed candle.':'Start a virtual session to see buy and sell readiness.'}/>
    <details className="terminal-help"><summary>How this simulation works</summary><p>OKX prices update continuously; HTX and Hyperliquid prices refresh every 5 seconds. Bots use completed execution candles.</p><p>Keep the backend running. Live catches up missed candles. A balance at or below zero halts trading.</p><p>Manual fills and TP/SL use received exchange prices, with isolated virtual liquidation. Fees, slippage and funding are not modeled. Keep the backend running for position updates.</p>{s&&<p>Last execution check: {date(s.lastCheck,tradingTimeZone)}<br/>Last completed candle: {date(s.lastProcessed,tradingTimeZone)}</p>}</details>
    </aside></div>

  </div>;
}

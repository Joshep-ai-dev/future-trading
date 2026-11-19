import {useMarketTitle} from '../../shared/ui/useDocumentTitle';
import {MarketSyncContext} from '../../shared/api/useMarketSync';
import MarketDataInfo from '../../shared/ui/MarketDataInfo';
import MarketHeader from '../../shared/ui/MarketHeader';
import PaperMarketPicker from './PaperMarketPicker';
import {useMarketDatasets} from '../../shared/api/useMarketDatasets';
import {useDatasetSync} from '../../shared/api/useDatasetSync';
import {useLiveMarketMinutes} from '../../shared/charts/useLiveMarketMinutes';
import {adxSupertrendDefaults,stScalperDefaults} from '../strategy/strategyDefaults';
import {mergeHistory} from '../../shared/charts/candleHistory';
import {useMarketDataRevision} from '../../shared/charts/marketDataRevision';
import {Metric,StatusBadge,TabBar,TableFrame} from '../../shared/ui/ui';
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
import BotSelector from '../strategy/BotSelector';
import type {SavedSetup} from '../strategy/SetupPicker';
import type {StrategyState} from '../../shared/api/exchangeTypes';
import TradingWorkspaceTools,{PanelToggles,useWorkspacePanels} from './TradingWorkspaceTools';
import {PublicOrderBook} from './OrderBook';

export type Position={direction:number;entry_time:number;entry_price:number;quantity:number;stop:number;initial_stop?:number;trailing_active:boolean;stop_history?:StopPoint[]};
export type PaperTrade=Position&{id:number;exit_time:number;exit_price:number;exit_reason:string;pnl:number};
type Session={animationMinutes?:Candle[];formingCandle?:Candle|null;displayPrice?:number|null;displayEquity?:number;quoteError?:string|null;quoteTime?:number|null;chartCandles?:Candle[];chartIndicators?:{time:number;bbBasis:number|null;bbUpper:number|null;bbLower:number|null;trendSma:number|null}[];chartStops?:{time:number;price:number|null}[];mode?:'live'|'replay';speed?:number;virtualTime?:number;replayEnd?:number|null;completed?:boolean;running:boolean;startedAt:number;tradingFrom:number;lastProcessed:number|null;lastCheck:number|null;balance:number;equity:number;openPosition:Position|null;trades:PaperTrade[];equityHistory:{time:number;value:number}[];halted:boolean;latestPrice:number|null;signals:number;settings:BacktestSettings;strategyState?:StrategyState|null};
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

/** Plain-language rules of the active SuperTrend Scalper setup for the bot panel. */
function scalperRules(settings:BacktestSettings):[string,string][]{
  const c={...stScalperDefaults,...settings.st_scalper};
  const filters=[c.use_trend_filter&&`${c.htf_timeframe} EMA ${c.htf_ema_length} + EMA ${c.ema_fast_length}`,c.use_adx_filter&&`ADX > ${c.adx_threshold}`,c.use_rsi_filter&&'RSI band',
    c.use_volatility_filter&&'ATR percentile',c.use_regime_filter&&'regime',c.use_session_filter&&c.sessions.join('/'),c.use_news_filter&&'news',c.use_volume_filter&&'volume'].filter(Boolean).join(' · ');
  return [
    ['Entry',`SuperTrend ${c.st_length}/${c.st_multiplier} flip, next-candle open`],
    ['Exit',c.use_atr_exits?`SL ${c.stop_atr} · TP ${c.target_atr} ATR · BE ${c.breakeven_atr} · trail ${c.trail_atr} · ${c.max_hold_bars} candles`:'Opposite flip (stop and reverse)'],
    ['Filters',filters||'None'],
    ['Risk',`${c.risk_pct}% of equity per trade`],
  ];
}

/** Plain-language rules of the active ADX + Supertrend setup for the bot panel. */
function adxSupertrendRules(settings:BacktestSettings):[string,string][]{
  const c={...adxSupertrendDefaults,...settings.adx_supertrend};
  const filters=[c.htf_filter&&`${c.htf_timeframe} trend`,c.atr_filter&&`ATR ≥ ${c.atr_min}`,c.rsi_filter&&`RSI ${c.rsi_overbought}/${c.rsi_oversold}`,c.forecast_filter&&`forecast ≥ ${Math.round(c.forecast_min_probability*100)}%`].filter(Boolean).join(' · ');
  return [
    ['Entry',`ADX ≥ ${c.adx_threshold} and rising, Supertrend ${c.st_length}/${c.st_multiplier} direction`],
    ['Exit','Supertrend trailing stop or opposite flip'],
    ['Filters',filters||'None'],
    ['Direction',c.trade_mode],
  ];
}

export default function PaperTrading({settings,onChange,onConfigure,visible,profiles,onApplySetup,focus=null}:{settings:BacktestSettings;onChange:(s:BacktestSettings)=>void;onConfigure:()=>void;visible:boolean;profiles:SavedSetup[];onApplySetup:(setup:SavedSetup)=>void;focus?:ChartFocus|null}) {
  const datasets=useMarketDatasets();
  const marketSync=useContext(MarketSyncContext);
  const chosenDataset=datasets.find(item=>item.id===settings.market);
  const tradingTimeZone=useTradingTimeZone();
  const marketDataRevision=useMarketDataRevision();
  const [chartTimeframe,setChartTimeframe]=useState<BacktestSettings['entry_timeframe']>(settings.entry_timeframe);
  const [data,setData]=useState<Response>({session:null,error:null});
  const showingSession=!!data.session&&(data.session.running||data.session.settings.market===settings.market);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [panels,togglePanel]=useWorkspacePanels('silver.paper.panels');
  const controlsOpen=panels.order;
  // Public real-time XAG feed: the preview chart, and the display of a running live XAG session.
  const liveSession=showingSession&&data.session?.mode==='live'&&data.session.settings.market==='xag';
  const liveMarket=useLiveMarketMinutes(visible&&settings.market==='xag'&&(!showingSession||liveSession));
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
    try{setData(await api<Response>(`/api/paper/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},...(action==='start'?{body:JSON.stringify({...settings,paper_mode:settings.market==='xag'?'live':'replay',...(settings.market==='xag'?{}:{replay_start:chosenDataset?.startDate??settings.start_date,replay_end:chosenDataset?.endDate??settings.end_date})})}:{})}));}
    catch(e){setError(String(e));}finally{revision.current++;setBusy(false);}
  }
  const s=showingSession?data.session:null;
  const activeMarket=s?.settings.market??settings.market;
  const datasetSync=useDatasetSync(activeMarket,visible);
  const activeDataset=datasets.find(item=>item.id===activeMarket);
  const paperSymbol=activeDataset?.symbol??(activeMarket==='stable'?'STABLE/USDT':'XAG/USDT');
  const paperBase=paperSymbol.split('/')[0],paperQuote=paperSymbol.split('/')[1]?.split(':')[0]??'USDT';
  const previewMinutes=useMemo(()=>mergeHistory(preview,settings.market==='xag'?liveMarket.minutes:[]),[preview,liveMarket.minutes,settings.market]);
  const durations=TIMEFRAMES;
  const duration=durations[s?.settings.entry_timeframe??settings.entry_timeframe];
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
  const price=s?(s.mode==='replay'?(animated?.close??chartCandles.at(-1)?.close??null):(tick&&sessionForming!==s.formingCandle?tick.close:(s.displayPrice??s.latestPrice))):(settings.market==='xag'?liveMarket.minutes.at(-1)?.close:undefined)??preview.at(-1)?.close??null;

  const replay=s?.mode==='replay'?accountAt(s.trades,s.openPosition,s.settings.capital,displayClock,duration,price,chartStops):null;
  const p=replay?.open??(replay?null:s?.openPosition??null);
  const chartTrades=replay?.closed??s?.trades??[];
  const balance=replay?.balance??s?.balance??settings.capital;
  const equity=replay?.equity??(s?(s.displayEquity??s.equity):settings.capital);
  const pnl=s?equity-s.settings.capital:0;
  const adxSt=config.strategy==='adx_supertrend';
  const sizing=adxSt?(config.adx_supertrend??adxSupertrendDefaults):config.bb_reversal;
  const setSizing=(patch:{amount_per_trade?:number;amount_unit?:'price'|'percent'})=>adxSt
    ?onChange({...settings,adx_supertrend:{...adxSupertrendDefaults,...settings.adx_supertrend,...patch}})
    :onChange({...settings,bb_reversal:{...settings.bb_reversal,...patch}});
  const directional=config.strategy==='ml_directional';
  const scalper=config.strategy==='st_scalper';
  const active=s?.settings??settings,activeDirectional=active.strategy==='ml_directional',ml=active.ml_directional;
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
  const chartHeader=<TradingChartHeader symbol={paperSymbol} timeframe={s?chartTimeframe:settings.entry_timeframe} onTimeframeChange={value=>changeChartTimeframe(value as BacktestSettings['entry_timeframe'])} mode={s?s.mode==='replay'?'HISTORICAL REPLAY':'PAPER SESSION':'MARKET PREVIEW'} caption={s?`Bot executes on ${s.settings.entry_timeframe} candles`:'Choose a timeframe to view the market chart'}/>;
  useMarketTitle(visible,price==null?null:fmt(price,3),`${paperBase}/${paperQuote}`);
  const panelToggles=<PanelToggles panels={panels} onToggle={togglePanel} bookId="paper-order-book" actionId="paper-execution-sidebar"/>;
  return <div id="page-paper" role="tabpanel" aria-labelledby="tab-paper" hidden={!visible}>
    <div className="terminal-grid" data-controls={controlsOpen?'visible':'hidden'}><div className={panels.book?"terminal-main has-order-book":"terminal-main"}>
    <MarketHeader
      analysisTimeframe={s?chartTimeframe:settings.entry_timeframe}
      analysisSymbol={paperSymbol}
      active={visible}
      icon={paperBase==='XAG'?'Ag':paperBase.slice(0,2)}
      selector={<PaperMarketPicker symbol={paperSymbol} market={activeMarket} datasets={datasets} disabled={busy||!!data.session?.running} onChange={market=>onChange({...settings,market})}/>}
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
      <section className="terminal-panel price-panel">{!hasChart&&<div className="chart-actions tv-toolbar compact-chart-toolbar chart-loading-toolbar"><div className="chart-toolbar-heading">{chartHeader}</div><div className="chart-toolbar-end">{panelToggles}</div></div>}<BotChartBadge state={s?.strategyState} running={!!s?.running}/>
        {hasChart?<PaperPriceChart key={`${activeMarket}-${s?.startedAt??0}`} market={activeMarket} symbol={paperSymbol} toolbarEnd={panelToggles} header={chartHeader} focus={focus} atrLength={(s?.settings??settings).bb_reversal.atr_length} adxLength={(s?.settings??settings).bb_reversal.adx_length} indicatorClock={s?(s.mode==='replay'?displayClock:s.quoteTime??s.virtualTime??0):Date.now()/1000} timeframe={s?chartTimeframe:settings.entry_timeframe} sessionId={s?.startedAt??0} candles={visibleCandles} indicators={visibleIndicators} stops={alternate?[]:chartStops} trades={visibleTrades} position={visiblePosition??null} showSma={settings.strategy!=='none'&&(s?.settings??settings).bb_reversal.use_sma_trend_adjustment!==false}/>:<div className="chart-empty"><span className="empty-chart-icon">⌁</span><h3>{chartView.error||previewError?'Chart unavailable':'Preparing your chart'}</h3><p>{previewError||'Loading downloaded market candles…'}</p></div>}
        {alternate&&chartView.error&&hasChart&&<p className="chart-history-status error" role="alert">{chartView.error}</p>}
        <div className="chart-legend"><span><b style={{color:FILL_COLORS.buy}}>↑</b> Buy / close short</span><span><b style={{color:FILL_COLORS.sell}}>↓</b> Sell / close long</span><span><i className="legend-line" style={{borderColor:STOP_COLORS.initial}}/> Stop loss</span><span><i className="legend-line" style={{borderColor:STOP_COLORS.trailing}}/> Trailing stop / TRAIL activation</span></div>
        {!s&&settings.market==='xag'&&(liveMarket.error||liveMarket.stale)&&<p className="chart-history-status" role="status">{liveMarket.error||'Waiting for fresh public market candles. Existing history remains visible.'}</p>}
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
          <td>{fmt(p.stop,3)}</td><td>{fmt(p.quantity,4)}</td><td>{date(p.entry_time+duration,tradingTimeZone)}</td>
        </tr></TableFrame>:<div className="empty-position"><span className="empty-state-symbol">◇</span><h3>{s?.running?'Watching for your next setup':'No open position'}</h3><p>{s?.running?(active.strategy==='adx_supertrend'?'The bot opens a trade when ADX confirms a Supertrend trend and every enabled filter passes.':active.strategy==='st_scalper'?'The bot enters at the next open after a filtered SuperTrend flip.':'The bot is scanning each completed candle for its next entry.'):settings.strategy==='none'?'No automated strategy is configured. Market viewing and past sessions remain available.':'Start a virtual session to see entries, stops and position P&L here.'}</p></div>}</div>
        <div id="activity-history" role="tabpanel" aria-labelledby="activity-tab-history" hidden={bottomTab!=='history'}><TradeView key={s?.startedAt??0} scope="Session" capital={s?.settings.capital??settings.capital} timeZone={tradingTimeZone} unrealized={equity-balance} trades={chartTrades.map(t=>({id:t.id,direction:t.direction,pnl:t.pnl,entry:t.entry_price,exit:t.exit_price,quantity:t.quantity,exitTime:t.exit_time+duration}))}>{chartTrades.length?<div className="table-scroll"><table><thead><tr>{['ID','Side','Leverage',`Entry time (${tradingTimeZone})`,'Entry','Exit','Quantity','P&L','Exit reason'].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{chartTrades.slice(-100).reverse().map(t=><tr key={t.id}><td>#{t.id}</td><td><span className={`side-badge ${t.direction===1?'long':'short'}`}>{t.direction===1?'LONG':'SHORT'}</span></td><td>{fmt(leverage,1)}x</td><td>{date(t.entry_time+duration,tradingTimeZone)}</td><td>{fmt(t.entry_price,3)}</td><td>{fmt(t.exit_price,3)}</td><td>{fmt(t.quantity,4)}</td><td className={t.pnl>=0?'positive':'negative'}>{t.pnl>=0?'+':''}{fmt(t.pnl)}</td><td>{t.exit_reason==='rsi_price_exit'?'RSI + price exit':t.exit_reason.replaceAll('_',' ')}</td></tr>)}</tbody></table></div>:<div className="empty-position"><h3>Your trade history starts here</h3><p>Closed virtual trades appear automatically as the bot runs.</p></div>}</TradeView></div>
        <div id="activity-equity" role="tabpanel" aria-labelledby="activity-tab-equity" hidden={bottomTab!=='equity'}>{chartTrades.length?<EquityChart key={s?.startedAt??0} period={{name:'Paper trading'}} initialValue={s?.settings.capital??settings.capital} trades={chartTrades.map(t=>({pnl:t.pnl}))}/>:<div className="empty-position"><h3>No closed trades yet</h3><p>The balance curve adds one point after each trade closes.</p></div>}</div>
        <div id="activity-patterns" role="tabpanel" aria-labelledby="activity-tab-patterns" hidden={bottomTab!=='patterns'}>{bottomTab==='patterns'&&<PatternPanel key={activeMarket} market={activeMarket} defaultTimeframe={(s?.settings??settings).entry_timeframe}/>}</div>
        <div id="activity-sessions" role="tabpanel" aria-labelledby="activity-tab-sessions" hidden={bottomTab!=='sessions'}>{bottomTab==='sessions'&&<PaperSessionHistory refreshKey={s?.startedAt}/>}</div>
      </section>
    </div>
    <aside id="paper-execution-sidebar" className="terminal-sidebar" aria-label="Paper trading controls" hidden={!controlsOpen}>
      <section className="terminal-panel trading-account-summary" aria-label="Paper account summary"><header><div className="account-summary-heading"><h2>Account overview</h2></div><span>Virtual funds</span></header><div className="account-equity"><span>Equity</span><strong>{fmt(equity,2)} <small>{paperQuote}</small></strong></div><div className="account-summary-metrics"><Metric label="Balance" value={fmt(balance,2)} unit={paperQuote}/><Metric label="Session P&L" value={`${pnl>=0?'+':''}${fmt(pnl,2)}`} unit={paperQuote} tone={pnl>=0?'positive':'negative'}/></div><div className="account-summary-time"><span>{s?(s.mode==='replay'?'Replay clock':'Session clock'):'Last market candle'}</span><time>{date(s?(s.mode==='replay'?displayClock:s.virtualTime??s.lastProcessed):liveMarket.minutes.at(-1)?.time??preview.at(-1)?.time??null,tradingTimeZone)}</time></div></section>
      <section className="terminal-panel bot-control"><div className="panel-heading"><h2>Paper bot</h2><span className={`bot-state ${s?.running?'is-running':''}`}><i className="status-dot"/>{status}</span></div>
      {settings.strategy==='none'?<div className="bot-form"><h3>No strategy configured</h3><p>The market chart and account history remain available. Automated paper trading is disabled.</p>{s?.running&&<button type="button" disabled={busy} onClick={()=>void action('pause')}>Pause existing session</button>}</div>:<form className="bot-form" onSubmit={e=>{e.preventDefault();void action('start');}}><fieldset disabled={busy||s?.running}>
        <BotSelector strategy={config.strategy} onStrategyChange={key=>onChange({...settings,strategy:key})} profiles={profiles} onApplySetup={onApplySetup} setupLabel="Saved parameters"/>
        <label>Timeframe<select value={config.entry_timeframe} onChange={e=>onChange({...settings,entry_timeframe:e.target.value as BacktestSettings['entry_timeframe']})}>{['1m','3m','5m','10m','15m','30m','1h','4h','1d'].map(tf=><option key={tf} value={tf}>{tf}</option>)}</select></label>
        <div className="control-row"><label>Starting balance<div className="input-with-unit"><input type="number" required min={1} max={1e9} step="any" value={config.capital} onChange={e=>onChange({...settings,capital:Number(e.target.value)})}/><span>{paperQuote}</span></div></label><label>Leverage<div className="input-with-unit"><input type="number" required min={1} max={100} step={.5} value={config.max_leverage} onChange={e=>onChange({...settings,max_leverage:Number(e.target.value)})}/><span>×</span></div></label></div>
        {scalper?<div className="allocation-control"><label>Risk per trade<div className="input-with-unit"><input type="number" required min={.01} max={10} step="any" value={(config.st_scalper??stScalperDefaults).risk_pct} onChange={e=>onChange({...settings,st_scalper:{...stScalperDefaults,...settings.st_scalper,risk_pct:Number(e.target.value)}})}/><span>%</span></div></label><small>Equity lost if the initial ATR stop is hit. Position size is capped by leverage.</small></div>:directional?<div className="allocation-control"><label>Risk per trade<div className="input-with-unit"><input type="number" required min={.01} max={10} step="any" value={config.ml_directional.risk_per_trade_pct} onChange={e=>onChange({...settings,ml_directional:{...settings.ml_directional,risk_per_trade_pct:Number(e.target.value)}})}/><span>%</span></div></label><small>Balance lost if the stop is hit. Position size is capped by leverage.</small></div>:<div className="allocation-control"><label>Amount per trade<div className="input-with-unit"><input type="number" required min={.01} step="any" max={sizing.amount_unit==='percent'?100:config.capital} value={sizing.amount_per_trade} onChange={e=>setSizing({amount_per_trade:Number(e.target.value)})}/><select aria-label="Amount unit" value={sizing.amount_unit} onChange={e=>setSizing({amount_unit:e.target.value as 'price'|'percent'})}><option value="percent">%</option><option value="price">$</option></select></div></label><small>Allocation before leverage. Capped at available balance.</small></div>}
      </fieldset>
      {s?.running?<button className="bot-pause" type="button" disabled={busy} onClick={()=>void action('pause')}>Ⅱ Pause bot</button>:<><button className="bot-start" type="submit" disabled={busy}>{busy?'Starting…':s?'＋ Start new session':'▶ Start virtual bot'}</button>{s&&!s.halted&&!s.completed&&<button type="button" className="secondary resume-button" disabled={busy} onClick={()=>void action('resume')}>Resume saved session</button>}</>}
      </form>}
      {(error||data.error||s?.quoteError)&&<p className="error" role="alert">{error||data.error||s?.quoteError}</p>}
      <div className="strategy-card"><header><strong>{settings.strategy==='none'?'No strategy configured':active.strategy==='adx_supertrend'?'ADX + Supertrend rules':active.strategy==='st_scalper'?'SuperTrend Scalper rules':activeDirectional?'ML Directional':'BB Outer Band Reversal'}</strong><button type="button" className="text-button" onClick={onConfigure}>Edit ↗</button></header>
        {(active.strategy==='adx_supertrend'||active.strategy==='st_scalper')&&settings.strategy!=='none'?<dl className="strategy-rules">{(active.strategy==='st_scalper'?scalperRules(active):adxSupertrendRules(active)).map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        :<small>{settings.strategy==='none'?'Market viewing only':activeDirectional&&ml?`TP ${ml.take_profit_atr} / SL ${ml.stop_atr} × ATR · ${ml.max_hold_bars}-bar hold · ${ml.trade_mode}`:'Trailing SL / Both directions'}</small>}</div>
    </section>
    <BotStatusPanel state={s?.strategyState} running={!!s?.running} timeLabel={s?.strategyState?.timestamp?date(s.strategyState.timestamp+duration,tradingTimeZone):undefined} emptyHint={settings.strategy==='none'?'No automated strategy is configured. The market chart and past sessions remain available.':s?'Readiness appears after the bot processes its first completed candle.':'Start a virtual session to see buy and sell readiness.'}/>
    <details className="terminal-help"><summary>How this simulation works</summary><p>Live quotes refresh approximately every second. Trading decisions use completed execution candles.</p><p>Keep the backend running. Live catches up missed candles. A balance at or below zero halts trading.</p><p>Fees, slippage, funding and liquidation are not modeled. Current equity follows the displayed price; the equity curve uses completed closes.</p>{s&&<p>Last execution check: {date(s.lastCheck,tradingTimeZone)}<br/>Last completed candle: {date(s.lastProcessed,tradingTimeZone)}</p>}</details>
    </aside></div>

  </div>;
}

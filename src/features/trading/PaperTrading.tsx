import {Metric,StatusBadge,TabBar,TableFrame} from '../../shared/ui/ui';
import {useChartTimeframe} from '../../shared/charts/useChartTimeframe';
import {TIMEFRAMES,chartPosition} from '../../shared/charts/chartTimeframe';
import TradeView from '../../shared/ui/TradeView';
import {STOP_COLORS,type StopPoint} from '../../shared/charts/StopOverlay';
import {FILL_COLORS} from '../../shared/charts/fillMarkers';
import {useEffect,useRef,useState} from 'react';
import {api} from '../../shared/api/api';
import {EquityChart} from '../../shared/charts/BacktestChart';
import PaperPriceChart from '../../shared/charts/PaperPriceChart';
import {fmt,type Analysis,type BacktestSettings} from '../../shared/types/types';
import {candleAt,useReplayAnimation,type Candle} from './replayAnimation';
import {accountAt} from './replayAccount';
import {formatTradingTime,useTradingTimeZone,type TradingTimeZone} from '../../shared/charts/tradingTime';
import TradingChartHeader from '../../shared/charts/TradingChartHeader';
import TerminalSplitter from '../../shared/ui/TerminalSplitter';

export type Position={direction:number;entry_time:number;entry_price:number;quantity:number;stop:number;initial_stop?:number;trailing_active:boolean;stop_history?:StopPoint[]};
export type PaperTrade=Position&{id:number;exit_time:number;exit_price:number;exit_reason:string;pnl:number};
type Session={animationMinutes?:Candle[];formingCandle?:Candle|null;displayPrice?:number|null;displayEquity?:number;quoteError?:string|null;quoteTime?:number|null;chartCandles?:Candle[];chartIndicators?:{time:number;bbBasis:number|null;bbUpper:number|null;bbLower:number|null;trendSma:number|null}[];chartStops?:{time:number;price:number|null}[];mode?:'live'|'replay';speed?:number;virtualTime?:number;replayEnd?:number|null;completed?:boolean;running:boolean;startedAt:number;tradingFrom:number;lastProcessed:number|null;lastCheck:number|null;balance:number;equity:number;openPosition:Position|null;trades:PaperTrade[];equityHistory:{time:number;value:number}[];halted:boolean;latestPrice:number|null;signals:number;settings:BacktestSettings};
type Response={session:Session|null;error:string|null};
const date=(t:number|null,timeZone:TradingTimeZone)=>t===null?'Waiting':formatTradingTime(t,timeZone);

export default function PaperTrading({settings,onChange,onConfigure,visible}:{settings:BacktestSettings;onChange:(s:BacktestSettings)=>void;onConfigure:()=>void;visible:boolean}) {
  const tradingTimeZone=useTradingTimeZone();
  const [chartTimeframe,setChartTimeframe]=useState<BacktestSettings['entry_timeframe']>(settings.entry_timeframe);
  const [data,setData]=useState<Response>({session:null,error:null});
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const revision=useRef(0);
  const [bottomTab,setBottomTab]=useState<'position'|'history'|'equity'>('position');
  const [preview,setPreview]=useState<Analysis['candles']>([]),[previewError,setPreviewError]=useState('');
  useEffect(()=>{
    if(!visible||data.session)return;
    const abort=new AbortController();
    void api<Analysis>('/api/analyze',{method:'POST',headers:{'Content-Type':'application/json'},signal:abort.signal,body:JSON.stringify({timeframe:'1m'})}).then(value=>{setPreview(value.candles);setPreviewError('');}).catch(e=>{if(!abort.signal.aborted)setPreviewError(String(e));});
    return ()=>abort.abort();
  },[visible,!!data.session]);
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
    revision.current++;setBusy(true);setError('');
    try{setData(await api<Response>(`/api/paper/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},...(action==='start'?{body:JSON.stringify({...settings,paper_mode:'live'})}:{})}));}
    catch(e){setError(String(e));}finally{revision.current++;setBusy(false);}
  }
  const s=data.session;
  const durations=TIMEFRAMES;
  const duration=durations[s?.settings.entry_timeframe??settings.entry_timeframe];
  const displayClock=useReplayAnimation(visible&&s?.mode==='replay',s?.startedAt??0,s?.virtualTime??0);
  const animated=s?.mode==='replay'&&s.animationMinutes?.length?candleAt(s.animationMinutes,displayClock,duration):s?.formingCandle;
  const chartCandles=s?[...(s.chartCandles??[]).filter(c=>(s.mode!=='replay'||c.time+duration<=displayClock)&&(!animated||c.time<animated.time)),...(animated?[animated]:[])]:[];
  const chartIndicators=(s?.chartIndicators??[]).filter(row=>s?.mode!=='replay'||row.time+duration<=displayClock);
  const chartStops=(s?.chartStops??[]).filter(row=>s?.mode!=='replay'||row.time+duration<=displayClock);
  useEffect(()=>{if(s)setChartTimeframe(s.settings.entry_timeframe);},[s?.startedAt]);
  const config=s?.running?s.settings:settings;
  const price=s?(s.mode==='replay'?(animated?.close??chartCandles.at(-1)?.close??null):(s.displayPrice??s.latestPrice)):preview.at(-1)?.close??null;

  const replay=s?.mode==='replay'?accountAt(s.trades,s.openPosition,s.settings.capital,displayClock,duration,price,chartStops):null;
  const p=replay?.open??(replay?null:s?.openPosition??null);
  const chartTrades=replay?.closed??s?.trades??[];
  const balance=replay?.balance??s?.balance??settings.capital;
  const equity=replay?.equity??(s?(s.displayEquity??s.equity):settings.capital);
  const pnl=s?equity-s.settings.capital:0;
  const leverage=(s?.settings??settings).max_leverage,unrealized=equity-balance,margin=p?p.entry_price*p.quantity/Math.max(1,leverage):0;
  const status=s?.halted?'Balance depleted':s?.completed?'Replay complete':s?.running?'Running':s?'Paused':'Ready to start';
  const chartDuration=TIMEFRAMES[chartTimeframe];
  const alternate=!!s&&chartTimeframe!==s.settings.entry_timeframe;
  const chartView=useChartTimeframe(s?chartTimeframe:settings.entry_timeframe,s?.startedAt??0,s?(s.mode==='replay'?displayClock:s.quoteTime??s.virtualTime??0):Date.now()/1000,visible,s?.animationMinutes??preview,(s?.settings??settings).bb_reversal,s?.mode==='replay');
  const view=chartView.view;
  const viewForming=view.forming;
  const visibleCandles=alternate||!s?(view?[...view.candles.filter(c=>(s?.mode!=='replay'||c.time+chartDuration<=displayClock)&&(!viewForming||c.time<viewForming.time)),...(viewForming?[viewForming]:[])]:[]):s?chartCandles:preview;
  const visibleIndicators=alternate||!s?(view?.indicators??[]).filter(c=>s?.mode!=='replay'||c.time+chartDuration<=displayClock):chartIndicators;
  const visibleTrades=alternate?chartTrades.map(t=>chartPosition(t,duration,chartDuration)):chartTrades;
  const visiblePosition=alternate&&p?chartPosition(p,duration,chartDuration):p;
  const hasChart=visibleCandles.length>0;
  function changeChartTimeframe(value:BacktestSettings['entry_timeframe']){setChartTimeframe(value);if(!s){onChange({...settings,entry_timeframe:value});}}
  return <div id="page-paper" role="tabpanel" aria-labelledby="tab-paper" hidden={!visible}>
    <div className="market-bar"><div className="instrument"><span className="instrument-icon">Ag</span><div><h1>XAG / USDT <span>PERP</span></h1><small>Local chart data / paper execution</small></div></div>
      <div className="market-price"><strong>{fmt(price,3)}</strong><small>USDT {s?'· current price':'· historical preview'}</small></div>
      <Metric label="Account equity" value={`$${fmt(equity)}`}/><Metric label="Total P&L" value={`${pnl>=0?'+':''}${fmt(pnl)}`} unit="USDT" tone={pnl>=0?'positive':'negative'}/>
      <div className="market-stat clock-stat"><small>{s?.mode==='replay'?'Replay clock':'Last candle'}</small><b>{date(s?(s.mode==='replay'?displayClock:s.virtualTime??s.lastProcessed):preview.at(-1)?.time??null,tradingTimeZone)}</b></div>
    </div>
    <div className="terminal-grid"><div className="terminal-main">
      <section className="terminal-panel price-panel"><TradingChartHeader timeframe={s?chartTimeframe:settings.entry_timeframe} onTimeframeChange={value=>changeChartTimeframe(value as BacktestSettings['entry_timeframe'])} mode={s?s.mode==='replay'?'HISTORICAL REPLAY':'PAPER SESSION':'MARKET PREVIEW'} caption={s?`Bot executes on ${s.settings.entry_timeframe} candles`:'Choose a timeframe to view the market chart'}/>
        {hasChart?<PaperPriceChart atrLength={(s?.settings??settings).bb_reversal.atr_length} adxLength={(s?.settings??settings).bb_reversal.adx_length} indicatorClock={s?(s.mode==='replay'?displayClock:s.quoteTime??s.virtualTime??0):Date.now()/1000} timeframe={s?chartTimeframe:settings.entry_timeframe} sessionId={s?.startedAt??0} candles={visibleCandles} indicators={visibleIndicators} stops={alternate?[]:chartStops} trades={visibleTrades} position={visiblePosition??null} showSma={(s?.settings??settings).bb_reversal.use_sma_trend_adjustment!==false}/>:<div className="chart-empty"><span className="empty-chart-icon">⌁</span><h3>{chartView.error||previewError?'Chart unavailable':'Preparing your chart'}</h3><p>{previewError||'Loading downloaded market candles…'}</p></div>}
        {alternate&&chartView.error&&hasChart&&<p className="chart-history-status error" role="alert">{chartView.error}</p>}
        <div className="chart-legend"><span><b style={{color:FILL_COLORS.buy}}>↑</b> Buy / close short</span><span><b style={{color:FILL_COLORS.sell}}>↓</b> Sell / close long</span><span><i className="legend-line" style={{borderColor:STOP_COLORS.initial}}/> Stop loss</span><span><i className="legend-line" style={{borderColor:STOP_COLORS.trailing}}/> Trailing stop / TRAIL activation</span></div>
      </section>
      <TerminalSplitter/>
      <section className="terminal-panel activity-panel exchange-activity">
        <TabBar items={[
          {value:'position',label:'Open position',count:p?1:0,controls:'activity-position'},
          {value:'history',label:'Trade history',count:chartTrades.length,controls:'activity-history'},
          {value:'equity',label:'Equity',controls:'activity-equity'},
        ] as const} value={bottomTab} onChange={setBottomTab} label="Paper account activity" idPrefix="activity-tab" trailing={<StatusBadge>Paper account</StatusBadge>}/>
        <div id="activity-position" role="tabpanel" aria-labelledby="activity-tab-position" hidden={bottomTab!=='position'}>{p?<TableFrame label="Open XAG paper position" columns={['Contract','Mark price','Entry price','Margin (USDT)','Unrealized PnL','PnL (%)','Stop price','Size (XAG)','Opened']}><tr>
          <td><strong>XAGUSDT <small>Perpetual</small></strong><div className="exchange-position-tags"><StatusBadge tone={p.direction===1?'positive':'negative'}>{p.direction===1?'LONG':'SHORT'}</StatusBadge><StatusBadge>{fmt(leverage,1)}x</StatusBadge><StatusBadge>{p.trailing_active?'Trailing':'Initial stop'}</StatusBadge></div></td>
          <td>{fmt(price,3)}</td><td>{fmt(p.entry_price,3)}</td><td>{fmt(margin,4)}</td>
          <td className={unrealized<0?'negative':'positive'}>{unrealized>=0?'+':''}{fmt(unrealized,4)} <small>USDT</small></td>
          <td className={unrealized<0?'negative':'positive'}>{margin?fmt(unrealized/margin*100,2):'—'}%</td>
          <td>{fmt(p.stop,3)}</td><td>{fmt(p.quantity,4)}</td><td>{date(p.entry_time+duration,tradingTimeZone)}</td>
        </tr></TableFrame>:<div className="empty-position"><span className="empty-state-symbol">◇</span><h3>{s?.running?'Watching for your next setup':'No open position'}</h3><p>{s?.running?'The bot is scanning for a qualified Bollinger band rebound.':'Start a virtual session to see entries, stops and position P&L here.'}</p></div>}</div>
        <div id="activity-history" role="tabpanel" aria-labelledby="activity-tab-history" hidden={bottomTab!=='history'}><TradeView key={s?.startedAt??0} scope="Session" capital={s?.settings.capital??settings.capital} timeZone={tradingTimeZone} unrealized={equity-balance} trades={chartTrades.map(t=>({id:t.id,direction:t.direction,pnl:t.pnl,entry:t.entry_price,exit:t.exit_price,quantity:t.quantity,exitTime:t.exit_time+duration}))}>{chartTrades.length?<div className="table-scroll"><table><thead><tr>{['ID','Side',`Entry time (${tradingTimeZone})`,'Entry','Exit','Quantity','P&L','Exit reason'].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{chartTrades.slice(-100).reverse().map(t=><tr key={t.id}><td>#{t.id}</td><td><span className={`side-badge ${t.direction===1?'long':'short'}`}>{t.direction===1?'LONG':'SHORT'}</span></td><td>{date(t.entry_time+duration,tradingTimeZone)}</td><td>{fmt(t.entry_price,3)}</td><td>{fmt(t.exit_price,3)}</td><td>{fmt(t.quantity,4)}</td><td className={t.pnl>=0?'positive':'negative'}>{t.pnl>=0?'+':''}{fmt(t.pnl)}</td><td>{t.exit_reason==='rsi_price_exit'?'RSI + price exit':t.exit_reason.replaceAll('_',' ')}</td></tr>)}</tbody></table></div>:<div className="empty-position"><h3>Your trade history starts here</h3><p>Closed virtual trades appear automatically as the bot runs.</p></div>}</TradeView></div>
        <div id="activity-equity" role="tabpanel" aria-labelledby="activity-tab-equity" hidden={bottomTab!=='equity'}>{chartTrades.length?<EquityChart key={s?.startedAt??0} period={{name:'Paper trading'}} initialValue={s?.settings.capital??settings.capital} trades={chartTrades.map(t=>({pnl:t.pnl}))}/>:<div className="empty-position"><h3>No closed trades yet</h3><p>The balance curve adds one point after each trade closes.</p></div>}</div>
      </section>
    </div>
    <aside className="terminal-sidebar"><section className="terminal-panel bot-control"><div className="panel-heading"><h2>Paper bot</h2><span className={`bot-state ${s?.running?'is-running':''}`}><i className="status-dot"/>{status}</span></div>
      <form className="bot-form" onSubmit={e=>{e.preventDefault();void action('start');}}><fieldset disabled={busy||s?.running}>
        <label>Timeframe<select value={config.entry_timeframe} onChange={e=>onChange({...settings,entry_timeframe:e.target.value as BacktestSettings['entry_timeframe']})}>{['1m','3m','5m','10m','15m','30m','1h','4h','1d'].map(tf=><option key={tf} value={tf}>{tf}</option>)}</select></label>
        <div className="control-row"><label>Starting balance ($)<input type="number" required min={1} max={1e9} step="any" value={config.capital} onChange={e=>onChange({...settings,capital:Number(e.target.value)})}/></label><label>Leverage<input type="number" required min={1} max={100} step={.5} value={config.max_leverage} onChange={e=>onChange({...settings,max_leverage:Number(e.target.value)})}/></label></div>
        <div className="allocation-control"><label>Amount per trade<div className="input-with-unit"><input type="number" required min={.01} step="any" max={config.bb_reversal.amount_unit==='percent'?100:config.capital} value={config.bb_reversal.amount_per_trade} onChange={e=>onChange({...settings,bb_reversal:{...settings.bb_reversal,amount_per_trade:Number(e.target.value)}})}/><select aria-label="Amount unit" value={config.bb_reversal.amount_unit} onChange={e=>onChange({...settings,bb_reversal:{...settings.bb_reversal,amount_unit:e.target.value as 'price'|'percent'}})}><option value="percent">%</option><option value="price">$</option></select></div></label><small>Allocation before leverage. Capped at available balance.</small></div>
      </fieldset>
      {s?.running?<button className="bot-pause" type="button" disabled={busy} onClick={()=>void action('pause')}>Ⅱ Pause bot</button>:<><button className="bot-start" type="submit" disabled={busy}>{busy?'Starting…':s?'＋ Start new session':'▶ Start virtual bot'}</button>{s&&!s.halted&&!s.completed&&<button type="button" className="secondary resume-button" disabled={busy} onClick={()=>void action('resume')}>Resume saved session</button>}</>}
      </form>
      {(error||data.error||s?.quoteError)&&<p className="error" role="alert">{error||data.error||s?.quoteError}</p>}
      <div className="strategy-card"><div><span className="strategy-icon">⌁</span><div><strong>BB Outer Band Reversal</strong><small>Trailing SL · Both directions</small></div></div><button type="button" className="text-button" onClick={onConfigure}>Strategy settings ↗</button></div>
    </section>
    <details className="terminal-help"><summary>How this simulation works</summary><p>Live quotes refresh approximately every second. Trading decisions use completed execution candles.</p><p>Keep the backend running. Live catches up missed candles. A balance at or below zero halts trading.</p><p>Fees, slippage, funding and liquidation are not modeled. Current equity follows the displayed price; the equity curve uses completed closes.</p>{s&&<p>Last execution check: {date(s.lastCheck,tradingTimeZone)}<br/>Last completed candle: {date(s.lastProcessed,tradingTimeZone)}</p>}</details>
    </aside></div>

  </div>;
}

import TradeView from './TradeView';
import {STOP_COLORS,type StopPoint} from './StopOverlay';
import {FILL_COLORS} from './fillMarkers';
import {useEffect,useRef,useState} from 'react';
import {api} from './api';
import {EquityChart} from './BacktestChart';
import PaperPriceChart from './PaperPriceChart';
import {fmt,type Analysis,type BacktestSettings} from './types';
import {candleAt,useReplayAnimation,type Candle} from './replayAnimation';
import {accountAt} from './replayAccount';

export type Position={direction:number;entry_time:number;entry_price:number;quantity:number;stop:number;initial_stop?:number;trailing_active:boolean;stop_history?:StopPoint[]};
export type PaperTrade=Position&{id:number;exit_time:number;exit_price:number;exit_reason:string;pnl:number};
type Session={animationMinutes?:Candle[];formingCandle?:{time:number;open:number;high:number;low:number;close:number}|null;displayPrice?:number|null;displayEquity?:number;quoteError?:string|null;quoteTime?:number|null;chartCandles?:{time:number;open:number;high:number;low:number;close:number}[];chartIndicators?:{time:number;bbBasis:number|null;bbUpper:number|null;bbLower:number|null;trendSma:number|null}[];chartStops?:{time:number;price:number|null}[];mode?:'live'|'replay';speed?:number;virtualTime?:number;replayEnd?:number|null;completed?:boolean;running:boolean;startedAt:number;tradingFrom:number;lastProcessed:number|null;lastCheck:number|null;balance:number;equity:number;openPosition:Position|null;trades:PaperTrade[];equityHistory:{time:number;value:number}[];halted:boolean;latestPrice:number|null;signals:number;settings:BacktestSettings};
type Response={session:Session|null;error:string|null};
const date=(t:number|null)=>t===null?'Waiting':new Date(t*1000).toLocaleString();

export default function PaperTrading({settings,onChange,onConfigure,visible}:{settings:BacktestSettings;onChange:(s:BacktestSettings)=>void;onConfigure:()=>void;visible:boolean}) {
  const [data,setData]=useState<Response>({session:null,error:null});
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [mode,setMode]=useState<'live'|'replay'>('live'),[speed,setSpeed]=useState(300);
  const [startDate,setStartDate]=useState(settings.start_date),[endDate,setEndDate]=useState(settings.end_date);
  const revision=useRef(0);
  const speeds=[1,10,60,300,1800,3600,10000];
  const [bottomTab,setBottomTab]=useState<'position'|'history'|'equity'>('position');
  const [preview,setPreview]=useState<Analysis['candles']>([]),[previewError,setPreviewError]=useState('');
  useEffect(()=>{
    if(!visible||data.session)return;
    const abort=new AbortController();
    void api<Analysis>('/api/analyze',{method:'POST',headers:{'Content-Type':'application/json'},signal:abort.signal,body:JSON.stringify({timeframe:settings.entry_timeframe})}).then(value=>{setPreview(value.candles.slice(-240));setPreviewError('');}).catch(e=>{if(!abort.signal.aborted)setPreviewError(String(e));});
    return ()=>abort.abort();
  },[visible,settings.entry_timeframe,!!data.session]);
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
    try{setData(await api<Response>(`/api/paper/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},...(action==='start'?{body:JSON.stringify({...settings,paper_mode:mode,replay_start:startDate,replay_end:endDate,replay_speed:speed})}:{})}));}
    catch(e){setError(String(e));}finally{revision.current++;setBusy(false);}
  }
  async function changeSpeed(value:number) {
    revision.current++;setBusy(true);setError('');
    try{setData(await api<Response>('/api/paper/speed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({speed:value})}));}
    catch(e){setSpeed(data.session?.speed??300);setError(String(e));}finally{revision.current++;setBusy(false);}
  }
  const s=data.session;
  const durations:Record<string,number>={'1m':60,'3m':180,'5m':300,'10m':600,'15m':900,'30m':1800,'1h':3600,'4h':14400,'1d':86400};
  const duration=durations[s?.settings.entry_timeframe??settings.entry_timeframe];
  const displayClock=useReplayAnimation(visible&&s?.mode==='replay',s?.startedAt??0,s?.virtualTime??0);
  const animated=s?.mode==='replay'&&s.animationMinutes?.length?candleAt(s.animationMinutes,displayClock,duration):s?.formingCandle;
  const chartCandles=s?[...(s.chartCandles??[]).filter(c=>(s.mode!=='replay'||c.time+duration<=displayClock)&&(!animated||c.time<animated.time)),...(animated?[animated]:[])]:[];
  const chartIndicators=(s?.chartIndicators??[]).filter(row=>s?.mode!=='replay'||row.time+duration<=displayClock);
  const chartStops=(s?.chartStops??[]).filter(row=>s?.mode!=='replay'||row.time+duration<=displayClock);
  useEffect(()=>{if(s){setMode(s.mode??'live');setSpeed(s.speed??300);const saved=s.settings as BacktestSettings&{replay_start?:string;replay_end?:string};if(saved.replay_start)setStartDate(saved.replay_start);if(saved.replay_end)setEndDate(saved.replay_end);}},[s?.startedAt]);
  const config=s?.running?s.settings:settings;
  const price=s?(s.mode==='replay'?(animated?.close??chartCandles.at(-1)?.close??null):(s.displayPrice??s.latestPrice)):preview.at(-1)?.close??null;
  const equityHistory=(s?.equityHistory??[]).filter(row=>s?.mode!=='replay'||row.time+duration<=displayClock);
  const replay=s?.mode==='replay'?accountAt(s.trades,s.openPosition,s.settings.capital,displayClock,duration,price,chartStops):null;
  const p=replay?.open??(replay?null:s?.openPosition??null);
  const chartTrades=replay?.closed??s?.trades??[];
  const balance=replay?.balance??s?.balance??settings.capital;
  const equity=replay?.equity??(s?(s.displayEquity??s.equity):settings.capital);
  const pnl=s?equity-s.settings.capital:0;
  const status=s?.halted?'Balance depleted':s?.completed?'Replay complete':s?.running?'Running':s?'Paused':'Ready to start';
  const hasChart=s?chartCandles.length>0:preview.length>0;
  const replayProgress=s?.mode==='replay'&&s.replayEnd?Math.min(100,Math.max(0,(displayClock-s.tradingFrom)/(s.replayEnd-s.tradingFrom)*100)):0;
  return <div id="page-paper" role="tabpanel" aria-labelledby="tab-paper" hidden={!visible}>
    <div className="market-bar"><div className="instrument"><span className="instrument-icon">Ag</span><div><h1>XAG / USDT <span>PERP</span></h1><small>Silver perpetual · OKX</small></div></div>
      <div className="market-price"><strong>{fmt(price,3)}</strong><small>USDT {s?'· current price':'· historical preview'}</small></div>
      <div className="market-stat"><small>Account equity</small><b>${fmt(equity)}</b></div><div className="market-stat"><small>Total P&amp;L</small><b className={pnl>=0?'positive':'negative'}>{pnl>=0?'+':''}{fmt(pnl)} <span>USDT</span></b></div>
      <div className="market-stat clock-stat"><small>{s?.mode==='replay'?'Replay clock':'Last candle'}</small><b>{date(s?(s.mode==='replay'?displayClock:s.virtualTime??s.lastProcessed):preview.at(-1)?.time??null)}</b></div>
    </div>
    <div className="terminal-grid"><div className="terminal-main">
      <section className="terminal-panel price-panel"><div className="panel-heading"><div className="chart-title"><strong>XAGUSDT</strong><span className="timeframe-tag">{(s?.settings.entry_timeframe??settings.entry_timeframe).toUpperCase()}</span><span className="chart-mode">{s?s.mode==='replay'?'HISTORICAL REPLAY':'LIVE PAPER':'MARKET PREVIEW'}</span></div><span className="chart-caption">{s?'BB reversal + trailing stop':'Start a bot to display its trades'}</span></div>
        {hasChart&&visible?<PaperPriceChart timeframe={s?.settings.entry_timeframe??settings.entry_timeframe} sessionId={s?.startedAt??0} candles={s?chartCandles:preview} indicators={chartIndicators} stops={chartStops} trades={chartTrades} position={p??null} showSma={(s?.settings??settings).bb_reversal.use_sma_trend_adjustment!==false}/>:<div className="chart-empty"><span className="empty-chart-icon">⌁</span><h3>{previewError?'Market preview unavailable':'Preparing your chart'}</h3><p>{previewError||'Loading downloaded market candles…'}</p></div>}
        <div className="chart-legend"><span><b style={{color:FILL_COLORS.buy}}>↑</b> Buy / close short</span><span><b style={{color:FILL_COLORS.sell}}>↓</b> Sell / close long</span><span><i className="legend-line" style={{borderColor:STOP_COLORS.initial}}/> Stop loss</span><span><i className="legend-line" style={{borderColor:STOP_COLORS.trailing}}/> Trailing stop / TRAIL activation</span><span className="legend-note">Markers show exact fill prices · {s?.mode==='replay'?'1s animation · simulated intraminute path':'1-minute source · selected timeframe aggregation'}</span></div>
      </section>
      <section className="terminal-panel activity-panel"><div className="activity-tabs" role="tablist" aria-label="Bot activity">{([['position','Open position',p?1:0],['history','Trade history',chartTrades.length],['equity','Equity',null]] as const).map(([key,label,count])=><button key={key} role="tab" id={`activity-tab-${key}`} aria-controls={`activity-${key}`} aria-selected={bottomTab===key} tabIndex={bottomTab===key?0:-1} onKeyDown={e=>{const keys=['position','history','equity'] as const;let index=keys.indexOf(key);if(e.key==='ArrowRight')index=(index+1)%3;else if(e.key==='ArrowLeft')index=(index+2)%3;else if(e.key==='Home')index=0;else if(e.key==='End')index=2;else return;e.preventDefault();setBottomTab(keys[index]);document.getElementById(`activity-tab-${keys[index]}`)?.focus();}} onClick={()=>setBottomTab(key)}>{label}{count!==null&&<span>{count}</span>}</button>)}<span className="activity-caption">VIRTUAL ACCOUNT</span></div>
        <div id="activity-position" role="tabpanel" aria-labelledby="activity-tab-position" hidden={bottomTab!=='position'}>{p?<div className="position-content"><div className="position-heading"><span className={`side-badge ${p.direction===1?'long':'short'}`}>{p.direction===1?'LONG':'SHORT'}</span><strong>XAG / USDT</strong><span className="status-label">{p.trailing_active?'Trailing active':'Initial stop active'}</span></div><div className="position-values">{[['Entry price',fmt(p.entry_price,3)],['Current price',fmt(price,3)],['Quantity',fmt(p.quantity,4)],['Stop price',fmt(p.stop,3)],['Unrealized P&L',fmt(equity-(balance))]].map(([label,value])=><div key={label}><small>{label}</small><b>{value}</b></div>)}</div><p className="muted">Opened {date(p.entry_time+duration)} · protective orders are simulated.</p></div>:<div className="empty-position"><span className="empty-state-symbol">◇</span><h3>{s?.running?'Watching for your next setup':'No open position'}</h3><p>{s?.running?'The bot is scanning for a qualified Bollinger band rebound.':'Start a virtual session to see entries, stops and position P&L here.'}</p></div>}</div>
        <div id="activity-history" role="tabpanel" aria-labelledby="activity-tab-history" hidden={bottomTab!=='history'}><TradeView key={s?.startedAt??0} scope="Session" capital={s?.settings.capital??settings.capital} unrealized={equity-balance} trades={chartTrades.map(t=>({id:t.id,direction:t.direction,pnl:t.pnl,entry:t.entry_price,exit:t.exit_price,quantity:t.quantity,exitTime:t.exit_time+duration}))}>{chartTrades.length?<div className="table-scroll"><table><thead><tr>{['ID','Side','Entry time','Entry','Exit','Quantity','P&L','Exit reason'].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{chartTrades.slice(-100).reverse().map(t=><tr key={t.id}><td>#{t.id}</td><td><span className={`side-badge ${t.direction===1?'long':'short'}`}>{t.direction===1?'LONG':'SHORT'}</span></td><td>{date(t.entry_time+duration)}</td><td>{fmt(t.entry_price,3)}</td><td>{fmt(t.exit_price,3)}</td><td>{fmt(t.quantity,4)}</td><td className={t.pnl>=0?'positive':'negative'}>{t.pnl>=0?'+':''}{fmt(t.pnl)}</td><td>{t.exit_reason.replaceAll('_',' ')}</td></tr>)}</tbody></table></div>:<div className="empty-position"><h3>Your trade history starts here</h3><p>Closed virtual trades appear automatically as the bot runs.</p></div>}</TradeView></div>
        <div id="activity-equity" role="tabpanel" aria-labelledby="activity-tab-equity" hidden={bottomTab!=='equity'}>{equityHistory.length?<EquityChart period={{name:'Paper trading',equity:equityHistory}}/>:<div className="empty-position"><h3>No equity history yet</h3><p>The equity curve builds as execution candles close.</p></div>}</div>
      </section>
    </div>
    <aside className="terminal-sidebar"><section className="terminal-panel bot-control"><div className="panel-heading"><h2>Bot control</h2><span className={`bot-state ${s?.running?'is-running':''}`}><i className="status-dot"/>{status}</span></div>
      <form className="bot-form" onSubmit={e=>{e.preventDefault();void action('start');}}><fieldset disabled={busy||s?.running}>
        <div className="mode-switch" role="group" aria-label="Virtual bot mode"><button type="button" className={mode==='live'?'selected':''} onClick={()=>setMode('live')}>Live paper</button><button type="button" className={mode==='replay'?'selected':''} onClick={()=>setMode('replay')}>Backtest replay</button></div>
        <label>Timeframe<select value={config.entry_timeframe} onChange={e=>onChange({...settings,entry_timeframe:e.target.value as BacktestSettings['entry_timeframe']})}>{['1m','3m','5m','10m','15m','30m','1h','4h','1d'].map(tf=><option key={tf} value={tf}>{tf}</option>)}</select></label>
        <div className="control-row"><label>Starting balance ($)<input type="number" required min={1} max={1e9} step="any" value={config.capital} onChange={e=>onChange({...settings,capital:Number(e.target.value)})}/></label><label>Leverage<input type="number" required min={1} max={100} step={.5} value={config.max_leverage} onChange={e=>onChange({...settings,max_leverage:Number(e.target.value)})}/></label></div>
        <div className="allocation-control"><label>Amount per trade<div className="input-with-unit"><input type="number" required min={.01} step="any" max={config.bb_reversal.amount_unit==='percent'?100:config.capital} value={config.bb_reversal.amount_per_trade} onChange={e=>onChange({...settings,bb_reversal:{...settings.bb_reversal,amount_per_trade:Number(e.target.value)}})}/><select aria-label="Amount unit" value={config.bb_reversal.amount_unit} onChange={e=>onChange({...settings,bb_reversal:{...settings.bb_reversal,amount_unit:e.target.value as 'price'|'percent'}})}><option value="percent">%</option><option value="price">$</option></select></div></label><small>Allocation before leverage. Capped at available balance.</small></div>
        {mode==='replay'&&<><div className="control-row"><label>Start date · UTC<input type="date" required value={startDate} onChange={e=>setStartDate(e.target.value)}/></label><label>End date · UTC<input type="date" required min={startDate} value={endDate} onChange={e=>setEndDate(e.target.value)}/></label></div></>}
      </fieldset>
      {mode==='replay'&&<label>Replay speed<select aria-label="Replay speed" disabled={busy} value={speed} onChange={e=>{const value=Number(e.target.value);setSpeed(value);if(s?.mode==='replay'&&!s.completed&&!s.halted)void changeSpeed(value);}}>{speeds.map(v=><option key={v} value={v}>{v}x</option>)}</select><small className="speed-help">{speed===1?'Real-time playback':`${speed} market seconds per real second`}</small></label>}
      {s?.running?<button className="bot-pause" type="button" disabled={busy} onClick={()=>void action('pause')}>Ⅱ Pause bot</button>:<><button className="bot-start" type="submit" disabled={busy}>{busy?'Starting…':s?'＋ Start new session':'▶ Start virtual bot'}</button>{s&&!s.halted&&!s.completed&&<button type="button" className="secondary resume-button" disabled={busy} onClick={()=>void action('resume')}>Resume saved session</button>}</>}
      </form>
      {(error||data.error||s?.quoteError)&&<p className="error" role="alert">{error||data.error||s?.quoteError}</p>}
      <div className="strategy-card"><div><span className="strategy-icon">⌁</span><div><strong>BB Outer Band Reversal</strong><small>Trailing SL · Both directions</small></div></div><button type="button" className="text-button" onClick={onConfigure}>Strategy settings ↗</button></div>
      <p className="control-footnote">{s?.running?'Session settings are locked while running. Pause to configure a new session.':s?'Resume keeps the saved session settings. Start new applies the configuration above.':'Start flat with virtual funds. No exchange orders are submitted.'}</p>
    </section>
    <section className="terminal-panel account-panel"><div className="panel-heading"><h2>Account overview</h2><span className="paper-badge">VIRTUAL</span></div><div className="account-equity"><small>Total equity</small><strong>${fmt(equity)}</strong><span className={pnl>=0?'positive':'negative'}>{pnl>=0?'+':''}{fmt(pnl)} USDT total P&amp;L</span></div><dl><div><dt>Wallet balance</dt><dd>${fmt(balance)}</dd></div><div><dt>Unrealized P&amp;L</dt><dd className={equity-(balance)>=0?'positive':'negative'}>{fmt(equity-(balance))}</dd></div><div><dt>Realized P&amp;L</dt><dd>{fmt(s?balance-s.settings.capital:0)}</dd></div><div><dt>Closed trades</dt><dd>{chartTrades.length}</dd></div></dl>
      {s?.mode==='replay'&&<div className="replay-progress"><div><small>Replay progress</small><span>{fmt(replayProgress,1)}%</span></div><progress max={100} value={replayProgress}/><small>Ends {date(s.replayEnd??null)}</small></div>}
    </section>
    <details className="terminal-help"><summary>How this simulation works</summary><p>Live quotes refresh approximately every second. Trading decisions use completed execution candles. Replay animates a synthetic intraminute path; this is not recorded tick data.</p><p>Keep the backend running. Live catches up missed candles. Replay freezes during pause and downtime. A balance at or below zero halts trading.</p><p>Fees, slippage, funding and liquidation are not modeled. Current equity follows the displayed price; the equity curve uses completed closes.</p>{s&&<p>Last execution check: {date(s.lastCheck)}<br/>Last completed candle: {date(s.lastProcessed)}</p>}</details>
    </aside></div>
  </div>;
}

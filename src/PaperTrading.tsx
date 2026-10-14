import {useEffect,useState} from 'react';
import {api} from './api';
import {EquityChart} from './BacktestChart';
import PaperPriceChart from './PaperPriceChart';
import {fmt,type BacktestSettings} from './types';

export type Position={direction:number;entry_time:number;entry_price:number;quantity:number;stop:number;trailing_active:boolean};
export type PaperTrade=Position&{id:number;exit_time:number;exit_price:number;exit_reason:string;pnl:number};
type Session={formingCandle?:{time:number;open:number;high:number;low:number;close:number}|null;displayPrice?:number|null;displayEquity?:number;quoteError?:string|null;quoteTime?:number|null;chartCandles?:{time:number;open:number;high:number;low:number;close:number}[];chartIndicators?:{time:number;bbBasis:number|null;bbUpper:number|null;bbLower:number|null;trendSma:number|null}[];chartStops?:{time:number;price:number|null}[];mode?:'live'|'replay';speed?:number;virtualTime?:number;replayEnd?:number|null;completed?:boolean;running:boolean;startedAt:number;tradingFrom:number;lastProcessed:number|null;lastCheck:number|null;balance:number;equity:number;openPosition:Position|null;trades:PaperTrade[];equityHistory:{time:number;value:number}[];halted:boolean;latestPrice:number|null;signals:number;settings:BacktestSettings};
type Response={session:Session|null;error:string|null};
const date=(t:number|null)=>t===null?'Waiting':new Date(t*1000).toLocaleString();

export default function PaperTrading({settings,visible}:{settings:BacktestSettings;visible:boolean}) {
  const [data,setData]=useState<Response>({session:null,error:null});
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [mode,setMode]=useState<'live'|'replay'>('live'),[speed,setSpeed]=useState(300);
  const [startDate,setStartDate]=useState(settings.start_date),[endDate,setEndDate]=useState(settings.end_date);
  const speeds=[1,10,60,300,1800,3600,10000];
  useEffect(()=>{
    let active=true,pending=false;
    async function poll(){
      if(pending)return;pending=true;
      try{const value=await api<Response>('/api/paper');if(active){setData(value);setError('');}}
      catch(e){if(active)setError(String(e));}finally{pending=false;}
    }
    void poll();const timer=setInterval(poll,visible?1000:5000);
    return ()=>{active=false;clearInterval(timer);};
  },[visible]);
  async function action(action:'start'|'pause'|'resume') {
    setBusy(true);setError('');
    try{setData(await api<Response>(`/api/paper/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},...(action==='start'?{body:JSON.stringify({...settings,paper_mode:mode,replay_start:startDate,replay_end:endDate,replay_speed:speed})}:{})}));}
    catch(e){setError(String(e));}finally{setBusy(false);}
  }
  async function changeSpeed(value:number) {
    setBusy(true);setError('');
    try{setData(await api<Response>('/api/paper/speed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({speed:value})}));}
    catch(e){setError(String(e));}finally{setBusy(false);}
  }
  const s=data.session,p=s?.openPosition;
  const chartCandles=s?[...(s.chartCandles??[]).filter(c=>!s.formingCandle||c.time<s.formingCandle.time),...(s.formingCandle?[s.formingCandle]:[])]:[];
  return <div id="page-paper" role="tabpanel" aria-labelledby="tab-paper" hidden={!visible}>
    <div className="section-heading"><h2>Virtual bot · Live & backtest replay</h2><span className="badge">Virtual money only</span></div>
    <p>Live follows fresh market candles with a price check every 30 seconds. Backtest replay moves a virtual clock through downloaded historical candles at your selected speed. For example, 300× advances five market minutes per real second. Both use your BB Strategy settings and process only candles that have closed by the current clock.</p>
    <p>Keep the backend running. Live sessions catch up missed candles after pause or restart. Replay pauses its clock while stopped and finishes at the chosen end date or the end of downloaded history. Settings are frozen per session; replay speed can change while running.</p>
    <div className="settings-grid"><label>Mode<select aria-label="Virtual bot mode" disabled={busy||s?.running} value={mode} onChange={e=>setMode(e.target.value as 'live'|'replay')}><option value="live">Live</option><option value="replay">Backtest replay</option></select></label>
      {mode==='replay'&&<><label>Replay start date (UTC)<input type="date" disabled={busy||s?.running} value={startDate} onChange={e=>setStartDate(e.target.value)}/></label><label>Replay end date (UTC, inclusive)<input type="date" disabled={busy||s?.running} min={startDate} value={endDate} onChange={e=>setEndDate(e.target.value)}/></label><label>Starting replay speed<select disabled={busy||s?.running} value={speed} onChange={e=>setSpeed(Number(e.target.value))}>{speeds.map(v=><option key={v} value={v}>{v}×</option>)}</select></label></>}
    </div>
    {settings.strategy!=='bb_outer_reversal'&&<p className="notice">Select BB Outer Band Reversal + Trailing SL in Strategy settings to start a new paper session.</p>}
    <div className="form-actions"><button disabled={busy||!!s?.running||settings.strategy!=='bb_outer_reversal'} onClick={()=>void action('start')}>{s?'Start new virtual session':'Start virtual bot'}</button>
      {s&&<button className="secondary" disabled={busy||s.halted||s.completed} onClick={()=>void action(s.running?'pause':'resume')}>{s.running?'Pause bot':'Resume bot'}</button>}
    </div>
    {(error||data.error)&&<p className="error" role="alert">{error||data.error}</p>}
    {s&&<><p role="status">{s.halted?'Halted: balance is zero or negative.':s.completed?'Replay complete':s.running?'Bot running':'Bot paused'} · Mode: {s.mode==='replay'?'Backtest replay':'Live'} · Started {date(s.startedAt)} · Last processed candle {date(s.lastProcessed)} · Last check {date(s.lastCheck)}</p>
      <p><strong>{s.mode==='replay'?'Replay clock':'Market clock'}: {date(s.virtualTime??s.lastProcessed)}</strong>{s.mode==='replay'&&s.replayEnd?` · Ends ${date(s.replayEnd)}`:''}</p>
      {s.mode==='replay'&&<label>Replay speed<select aria-label="Replay speed" disabled={busy||s.completed||s.halted} value={s.speed??300} onChange={e=>void changeSpeed(Number(e.target.value))}>{speeds.map(v=><option key={v} value={v}>{v}×</option>)}</select></label>}
      <p>Execution: {s.settings.entry_timeframe.toUpperCase()} · Leverage {s.settings.max_leverage}× · Amount per trade {s.settings.bb_reversal.amount_unit==='percent'?`${s.settings.bb_reversal.amount_per_trade??100}% of balance`:`$${s.settings.bb_reversal.amount_per_trade}`} · First eligible candle {date(s.tradingFrom)}.</p>
      <div className="metrics">{[['Virtual balance',fmt(s.balance)],['Equity',fmt(s.displayEquity??s.equity)],['Unrealized P&L',fmt((s.displayEquity??s.equity)-s.balance)],['Realized P&L',fmt(s.balance-s.settings.capital)],['Closed trades',String(s.trades.length)],['Current price',fmt(s.displayPrice??s.latestPrice,3)]].map(([label,value])=><article key={label}><small>{label}</small><strong>{value}</strong></article>)}</div>
      {s.quoteError&&<p role="alert" className="error">Live price update failed: {s.quoteError}</p>}
      <p>{s.mode==='replay'?'Replay updates every second using a simulated price path inside each historical 1-minute candle. This animation is not recorded tick data.':'Live prices refresh approximately every second from OKX.'} The forming {s.settings.entry_timeframe} candle combines the available 1-minute candles. Signals use only completed execution candles.</p>
      <h3>Price & trades ? {s.settings.entry_timeframe.toUpperCase()}</h3>
      <p>Green arrows: buys ? red arrows: sells ? circles: exits ? red line: active stop ? blue line: open entry. Turn off Follow bot clock to pan and zoom earlier candles. Shows the latest 1,000 revealed candles, including pre-session warmup.</p>
      {visible&&<PaperPriceChart sessionId={s.startedAt} candles={chartCandles} indicators={s.chartIndicators??[]} stops={s.chartStops??[]} trades={s.trades} position={s.openPosition} showSma={s.settings.bb_reversal.use_sma_trend_adjustment!==false}/>}
      <h3>Open virtual position</h3>{p?<p>{p.direction===1?'Long':'Short'} · Entry {date(p.entry_time)} at {fmt(p.entry_price,3)} · Quantity {fmt(p.quantity,4)} · Stop {fmt(p.stop,3)} · Trailing {p.trailing_active?'active':'waiting'}.</p>:<p>No open position. Waiting for the next qualifying signal.</p>}
      {!!s.equityHistory.length&&<EquityChart period={{name:'Paper trading',equity:s.equityHistory}}/>}
      <h3>Virtual trade ledger</h3><div className="table-scroll"><table><thead><tr>{['Trade','Side','Entry time','Entry','Exit time','Exit','Quantity','P&L','Reason'].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{s.trades.slice(-100).reverse().map(t=><tr key={t.id}><td>#{t.id}</td><td>{t.direction===1?'Long':'Short'}</td><td>{date(t.entry_time)}</td><td>{fmt(t.entry_price,3)}</td><td>{date(t.exit_time)}</td><td>{fmt(t.exit_price,3)}</td><td>{fmt(t.quantity,4)}</td><td className={t.pnl>=0?'positive':'negative'}>{fmt(t.pnl)}</td><td>{t.exit_reason.replaceAll('_',' ')}</td></tr>)}</tbody></table></div>
      <p>Shows the latest 100 closed trades. This is a candle-based simulation with zero modeled costs and no margin liquidation. Current equity follows the displayed price; the equity graph records completed execution candles.</p>
    </>}
  </div>;
}

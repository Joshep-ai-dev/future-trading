import {useCallback,useEffect,useMemo,useState,type FormEvent} from 'react';
import {api} from './api';
import BacktestChart,{EquityChart} from './BacktestChart';
import {fmt,type BacktestSettings,type BacktestResult,type Trade} from './types';
const utc = (t:number)=>new Date(t*1000).toISOString().replace('T',' ').slice(0,16);
const labels: [keyof BacktestSettings,string,number,number,number][] = [
  ['capital','Starting account (USDT)',1,1e9,100],['tick_size','Tick size (price units)',.00001,10,.00001],
  ['fee_bps','Fee per side (bps)',0,100,.1],['spread','Full spread (price units)',0,10,.001],
  ['slippage','Slippage per fill (price units)',0,10,.001],['funding_bps','Funding per 8 hours (bps)',-100,100,.1],
  ['max_leverage','Notional / equity cap',1,100,.5],['session_start','Session start hour',0,23,1],['session_end','Session end hour (24 = midnight)',0,24,1]
];
function initial(range:{startDate:string;endDate:string}):BacktestSettings {
  const start = Date.parse(range.startDate), end = Date.parse(range.endDate);
  return {start_date:range.startDate,end_date:range.endDate,validation_date:new Date(start+Math.max(86400000,Math.floor((end-start)/86400000*.7)*86400000)).toISOString().slice(0,10),capital:2000,tick_size:.01,fee_bps:5,spread:.01,slippage:.01,funding_bps:1,max_leverage:1,session_start:0,session_end:24,session_timezone:'UTC'};
}
export default function BacktestPanel({range}:{range:{startDate:string;endDate:string}}) {
  const [settings,setSettings]=useState(()=>initial(range));
  const [result,setResult]=useState<BacktestResult|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [periodKey,setPeriodKey]=useState<'research'|'validation'>('research');
  const [selected,setSelected]=useState<Trade|null>(null),[page,setPage]=useState(0);
  const selectTrade=useCallback((t:Trade)=>setSelected(t),[]);
  async function run(e?:FormEvent) {
    e?.preventDefault();setBusy(true);setError('');
    try {
      const value = await api<BacktestResult>('/api/backtest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(settings)});
      setResult(value);setSelected(value[periodKey].trades[0]??null);setPage(0);
    } catch(e) {setError(String(e));} finally {setBusy(false);}
  }
  useEffect(()=>{void run();},[]);
  const period=result?.[periodKey];
  const stale=result && Object.keys(settings).some(k=>settings[k as keyof BacktestSettings]!==result.settings[k as keyof BacktestSettings]);
  const summary=period?.summary;
  const pages=period?Math.max(1,Math.ceil(period.trades.length/15)):1;
  const chartCandles=useMemo(()=>result?.candles.filter(c=>period && c.time>=period.start && c.time<period.end)??[],[result,period]);
  function download() {
    if(!result)return;
    const blob=new Blob([JSON.stringify(result,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob), a=document.createElement('a');a.href=url;a.download='silver-sweep-backtest.json';a.click();URL.revokeObjectURL(url);
  }
  return <section className="backtest"><div className="section-heading"><div><small>PRICE ACTION · MARKET STRUCTURE · SWEEP</small><h2>15m direction / 5m entry backtest</h2></div><span className="badge">Fixed rules · 0.5% risk</span></div>
    <p>Rising confirmed highs and lows allow longs; falling highs and lows allow shorts. A sweep reclaims the previous six completed 5m candles’ extreme. Entry is one tick beyond the sweep candle, valid for three candles; stop is one tick beyond its opposite extreme, target is 2R. No replacement strategy is used for ranges.</p>
    <form onSubmit={run}><fieldset disabled={busy}><div className="settings-grid">
      {(['start_date','validation_date','end_date'] as const).map((key,i)=><label key={key}>{['Start date (UTC)','Validation starts (UTC)','End date inclusive (UTC)'][i]}<input type="date" required min={range.startDate} max={range.endDate} value={settings[key]} onChange={e=>setSettings({...settings,[key]:e.target.value})}/></label>)}
      {labels.map(([key,label,min,max,step])=><label key={key}>{label}<input type="number" required min={min} max={max} step={step} value={settings[key]} onChange={e=>setSettings({...settings,[key]:Number(e.target.value)})}/></label>)}
      <label>Session timezone<select value={settings.session_timezone} onChange={e=>setSettings({...settings,session_timezone:e.target.value})}>{['UTC','Asia/Shanghai','America/New_York','Europe/London'].map(t=><option key={t}>{t}</option>)}</select></label>
    </div><div className="form-actions"><span>Available {range.startDate} – {range.endDate} · max 2 trades / session · stop after 2 losses</span><button type="submit">{busy?'Backtesting…':'Run backtest'}</button></div></fieldset></form>
    <p className="notice">Tick size and costs are editable assumptions, not verified exchange specifications. Defaults: 0.01 tick, 5 bps fee per side, 0.01 full spread, 0.01 slippage per fill, +1 bp funding at 00/08/16 UTC. Positive funding charges longs and credits shorts. These candles contain no historical funding, spread, or order-book data.</p>
    <details><summary>Execution and validation rules</summary><p>Strict swings require two lower highs or higher lows on each side and are usable only after the second following 15m candle closes. Resistance/support uses all previously confirmed 15m swings still unbroken by a 15m close. Skip if the nearest level offers less than 2R; recheck on gap fills.</p><p>One position or pending order at a time. Orders fill only on the next three 5m bars; stops win when intrabar ordering is unknown. Entry-bar stops are conservative. Spread/2 + slippage is adverse on every fill, including targets. Fees apply on both sides. Funding is a fixed scenario at UTC 00/08/16 for positions already open. Positions close and pending orders cancel at session or period end; missing data forces a last-known-close exit.</p><p>Risk budget is 0.5% of current equity including estimated stop execution and fees; a notional cap can reduce actual risk. Gaps and funding can exceed planned risk. Quantity is continuous silver-equivalent units, without contract lot rounding or liquidation simulation. Shaded zones show gross 2R geometry; net reward is lower after costs.</p><p>Research and validation use identical settings and each starts with the selected account balance. Earlier candles warm up swing structure; no position crosses the split. The initial split reserves the final 30% of calendar history. Validation is a later-period check, not proof of profitability or a fresh holdout after repeated tuning. Execution timestamps identify the containing 5m candle, not an exact intrabar fill.</p><p>Previous highs/lows as support and resistance: <a href="https://www.cmegroup.com/education/courses/trading-and-analysis/support-and-resistance.html" target="_blank" rel="noreferrer">CME reference</a>. Candle sweeps do not establish actual order clusters.</p></details>
    {error&&<p role="alert" className="error">{error}</p>}{busy&&<p role="status">Simulating completed candles and trading costs…</p>}{stale&&<p className="notice">Settings changed. Results still use the last run; run backtest to update.</p>}
    {result&&period&&summary&&<><div className="section-heading period-tabs"><div>{(['research','validation'] as const).map(key=><button key={key} type="button" className={periodKey===key?'active':'secondary'} onClick={()=>{setPeriodKey(key);setSelected(result[key].trades[0]??null);setPage(0);}}>{key==='research'?'Research':'Validation'} · {result[key].summary.trades} trades</button>)}</div><button className="secondary" onClick={download}>Export result JSON</button></div>
      <p>{period.name}: {utc(period.start)} → {utc(period.end)} UTC (end exclusive). Account resets to {fmt(result.settings.capital)} USDT. Session {result.settings.session_start}:00–{result.settings.session_end}:00 {result.settings.session_timezone}. Entry timeframe stays 5m regardless of the price chart selector.</p>
      <div className="metrics">{[['Net return',`${fmt(summary.returnPct)}%`],['Ending equity',`${fmt(summary.endingBalance)} USDT`],['Closed trades',String(summary.trades)],['Win rate',`${fmt(summary.winRate)}%`],['Max drawdown',`${fmt(summary.maxDrawdownPct)}%`],['Profit factor',summary.profitFactor===null?'N/A':fmt(summary.profitFactor)],['Average net R',fmt(summary.averageR)],['Fees',`${fmt(summary.fees)} USDT`],['Funding paid / credit',`${fmt(summary.funding)} USDT`],['Spread + slippage',`${fmt(summary.executionCost)} USDT`]].map(([label,value])=><article key={label}><small>{label}</small><strong>{value}</strong></article>)}</div>
      <p className={summary.meets100Trades?'caption':'notice'}>{summary.meets100Trades?'100-trade sample reached.':`Only ${summary.trades} / 100 trades. This period does not meet the requested sample size.`} {summary.wins} wins, {summary.losses} losses; net P&amp;L {fmt(summary.netPnl)} USDT. {period.status==='no_complete_bars'?'No complete bars within this period.':''}</p>
      <p>{period.diagnostics.sweeps} sweep setups · {period.diagnostics.blockedByLevel} blocked by nearby levels · {period.diagnostics.expiredOrders} expired orders · {period.diagnostics.cancelledOrders} cancelled orders · {period.diagnostics.ambiguousBars} conservative intrabar exits.</p>
      <h3>Equity after costs</h3><EquityChart period={period}/>
      <div className="section-heading"><h3>Trading positions · 5m</h3><button className="secondary" onClick={()=>setSelected(null)}>Latest candles / all markers</button></div>
      <p>Green arrows: buys · rose arrows: sells · circles: exits. Select a trade to focus its sweep, blue entry line, red stop zone, and green target zone. Chart shows up to 5,000 recent candles in overview; selecting any table row loads that trade’s earlier candles.</p>
      <BacktestChart candles={chartCandles} trades={period.trades} selected={selected} onSelect={selectTrade}/>
      {selected&&<div className="trade-detail"><h3>#{selected.id} {selected.direction===1?'Long':'Short'} · {selected.exitReason.replaceAll('_',' ')}</h3><p>Sweep {utc(selected.signalTime)} · entry {utc(selected.entryTime)} · exit {utc(selected.exitTime)} UTC. Entry {fmt(selected.entry,3)} → exit {fmt(selected.exit,3)} · stop {fmt(selected.stop,3)} · target {fmt(selected.target,3)} · quantity {fmt(selected.quantity,4)}.</p><p>Risk budget {fmt(selected.riskBudget)} / planned stop loss {fmt(selected.plannedRisk)} USDT · net P&amp;L {fmt(selected.netPnl)} USDT ({fmt(selected.netR)} R). Confirmed highs {selected.swingHighs.map(v=>fmt(v,3)).join(' → ')}; lows {selected.swingLows.map(v=>fmt(v,3)).join(' → ')}. {selected.ambiguous?'Intrabar sequence was ambiguous; conservative stop assumed.':''}</p></div>}
      <h3>Trade ledger · select a row to show its position</h3><div className="table-scroll"><table><thead><tr>{['Trade','Entry UTC','Side','Entry','Stop','Target','Exit','Net P&L','Net R','Exit reason'].map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>{period.trades.slice(page*15,page*15+15).map(t=><tr key={t.id} onClick={()=>selectTrade(t)} className={selected?.id===t.id?'selected-row':''}><td><button className="trade-link" onClick={()=>selectTrade(t)}>#{t.id}</button></td><td>{utc(t.entryTime)}</td><td>{t.direction===1?'Long':'Short'}</td>{[t.entry,t.stop,t.target,t.exit].map((v,i)=><td key={i}>{fmt(v,3)}</td>)}<td className={t.netPnl>=0?'positive':'negative'}>{fmt(t.netPnl)}</td><td>{fmt(t.netR)}</td><td>{t.exitReason.replaceAll('_',' ')}</td></tr>)}</tbody></table></div>
      {!period.trades.length&&<p>No trades met all rules in this period.</p>}<div className="pagination"><button className="secondary" disabled={page===0} onClick={()=>setPage(page-1)}>Previous</button><span>Page {page+1} / {pages}</span><button className="secondary" disabled={page+1>=pages} onClick={()=>setPage(page+1)}>Next</button></div>
    </>}
  </section>;
}

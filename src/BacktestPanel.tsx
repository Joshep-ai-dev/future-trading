import {useCallback,useEffect,useMemo,useState,type FormEvent} from 'react';
import {api} from './api';
import BBReversalSettings,{bbDefaults} from './BBReversalSettings';
import PaperTrading from './PaperTrading';
import BacktestChart,{EquityChart} from './BacktestChart';
import type {Page} from './Tabs';
import {fmt,type BacktestSettings,type BacktestResult,type Trade} from './types';
const utc=(t:number)=>new Date(t*1000).toISOString().replace('T',' ').slice(0,16);
const exitReasonLabel=(reason:string)=>({stop:'Stop loss',reversal:'Direction reversal',period_end:'Period end',data_gap:'Data gap',trailing_stop_at_close:'Trailing stop'}[reason]??reason.replaceAll('_',' '));

function initial(range:{startDate:string;endDate:string}):BacktestSettings {
  const start=Date.parse(range.startDate),end=Date.parse(range.endDate);
  return {bb_reversal:{...bbDefaults},atr_active:false,atr_period:14,atr_multiplier:2,ema_fast:20,ema_slow:50,rsi_period:20,rsi_threshold:50,rsi_active:true,bb_period:20,chartart_stop_pct:1,exit_condition:'none',stop_mode:'trailing',strategy:'bb_outer_reversal',direction_active:true,direction_timeframe:'1h',setup_active:true,setup_timeframe:'15m',entry_active:true,entry_timeframe:'5m',start_date:range.startDate,end_date:range.endDate,validation_date:new Date(start+Math.max(86400000,Math.floor((end-start)/86400000*.7)*86400000)).toISOString().slice(0,10),capital:2000,tick_size:.01,fee_bps:0,spread:0,slippage:0,funding_bps:0,max_leverage:1,session_start:0,session_end:24,session_timezone:'UTC'};
}
export default function BacktestPanel({range,view,onViewChange}:{range:{startDate:string;endDate:string};view:Page;onViewChange:(page:Page)=>void}) {
  const [settings,setSettings]=useState(()=>initial(range));
  const [result,setResult]=useState<BacktestResult|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [periodKey,setPeriodKey]=useState<'research'|'validation'>('research');
  const [selected,setSelected]=useState<Trade|null>(null),[page,setPage]=useState(0);
  const selectTrade=useCallback((trade:Trade)=>setSelected(trade),[]);
  async function run(e?:FormEvent){
    e?.preventDefault();setBusy(true);setError('');
    try{const value=await api<BacktestResult>('/api/backtest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(settings)});
      setResult(value);setSelected(value[periodKey].trades[0]??null);setPage(0);if(e)onViewChange('results');
    }catch(e){setError(String(e));}finally{setBusy(false);}
  }
  useEffect(()=>{void run();},[]);
  const period=result?.[periodKey],summary=period?.summary,resultTimeframe=result?.executionTimeframe??'5m';
  const stale=result&&Object.keys(settings).some(k=>JSON.stringify(settings[k as keyof BacktestSettings])!==JSON.stringify(result.settings[k as keyof BacktestSettings]));
  const exitCounts=useMemo(()=>Object.entries((period?.trades??[]).reduce<Record<string,number>>((counts,t)=>{counts[t.exitReason]=(counts[t.exitReason]??0)+1;return counts;},{})),[period]);
  const pages=period?Math.max(1,Math.ceil(period.trades.length/15)):1;
  const chartIndicators=useMemo(()=>result?.indicators.filter(c=>period&&c.time>=period.start&&c.time<period.end)??[],[result,period]);
  const chartCandles=useMemo(()=>result?.candles.filter(c=>period&&c.time>=period.start&&c.time<period.end)??[],[result,period]);
  function download(){if(!result)return;const url=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='bb-reversal-backtest.json';link.click();URL.revokeObjectURL(url);}
  return <section className="backtest">
    <PaperTrading settings={settings} visible={view==='paper'}/>
    <div id="page-strategy" role="tabpanel" aria-labelledby="tab-strategy" hidden={view!=='strategy'}>
      <h2>Strategy settings</h2><form onSubmit={run}><fieldset disabled={busy}>
        <BBReversalSettings settings={settings} onChange={setSettings}/>
        <div className="settings-grid"><label>Starting virtual balance ($)<input type="number" required min={1} max={1e9} step="any" value={settings.capital} onChange={e=>setSettings({...settings,capital:Number(e.target.value)})}/></label>
          {(['start_date','validation_date','end_date'] as const).map((key,i)=><label key={key}>{['Backtest start date (UTC)','Validation starts (UTC)','Backtest end date inclusive (UTC)'][i]}<input type="date" required min={range.startDate} max={range.endDate} value={settings[key]} onChange={e=>setSettings({...settings,[key]:e.target.value})}/></label>)}
        </div><p>Historical dates apply to the backtest. Live and replay are configured in Paper trading. Available history: {range.startDate} | {range.endDate}.</p>
        <div className="form-actions"><button type="submit">{busy?'Backtesting...':'Run backtest'}</button></div>
      </fieldset></form>
      <details><summary>Execution and validation rules</summary><p>Both directions, alternating filled entries. Signals fill at candle close. Stops include adverse opening gaps; trailing stops never loosen. Position notional is allocated amount | leverage. Research and validation start independently and close remaining trades at period end. Trading stops when balance is zero or negative. No modeled fees, funding, slippage, session filters or margin liquidation.</p></details>
    </div>
    {view!=='paper'&&<>{error&&<p role="alert" className="error">{error}</p>}{busy&&<p role="status">Simulating completed candles...</p>}{stale&&<p className="notice">Settings changed. Run backtest to update results.</p>}</>}
    <div id="page-results" role="tabpanel" aria-labelledby="tab-results" hidden={view!=='results'}>
    {result&&period&&summary?<>
      <div className="section-heading period-tabs"><div>{(['research','validation'] as const).map(key=><button key={key} disabled={busy} className={periodKey===key?'active':'secondary'} onClick={()=>{setPeriodKey(key);setSelected(result[key].trades[0]??null);setPage(0);}}>{key==='research'?'Research':'Validation'} | {result[key].summary.trades} trades</button>)}</div><button className="secondary" onClick={download}>Export result JSON</button></div>
      <p>{period.name}: {utc(period.start)} | {utc(period.end)} UTC. Starting balance ${fmt(result.settings.capital)} | execution {resultTimeframe.toUpperCase()} | leverage {result.settings.max_leverage}x.</p>
      <h2>Results & trades</h2><div className="metrics">{[['Net return',`${fmt(summary.returnPct)}%`],['Ending equity',`${fmt(summary.endingBalance)} USDT`],['Closed trades',String(summary.trades)],['Win rate',`${fmt(summary.winRate)}%`],['Max drawdown',`${fmt(summary.maxDrawdownPct)}%`],['Profit factor',summary.profitFactor===null?'N/A':fmt(summary.profitFactor)],['Average net R',fmt(summary.averageR)]].map(([label,value])=><article key={label}><small>{label}</small><strong>{value}</strong></article>)}</div>
      <p className={summary.meets100Trades?'caption':'notice'}>{summary.meets100Trades?'100-trade sample reached.':`Only ${summary.trades} / 100 trades. This period does not meet the requested sample size.`} {summary.wins} wins, {summary.losses} losses; net P&amp;L {fmt(summary.netPnl)} USDT. {period.status==='no_complete_bars'?'No complete bars within this period.':''}</p>
      <p>{period.diagnostics.signals} confirmed signals.</p>
      <div className="exit-breakdown" aria-label="Exit breakdown">{exitCounts.map(([reason,count])=><span key={reason}>{exitReasonLabel(reason)}: <b>{count}</b></span>)}</div>
      <h3>Account equity</h3><EquityChart period={period}/>
      <div className="section-heading"><h3>Trading positions · {resultTimeframe.toUpperCase()}</h3><button className="secondary" onClick={()=>setSelected(null)}>Latest candles / all markers</button></div>
      <p>Green arrows: buys · rose arrows: sells · circles: exits. Select a trade to focus its entry, exit, and moving stop. Drag or zoom to explore the full selected period, including candles before and after the selected trade.</p>
      <BacktestChart indicators={chartIndicators} indicatorSettings={result.settings} barSeconds={result.barSeconds??300} timeframe={resultTimeframe} candles={chartCandles} trades={period.trades} selected={selected} onSelect={selectTrade}/>
      {selected&&<div className="trade-detail"><h3>#{selected.id} {selected.direction===1?'Long':'Short'} | {exitReasonLabel(selected.exitReason)}</h3>
        <p>Entry {utc(selected.entryTime)} at {fmt(selected.entry,3)} | exit {utc(selected.exitTime)} at {fmt(selected.exit,3)} UTC. Quantity {fmt(selected.quantity,4)} | initial stop {fmt(selected.initialStop??selected.stop,3)} | final stop {fmt(selected.finalStop??selected.stop,3)}.</p>
        <p>Net P&amp;L {fmt(selected.netPnl)} USDT | {fmt(selected.netR)} R | planned stop risk {fmt(selected.plannedRisk)} USDT.</p>
        {(selected.stopHistory?.length??0)>1&&<details><summary>Stop adjustments</summary><table><thead><tr><th>UTC time</th><th>Stop</th><th>Rule</th></tr></thead><tbody>{selected.stopHistory!.map(h=><tr key={h.time}><td>{utc(h.time)}</td><td>{fmt(h.price,3)}</td><td>{h.reason}</td></tr>)}</tbody></table></details>}
      </div>}
      <h3>Trade ledger · select a row to show its position</h3><div className="table-scroll"><table><thead><tr>{['Trade','Entry UTC','Side','Entry','Stop','Exit','Net P&L','Net R','Exit reason'].map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>{period.trades.slice(page*15,page*15+15).map(t=><tr key={t.id} onClick={()=>selectTrade(t)} className={selected?.id===t.id?'selected-row':''}><td><button className="trade-link" onClick={()=>selectTrade(t)}>#{t.id}</button></td><td>{utc(t.entryTime)}</td><td>{t.direction===1?'Long':'Short'}</td>{[t.entry,t.stop,t.exit].map((v,i)=><td key={i}>{fmt(v,3)}</td>)}<td className={t.netPnl>=0?'positive':'negative'}>{fmt(t.netPnl)}</td><td>{fmt(t.netR)}</td><td>{exitReasonLabel(t.exitReason)}</td></tr>)}</tbody></table></div>
      {!period.trades.length&&<p>No trades met all rules in this period.</p>}<div className="pagination"><button className="secondary" disabled={page===0} onClick={()=>setPage(page-1)}>Previous</button><span>Page {page+1} / {pages}</span><button className="secondary" disabled={page+1>=pages} onClick={()=>setPage(page+1)}>Next</button></div>
    </>:<p>Run a backtest from Strategy settings to see results and trades.</p>}
    </div>
  </section>;
}

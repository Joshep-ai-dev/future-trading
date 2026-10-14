import TradeView from './TradeView';
import {useMemo,useState} from 'react';
import BacktestChart,{EquityChart} from './BacktestChart';
import {fmt,type BacktestResult,type Trade} from './types';
import {formatTradingTime,useTradingTimeZone,type TradingTimeZone} from './tradingTime';
import TradingChartHeader from './TradingChartHeader';

const utc=(t:number)=>new Date(t*1000).toISOString().replace('T',' ').slice(0,16);
const tradeTime=(t:number,zone:TradingTimeZone)=>formatTradingTime(t,zone);
const reason=(value:string)=>({rsi_price_exit:'RSI + price exit',stop:'Stop loss',trailing_stop:'Trailing stop',reversal:'Direction reversal',period_end:'End of backtest',data_gap:'Data gap',trailing_stop_at_close:'Trailing stop'}[value]??value.replaceAll('_',' '));

export default function ResultsWorkspace({result,busy,stale,onRun,onConfigure,onExport}:{result:BacktestResult|null;busy:boolean;stale:boolean;onRun:()=>void;onConfigure:()=>void;onExport:()=>void}){
  const [selectedId,setSelectedId]=useState<number|null>(null),[page,setPage]=useState(0);
  const tradingTimeZone=useTradingTimeZone();
  const p=result?.backtest,s=p?.summary;
  const selected=p?.trades.find(t=>t.id===selectedId)??null;
  const select=(trade:Trade)=>setSelectedId(trade.id);
  const pages=Math.max(1,Math.ceil((p?.trades.length??0)/15));
  const currentPage=Math.min(page,pages-1);
  const exits=useMemo(()=>Object.entries((p?.trades??[]).reduce<Record<string,number>>((counts,t)=>{counts[t.exitReason]=(counts[t.exitReason]??0)+1;return counts;},{})),[p]);
  return <>
    <div className="workspace-heading"><div><span className="eyebrow">BACKTEST REPORT</span><h1>Backtest</h1><p>Review the run, its performance and every simulated trade.</p></div><div className="workspace-actions"><button className="secondary" onClick={onConfigure}>Edit settings</button>{result&&<button className="secondary" onClick={onExport}>Export JSON</button>}<button disabled={busy} onClick={onRun}>{busy?'Running…':'Run backtest'}</button></div></div>
    {stale&&<p className="notice">Settings have changed. These results use the previous configuration.</p>}
    {result&&p&&s?<>
      <div className="run-context"><span className="run-label">BB OUTER BAND REVERSAL</span><span>{result.executionTimeframe.toUpperCase()} candles</span><span>{result.settings.max_leverage}× leverage</span><span>{utc(p.start)} — {utc(p.end)} UTC</span><span className="paper-badge">SIMULATED</span></div>
      <div className="result-scorecards">
        <article><small>Net P&amp;L</small><strong className={s.netPnl>=0?'positive':'negative'}>{s.netPnl>=0?'+':''}${fmt(s.netPnl)}</strong><span className={s.returnPct>=0?'positive':'negative'}>{s.returnPct>=0?'+':''}{fmt(s.returnPct)}% return</span></article>
        <article><small>Ending balance</small><strong>${fmt(s.endingBalance)}</strong><span>Started with ${fmt(result.settings.capital)}</span></article>
        <article><small>Win rate</small><strong>{fmt(s.winRate)}%</strong><span>{s.wins} wins · {s.losses} losses</span></article>
        <article><small>Max drawdown</small><strong className="negative">{fmt(s.maxDrawdownPct)}%</strong><span>Measured on closing equity</span></article>
      </div>
      <div className="results-layout"><div className="results-main">
        <section className="terminal-panel result-chart"><TradingChartHeader timeframe={result.executionTimeframe} mode="BACKTEST" caption={`Backtest executions on ${result.executionTimeframe} candles`} actions={<button className="text-button" onClick={()=>setSelectedId(null)}>Show latest ↗</button>}/>
          <BacktestChart indicators={result.indicators} indicatorSettings={result.settings} barSeconds={result.barSeconds} timeframe={result.executionTimeframe} candles={result.candles} trades={p.trades} selected={selected} onSelect={select}/>
          <div className="chart-legend"><span><i className="legend-dot buy"/> Buy</span><span><i className="legend-dot sell"/> Sell / exit</span><span><i className="legend-line"/> Stop</span><span className="legend-note">Select a marker or trade to inspect its position</span></div>
        </section>
        <section className="terminal-panel results-ledger"><div className="panel-heading"><h2>Trade ledger <span className="count-tag">{p.trades.length}</span></h2><small>Click a row to focus the chart</small></div>
          <TradeView scope="Backtest" capital={result.settings.capital} timeZone={tradingTimeZone} trades={p.trades.map(t=>({id:t.id,direction:t.direction,pnl:t.netPnl,entry:t.entry,exit:t.exit,quantity:t.quantity,exitTime:t.exitTime+result.barSeconds}))} onSelect={setSelectedId}>{p.trades.length?<><div className="table-scroll"><table><thead><tr>{['Trade','Side',`Entry candle (${tradingTimeZone})`,'Entry','Exit','Net P&L','R','Exit reason'].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{p.trades.slice(currentPage*15,currentPage*15+15).map(t=><tr key={t.id} className={selectedId===t.id?'selected-row':''} onClick={()=>select(t)}><td><button className="trade-link" onClick={()=>select(t)}>#{t.id}</button></td><td><span className={`side-badge ${t.direction===1?'long':'short'}`}>{t.direction===1?'LONG':'SHORT'}</span></td><td>{tradeTime(t.entryTime,tradingTimeZone)}</td><td>{fmt(t.entry,3)}</td><td>{fmt(t.exit,3)}</td><td className={t.netPnl>=0?'positive':'negative'}>{t.netPnl>=0?'+':''}{fmt(t.netPnl)}</td><td>{fmt(t.netR)}</td><td>{reason(t.exitReason)}</td></tr>)}</tbody></table></div><div className="pagination"><button className="secondary" disabled={!currentPage} onClick={()=>setPage(currentPage-1)}>Previous</button><span>{currentPage+1} / {pages}</span><button className="secondary" disabled={currentPage+1>=pages} onClick={()=>setPage(currentPage+1)}>Next</button></div></>:<div className="empty-position"><h3>No qualified trades</h3><p>{p.status==='no_complete_bars'?'No complete candles are available in this date range.':'No candles met all the entry conditions during this backtest.'}</p></div>}</TradeView>
        </section>
      </div><aside className="results-sidebar">
        <section className="terminal-panel"><div className="panel-heading"><h2>Performance breakdown</h2></div><dl className="result-breakdown">{[['Closed trades',String(s.trades)],['Profit factor',s.profitFactor===null?'—':fmt(s.profitFactor)],['Average R',fmt(s.averageR)],['Confirmed signals',String(p.diagnostics.signals)],['Position sizing','Amount × leverage']].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><div className="sample-info"><span className="eyebrow">TRADE SAMPLE</span><p>{s.trades} closed trades in the selected period.</p></div></section>
        <section className="terminal-panel"><div className="panel-heading"><h2>Equity curve</h2></div><EquityChart key={`${p.start}:${p.end}`} period={p} initialValue={result.settings.capital} intervalSeconds={result.barSeconds}/></section>
        <section className="terminal-panel trade-inspector"><div className="panel-heading"><h2>Position inspector</h2>{selected&&<span className="count-tag">#{selected.id}</span>}</div>{selected?<><div className="inspector-side"><span className={`side-badge ${selected.direction===1?'long':'short'}`}>{selected.direction===1?'LONG':'SHORT'}</span><strong className={selected.netPnl>=0?'positive':'negative'}>{selected.netPnl>=0?'+':''}${fmt(selected.netPnl)}</strong></div><dl>{[[`Entry candle (${tradingTimeZone})`,tradeTime(selected.entryTime,tradingTimeZone)],[`Exit candle (${tradingTimeZone})`,tradeTime(selected.exitTime,tradingTimeZone)],['Quantity',fmt(selected.quantity,4)],['Initial stop',fmt(selected.initialStop??selected.stop,3)],['Final stop',fmt(selected.finalStop??selected.stop,3)],['Planned risk',`$${fmt(selected.plannedRisk)}`],['Exit reason',reason(selected.exitReason)]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>{(selected.stopHistory?.length??0)>1&&<details className="inspector-stops"><summary>Stop adjustments ({selected.stopHistory!.length-1})</summary><table><thead><tr><th>{tradingTimeZone} candle</th><th>Price</th></tr></thead><tbody>{selected.stopHistory!.map(h=><tr key={h.time}><td>{tradeTime(h.time,tradingTimeZone)}</td><td>{fmt(h.price,3)}</td></tr>)}</tbody></table></details>}</>:<div className="empty-position"><span className="empty-state-symbol">◇</span><h3>Inspect a trade</h3><p>Select a chart marker or ledger row to see entry, exit and stop details.</p></div>}</section>
        {!!exits.length&&<section className="terminal-panel"><div className="panel-heading"><h2>Exit distribution</h2></div><dl>{exits.map(([key,count])=><div key={key}><dt>{reason(key)}</dt><dd>{count}</dd></div>)}</dl></section>}
      </aside></div>
    </>:<div className="analysis-empty"><span className="empty-chart-icon">⌁</span><h2>{busy?'Building your backtest':'Your strategy, measured'}</h2><p>{busy?'Processing completed candles and simulated trades…':'Choose your parameters and a date range, then run a backtest to explore performance and every executed trade.'}</p>{!busy&&<button onClick={onConfigure}>Configure backtest</button>}</div>}
  </>;
}

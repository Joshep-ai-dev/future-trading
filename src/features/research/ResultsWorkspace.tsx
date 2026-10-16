import TradeView from '../../shared/ui/TradeView';
import {Button,EmptyState,PageHeader,Panel,TabBar} from '../../shared/ui/ui';
import {useEffect,useMemo,useState} from 'react';
import {api} from '../../shared/api/api';
import BacktestChart,{EquityChart} from '../../shared/charts/BacktestChart';
import {fmt,type BacktestResult,type Trade} from '../../shared/types/types';
import {formatTradingTime,useTradingTimeZone,type TradingTimeZone} from '../../shared/charts/tradingTime';
import TradingChartHeader from '../../shared/charts/TradingChartHeader';
import SavedRuns from './SavedRuns';
import {BalanceSparkline,DrawdownChart,PayoffBars,WinDonut,balanceSeries,drawdownSeries} from './ResultCharts';

const money=(value:number)=>`${value>=0?'+':'-'}$${fmt(Math.abs(value))}`;
const utc=(t:number)=>new Date(t*1000).toISOString().replace('T',' ').slice(0,16);
const tradeTime=(t:number,zone:TradingTimeZone)=>formatTradingTime(t,zone);
const reason=(value:string)=>({rsi_price_exit:'RSI + price exit',stop:'Stop loss',reversal:'Direction reversal',period_end:'End of backtest',data_gap:'Data gap',trailing_stop_at_close:'Trailing stop'}[value]??value.replaceAll('_',' '));

export default function ResultsWorkspace({result,busy,stale,onRun,onConfigure,onExport,summary,onOpenRun,onApplySettings}:{onApplySettings:()=>void;result:BacktestResult|null;busy:boolean;stale:boolean;onRun:()=>void;onConfigure:()=>void;onExport:()=>void;summary?:[string,string][];onOpenRun:(id:number)=>void}){
  const [selectedId,setSelectedId]=useState<number|null>(null),[page,setPage]=useState(0);
  const tradingTimeZone=useTradingTimeZone();
  const p=result?.backtest,s=p?.summary;
  const selected=p?.trades.find(t=>t.id===selectedId)??null;
  const select=(trade:Trade)=>setSelectedId(trade.id);
  const pages=Math.max(1,Math.ceil((p?.trades.length??0)/15));
  const currentPage=Math.min(page,pages-1);
  const [testerTab,setTesterTab]=useState<'trades'|'balance'|'exits'|'saved'>('trades');
  const [savedName,setSavedName]=useState<string|null>(null),[savedTick,setSavedTick]=useState(0);
  useEffect(()=>{setSavedName(null);},[result?.runId]);
  function showHistory(){setTesterTab('saved');requestAnimationFrame(()=>document.querySelector('.result-tester')?.scrollIntoView({behavior:'smooth',block:'start'}));}
  async function saveAs(){
    if(!result?.runId)return;
    const name=window.prompt('Name this backtest result',savedName??'')?.trim();
    if(!name)return;
    await api(`/api/backtests/${result.runId}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});
    setSavedName(name);setSavedTick(value=>value+1);
  }
  const costs=s?s.fees+s.executionCost+s.funding:0;
  const drawdown=Math.abs(s?.maxDrawdownPct??0),risk=drawdown<10?'Low':drawdown<25?'Moderate':'High';
  const pnls=useMemo(()=>(p?.trades??[]).map(t=>t.netPnl),[p]);
  const balances=useMemo(()=>balanceSeries(result?.settings.capital??0,pnls),[pnls,result]);
  const drawdowns=useMemo(()=>drawdownSeries(balances),[balances]);
  const stats=useMemo(()=>{
    const wins=pnls.filter(v=>v>0),losses=pnls.filter(v=>v<=0);
    let winStreak=0,lossStreak=0,run=0,sign=0;
    for(const v of pnls){const next=v>0?1:-1;run=next===sign?run+1:1;sign=next;if(next>0)winStreak=Math.max(winStreak,run);else lossStreak=Math.max(lossStreak,run);}
    const mean=(xs:number[])=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:0;
    return {avgWin:mean(wins),avgLoss:mean(losses),best:pnls.length?Math.max(...pnls):0,worst:pnls.length?Math.min(...pnls):0,winStreak,lossStreak};
  },[pnls]);
  const days=p?Math.max(1,Math.round((p.end-p.start)/86400)):0;
  const exits=useMemo(()=>Object.entries((p?.trades??[]).reduce<Record<string,number>>((counts,t)=>{counts[t.exitReason]=(counts[t.exitReason]??0)+1;return counts;},{})),[p]);
  return <>
    <PageHeader eyebrow="BB OUTER BAND REVERSAL" title="Backtest results" actions={<><Button variant="secondary" onClick={onConfigure}>Edit settings</Button>{result&&<Button variant="secondary" onClick={showHistory}>History</Button>}{result?.runId&&<Button variant="secondary" onClick={()=>void saveAs()}>{savedName?`Saved: ${savedName}`:'Save as…'}</Button>}{result&&<Button variant="secondary" onClick={onExport}>Export results</Button>}<Button disabled={busy} onClick={onRun}>{busy?'Running…':'Run backtest'}</Button></>}/>
    {stale&&<p className="notice result-stale">Your current bot settings differ from this run.<button type="button" className="secondary" onClick={onApplySettings}>Use these settings</button></p>}
    {result&&p&&s?<>
      <div className="result-run-line"><span>{result.executionTimeframe} candles</span><span>{result.settings.max_leverage}× leverage</span><span>${fmt(result.settings.capital)} start</span><span>{utc(p.start)} → {utc(p.end)} UTC · {days} days</span><span className="is-muted">Simulated</span></div>
      <div className="result-answers">
        <section className="result-answer">
          <header><span>Did it make money?</span><em className={s.netPnl>=0?'tag-good':'tag-bad'}>{s.netPnl>=0?'Profit':'Loss'}</em></header>
          <strong className={s.netPnl>=0?'positive':'negative'}>{money(s.netPnl)}<small>{s.returnPct>=0?'+':''}{fmt(s.returnPct)}%</small></strong>
          <p>${fmt(result.settings.capital)} → <b>${fmt(s.endingBalance)}</b> in {days} days</p>
          <BalanceSparkline values={balances} positive={s.netPnl>=0}/>
        </section>
        <section className="result-answer">
          <header><span>How often did it win?</span><em className={s.profitFactor!==null&&s.profitFactor>=1?'tag-good':'tag-bad'}>PF {s.profitFactor===null?'—':fmt(s.profitFactor)}</em></header>
          <div className="answer-donut-row"><WinDonut wins={s.wins} losses={s.losses}/>
            <div className="answer-donut-copy"><span><i className="dot-good"/><b>{s.wins}</b> wins</span><span><i className="dot-bad"/><b>{s.losses}</b> losses</span>
              <p>{s.profitFactor===null?'No losing trades.':<>Won <b className={s.profitFactor>=1?'positive':'negative'}>${fmt(s.profitFactor)}</b> per $1 lost</>}</p></div>
          </div>
          <PayoffBars avgWin={stats.avgWin} avgLoss={stats.avgLoss}/>
        </section>
        <section className="result-answer">
          <header><span>How risky was it?</span><em className={risk==='Low'?'tag-good':risk==='Moderate'?'tag-warn':'tag-bad'}>{risk} risk</em></header>
          <strong className="negative">−{fmt(Math.abs(s.maxDrawdownPct))}%<small>max drawdown</small></strong>
          <p>Worst fall below a previous high{result.settings.max_leverage>1?` · ${result.settings.max_leverage}× leverage`:''}</p>
          <DrawdownChart values={drawdowns}/>
        </section>
        <section className="result-answer">
          <header><span>Trade details</span><em className="tag-neutral">{s.trades} trades</em></header>
          <dl className="answer-facts">
            <div><dt>Avg win</dt><dd className="positive">{money(stats.avgWin)}</dd></div>
            <div><dt>Avg loss</dt><dd className="negative">{money(stats.avgLoss)}</dd></div>
            <div><dt>Best</dt><dd className="positive">{money(stats.best)}</dd></div>
            <div><dt>Worst</dt><dd className="negative">{money(stats.worst)}</dd></div>
            <div><dt>Win streak</dt><dd>{stats.winStreak}</dd></div>
            <div><dt>Loss streak</dt><dd>{stats.lossStreak}</dd></div>
            <div><dt>Per trade</dt><dd className={s.netPnl>=0?'positive':'negative'}>{money(s.trades?s.netPnl/s.trades:0)}</dd></div>
            <div><dt>Costs</dt><dd>{costs<0?`+$${fmt(-costs)}`:`$${fmt(costs)}`}</dd></div>
          </dl>
        </section>
      </div>
      <div className="results-layout result-workspace"><div className="results-main">
        <section className="terminal-panel result-chart price-panel"><TradingChartHeader timeframe={result.executionTimeframe} mode="BACKTEST" caption=""/>
          <BacktestChart indicators={result.indicators} indicatorSettings={result.settings} barSeconds={result.barSeconds} timeframe={result.executionTimeframe} candles={result.candles} trades={p.trades} selected={selected} onSelect={select}/>
          <div className="chart-legend"><span><i className="legend-dot buy"/> Buy</span><span><i className="legend-dot sell"/> Sell / exit</span><span><i className="legend-line"/> Stop</span><span className="legend-hint">Click a marker or a trade row to inspect it</span></div>
        </section>
      </div><aside className="results-sidebar">
        <section className="terminal-panel trade-inspector"><div className="panel-heading"><h2>Position inspector</h2>{selected&&<span className="count-tag">#{selected.id}</span>}</div>{selected?<><div className="inspector-side"><span className={`side-badge ${selected.direction===1?'long':'short'}`}>{selected.direction===1?'LONG':'SHORT'}</span><strong className={selected.netPnl>=0?'positive':'negative'}>{selected.netPnl>=0?'+':''}${fmt(selected.netPnl)}</strong></div><dl>{[[`Entry candle (${tradingTimeZone})`,tradeTime(selected.entryTime,tradingTimeZone)],[`Exit candle (${tradingTimeZone})`,tradeTime(selected.exitTime,tradingTimeZone)],['Quantity',fmt(selected.quantity,4)],['Initial stop',fmt(selected.initialStop??selected.stop,3)],['Final stop',fmt(selected.finalStop??selected.stop,3)],['Planned risk',`$${fmt(selected.plannedRisk)}`],['Exit reason',reason(selected.exitReason)]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>{(selected.stopHistory?.length??0)>1&&<details className="inspector-stops"><summary>Stop adjustments ({selected.stopHistory!.length-1})</summary><table><thead><tr><th>{tradingTimeZone} candle</th><th>Price</th></tr></thead><tbody>{selected.stopHistory!.map(h=><tr key={h.time}><td>{tradeTime(h.time,tradingTimeZone)}</td><td>{fmt(h.price,3)}</td></tr>)}</tbody></table></details>}</>:<div className="empty-position"><span className="empty-state-symbol">◇</span><h3>Inspect a trade</h3><p>Select a chart marker or ledger row to see entry, exit and stop details.</p></div>}</section>
      </aside></div>
      <section className="terminal-panel result-tester">
        <TabBar items={[{value:'trades',label:'List of trades',count:p.trades.length,controls:'tester-trades'},{value:'balance',label:'Balance curve',controls:'tester-balance'},{value:'exits',label:'Why trades closed',controls:'tester-exits'},{value:'saved',label:'Saved runs',controls:'tester-saved'}] as const} value={testerTab} onChange={setTesterTab} label="Backtest details" idPrefix="tester-tab"/>
        <div id="tester-trades" role="tabpanel" aria-labelledby="tester-tab-trades" hidden={testerTab!=='trades'}><TradeView scope="Backtest" capital={result.settings.capital} timeZone={tradingTimeZone} trades={p.trades.map(t=>({id:t.id,direction:t.direction,pnl:t.netPnl,entry:t.entry,exit:t.exit,quantity:t.quantity,exitTime:t.exitTime+result.barSeconds}))} onSelect={setSelectedId}>{p.trades.length?<><div className="table-scroll"><table><thead><tr>{['Trade','Side',`Entry candle (${tradingTimeZone})`,'Entry','Exit','Net P&L','R','Exit reason'].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{p.trades.slice(currentPage*15,currentPage*15+15).map(t=><tr key={t.id} className={selectedId===t.id?'selected-row':''} onClick={()=>select(t)}><td><button className="trade-link" onClick={()=>select(t)}>#{t.id}</button></td><td><span className={`side-badge ${t.direction===1?'long':'short'}`}>{t.direction===1?'LONG':'SHORT'}</span></td><td>{tradeTime(t.entryTime,tradingTimeZone)}</td><td>{fmt(t.entry,3)}</td><td>{fmt(t.exit,3)}</td><td className={t.netPnl>=0?'positive':'negative'}>{t.netPnl>=0?'+':''}{fmt(t.netPnl)}</td><td>{fmt(t.netR)}</td><td>{reason(t.exitReason)}</td></tr>)}</tbody></table></div><div className="pagination"><button className="secondary" disabled={!currentPage} onClick={()=>setPage(currentPage-1)}>Previous</button><span>{currentPage+1} / {pages}</span><button className="secondary" disabled={currentPage+1>=pages} onClick={()=>setPage(currentPage+1)}>Next</button></div></>:<div className="empty-position"><h3>No qualified trades</h3><p>{p.status==='no_complete_bars'?'No complete candles are available in this date range.':'No candles met all the entry conditions during this backtest.'}</p></div>}</TradeView></div>
        <div id="tester-balance" role="tabpanel" aria-labelledby="tester-tab-balance" hidden={testerTab!=='balance'}>{testerTab==='balance'&&<EquityChart key={`${p.start}:${p.end}`} period={p} initialValue={result.settings.capital} trades={p.trades.map(t=>({pnl:t.netPnl}))}/>}</div>
        <div id="tester-saved" role="tabpanel" aria-labelledby="tester-tab-saved" hidden={testerTab!=='saved'}>{testerTab==='saved'&&<SavedRuns activeId={result.runId} refreshKey={`${result.runId}:${savedTick}`} onOpen={onOpenRun}/>}</div>
        <div id="tester-exits" role="tabpanel" aria-labelledby="tester-tab-exits" hidden={testerTab!=='exits'}><div className="exit-bars">{exits.sort((x,y)=>y[1]-x[1]).map(([key,count])=><div key={key}><span>{reason(key)}</span><div className="exit-bar"><i style={{width:`${count/Math.max(1,p.trades.length)*100}%`}}/></div><b>{count}</b><small>{fmt(count/Math.max(1,p.trades.length)*100)}%</small></div>)}{!exits.length&&<p>No closed trades.</p>}</div>
          <dl className="exit-facts"><div><dt>Confirmed signals</dt><dd>{p.diagnostics.signals}</dd></div><div><dt>Closed trades</dt><dd>{s.trades}</dd></div><div><dt>Position sizing</dt><dd>Amount × leverage</dd></div></dl></div>
      </section>
    </>:<Panel className="analysis-empty-panel"><EmptyState title={busy?'Building your backtest':'Test before you trade'} description={busy?'Processing completed candles and simulated trades…':'Run the current setup over the downloaded history to review performance, risk and every trade.'} action={!busy&&<div className="empty-actions"><Button onClick={onRun}>Run backtest now</Button><Button variant="secondary" onClick={onConfigure}>Review settings</Button></div>}/>{summary&&!busy&&<dl className="empty-run-summary">{summary.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}{!busy&&<div className="empty-saved-runs"><h3>Saved backtests</h3><SavedRuns compact onOpen={onOpenRun}/></div>}</Panel>}

  </>;
}

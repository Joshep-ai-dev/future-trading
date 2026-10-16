import {useState,type ReactNode} from 'react';
import {fmt} from '../types/types';
import {formatTradingTime,type TradingTimeZone} from '../charts/tradingTime';

export type PnlTrade={id:number;direction:number;pnl:number;entry:number|null;exit:number|null;quantity:number;exitTime:number};
const money=(value:number)=>`${value>0?'+':value<0?'-':''}$${fmt(Math.abs(value))}`;
const tone=(value:number)=>value>0?'profit':value<0?'loss':'flat';

export default function TradeView({trades,capital,unrealized=0,scope,children,onSelect,timeZone='UTC'}:{
  trades:PnlTrade[];capital:number;unrealized?:number;scope:'Session'|'Backtest'|'Live';children:ReactNode;onSelect?:(id:number)=>void;timeZone?:TradingTimeZone;
}){
  const storageKey=`silver.trades.view.${scope}`;
  const [view,setView]=useState<'table'|'grid'>(()=>{try{return localStorage.getItem(storageKey)==='grid'?'grid':'table';}catch{return 'table';}});
  const [page,setPage]=useState(0),[selectedId,setSelectedId]=useState<number|null>(null);
  const [filter,setFilter]=useState<'all'|'profit'|'loss'|'flat'>('all');
  const realized=trades.reduce((sum,t)=>sum+t.pnl,0),wins=trades.filter(t=>t.pnl>0).length;
  const losses=trades.filter(t=>t.pnl<0).length,flat=trades.length-wins-losses;
  const total=realized+unrealized,returnPct=capital>0?realized/capital*100:null;
  const filtered=trades.filter(t=>filter==='all'||tone(t.pnl)===filter);
  const pages=Math.max(1,Math.ceil(filtered.length/24)),currentPage=Math.min(page,pages-1);
  const recent=[...filtered].reverse().slice(currentPage*24,(currentPage+1)*24);
  const selected=trades.find(t=>t.id===selectedId);
  function changeView(next:'table'|'grid'){setView(next);try{localStorage.setItem(storageKey,next);}catch{/* Storage can be unavailable. */}}
  return <>
    <div className="trade-view-bar"><div className="trade-view-context"><strong>{scope==='Session'?'Session performance':scope==='Live'?'Exchange performance':'Trade performance'}</strong><small>{trades.length} closed trades · USDT</small></div><div className="trade-view-switch" role="group" aria-label={`${scope} trade display`}>
      <button type="button" aria-pressed={view==='table'} onClick={()=>changeView('table')}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12"/></svg>Table</button>
      <button type="button" aria-pressed={view==='grid'} onClick={()=>changeView('grid')}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2h4v4H2zM10 2h4v4h-4zM2 10h4v4H2zM10 10h4v4h-4z"/></svg>P&amp;L grid</button>
    </div></div>
    {view==='table'?children:<div className="pnl-card">
      <div className="pnl-card-summary">
        <div><h3>{scope} realized P&amp;L <small>USDT</small></h3><div className={`pnl-card-return ${tone(realized)}`}><strong>{returnPct===null?'—':`${returnPct>0?'+':''}${fmt(returnPct)}%`}</strong><span>{money(realized)}</span></div><small>Return on starting balance</small></div>
        <div className="pnl-card-win"><h3>Win rate</h3><strong>{trades.length?`${fmt(wins/trades.length*100)}%`:'—'}</strong><small>{wins} / {trades.length} closed trades</small></div>
      </div>
      <div className="pnl-win-bar" aria-hidden="true"><span className="wins" style={{width:`${trades.length?wins/trades.length*100:0}%`}}/><span className="losses" style={{width:`${trades.length?losses/trades.length*100:0}%`}}/></div>
      <dl className="pnl-card-totals"><div><dt>Total P&amp;L</dt><dd className={tone(total)}>{money(total)}</dd></div><div><dt>Unrealized P&amp;L</dt><dd className={tone(unrealized)}>{money(unrealized)}</dd></div></dl>
      <div className="pnl-grid-heading"><h3>Closed trades <span className="count-tag">{trades.length}</span></h3><span>One tile per trade · newest first</span></div>
      <div className="pnl-grid-key" role="group" aria-label="Filter trade grid">{([['all','All',trades.length],['profit','Wins',wins],['loss','Losses',losses],['flat','Breakeven',flat]] as const).map(([key,label,count])=><button type="button" key={key} className={key} aria-pressed={filter===key} onClick={()=>{setFilter(key);setPage(0);setSelectedId(null);}}>{label}<span>{count}</span></button>)}</div>
      {trades.length?<>
        <div className="pnl-explorer"><div className="pnl-explorer-main">
        {recent.length?<div className="pnl-trade-grid">{recent.map(t=><button key={t.id} type="button" className={`pnl-trade-tile ${tone(t.pnl)}`} aria-pressed={selectedId===t.id} aria-label={`Trade ${t.id}, ${t.direction===1?'long':'short'}, P&L ${money(t.pnl)}`} onClick={()=>{setSelectedId(t.id);onSelect?.(t.id);}}><span>#{t.id}<span>{t.direction===1?'↗ Long':'↘ Short'}</span></span><strong>{money(t.pnl)}</strong></button>)}</div>:<div className="pnl-filter-empty"><strong>No {filter==='profit'?'winning':filter==='loss'?'losing':'breakeven'} trades</strong><p>Choose another filter to explore your results.</p></div>}
        {pages>1&&<div className="pagination"><span>{currentPage*24+1}–{Math.min((currentPage+1)*24,filtered.length)} of {filtered.length}</span><button type="button" className="secondary" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>Previous</button><button type="button" className="secondary" disabled={currentPage+1===pages} onClick={()=>setPage(currentPage+1)}>Next</button></div>}
        </div>
        <aside className="pnl-trade-detail" aria-label="Selected trade" aria-live="polite">{selected?<><div className="pnl-detail-heading"><span className="eyebrow">TRADE #{selected.id}</span><button type="button" className="text-button" aria-label="Dismiss trade details" onClick={()=>setSelectedId(null)}>×</button></div><span className={`side-badge ${selected.direction===1?'long':'short'}`}>{selected.direction===1?'LONG':'SHORT'}</span><strong className={`pnl-detail-profit ${tone(selected.pnl)}`}>{money(selected.pnl)}</strong><small>Realized P&amp;L · USDT</small><dl><div><dt>Entry price</dt><dd>{fmt(selected.entry,3)}</dd></div><div><dt>Close price</dt><dd>{fmt(selected.exit,3)}</dd></div><div><dt>Quantity</dt><dd>{fmt(selected.quantity,4)}</dd></div><div><dt>Closed ({timeZone})</dt><dd>{formatTradingTime(selected.exitTime,timeZone)}</dd></div></dl></>:<div className="pnl-detail-empty"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M6 24V12m10 12V6m10 18V16M3 27h26"/></svg><strong>Explore a trade</strong><p>Select any tile to inspect its entry, close, and result.</p></div>}</aside>
        </div>
      </>:<div className="empty-position"><h3>No closed trades yet</h3><p>Each completed trade will appear here as a profit or loss tile.</p></div>}
    </div>}
  </>;
}

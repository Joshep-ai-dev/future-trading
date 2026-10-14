import {useState,type ReactNode} from 'react';
import {fmt} from './types';

export type PnlTrade={id:number;direction:number;pnl:number;entry:number;exit:number;quantity:number;exitTime:number};
const money=(value:number)=>`${value>0?'+':value<0?'-':''}$${fmt(Math.abs(value))}`;
const tone=(value:number)=>value>0?'profit':value<0?'loss':'flat';

export default function TradeView({trades,capital,unrealized=0,scope,children,onSelect}:{
  trades:PnlTrade[];capital:number;unrealized?:number;scope:'Session'|'Backtest';children:ReactNode;onSelect?:(id:number)=>void;
}){
  const storageKey=`silver.trades.view.${scope}`;
  const [view,setView]=useState<'table'|'grid'>(()=>{try{return localStorage.getItem(storageKey)==='grid'?'grid':'table';}catch{return 'table';}});
  const [page,setPage]=useState(0),[selectedId,setSelectedId]=useState<number|null>(null);
  const realized=trades.reduce((sum,t)=>sum+t.pnl,0),wins=trades.filter(t=>t.pnl>0).length;
  const losses=trades.filter(t=>t.pnl<0).length,flat=trades.length-wins-losses;
  const total=realized+unrealized,returnPct=capital>0?realized/capital*100:null;
  const pages=Math.max(1,Math.ceil(trades.length/40)),currentPage=Math.min(page,pages-1);
  const recent=[...trades].reverse().slice(currentPage*40,(currentPage+1)*40);
  const selected=trades.find(t=>t.id===selectedId);
  function changeView(next:'table'|'grid'){setView(next);try{localStorage.setItem(storageKey,next);}catch{/* Storage can be unavailable. */}}
  return <>
    <div className="trade-view-bar"><span>Display</span><div role="group" aria-label={`${scope} trade display`}>
      <button type="button" aria-pressed={view==='table'} onClick={()=>changeView('table')}>Table</button>
      <button type="button" aria-pressed={view==='grid'} onClick={()=>changeView('grid')}>P&amp;L grid</button>
    </div></div>
    {view==='table'?children:<div className="pnl-card">
      <div className="pnl-card-summary">
        <div><h3>{scope} realized P&amp;L <small>USDT</small></h3><div className={`pnl-card-return ${tone(realized)}`}><strong>{returnPct===null?'—':`${returnPct>0?'+':''}${fmt(returnPct)}%`}</strong><span>{money(realized)}</span></div><small>Return on starting balance</small></div>
        <div className="pnl-card-win"><h3>Win rate</h3><strong>{trades.length?`${fmt(wins/trades.length*100)}%`:'—'}</strong><small>{wins} / {trades.length} closed trades</small></div>
      </div>
      <dl className="pnl-card-totals"><div><dt>Total P&amp;L</dt><dd className={tone(total)}>{money(total)}</dd></div><div><dt>Unrealized P&amp;L</dt><dd className={tone(unrealized)}>{money(unrealized)}</dd></div></dl>
      <div className="pnl-grid-heading"><h3>Closed trades <span className="count-tag">{trades.length}</span></h3><span>One tile per trade · newest first</span></div>
      <div className="pnl-grid-key"><span className="profit">{wins} wins</span><span className="loss">{losses} losses</span><span>{flat} breakeven</span></div>
      {trades.length?<>
        <div className="pnl-trade-grid">{recent.map(t=><button key={t.id} type="button" className={`pnl-trade-tile ${tone(t.pnl)}`} aria-pressed={selectedId===t.id} aria-label={`Trade ${t.id}, ${t.direction===1?'long':'short'}, P&L ${money(t.pnl)}`} onClick={()=>{setSelectedId(t.id);onSelect?.(t.id);}}><span>#{t.id} · {t.direction===1?'Long':'Short'}</span><strong>{money(t.pnl)}</strong></button>)}</div>
        {pages>1&&<div className="pagination"><button type="button" className="secondary" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>Previous</button><span>{currentPage+1} / {pages}</span><button type="button" className="secondary" disabled={currentPage+1===pages} onClick={()=>setPage(currentPage+1)}>Next</button></div>}
        {selected?<div className="pnl-trade-detail" aria-live="polite"><strong>Trade #{selected.id} · {selected.direction===1?'Long':'Short'}</strong><dl><div><dt>Entry → Close</dt><dd>{fmt(selected.entry,3)} → {fmt(selected.exit,3)}</dd></div><div><dt>Quantity</dt><dd>{fmt(selected.quantity,4)}</dd></div><div><dt>Closed (UTC)</dt><dd>{new Date(selected.exitTime*1000).toISOString().replace('T',' ').slice(0,19)}</dd></div><div><dt>Realized P&amp;L</dt><dd className={tone(selected.pnl)}>{money(selected.pnl)}</dd></div></dl></div>:<p className="pnl-grid-hint">Select a trade to see its fill prices and result.</p>}
      </>:<div className="empty-position"><h3>No closed trades yet</h3><p>Each completed trade will appear here as a profit or loss tile.</p></div>}
    </div>}
  </>;
}

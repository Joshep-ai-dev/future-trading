import {useCallback,useEffect,useState} from 'react';
import {api} from '../../shared/api/api';
import {fmt} from '../../shared/types/types';

export type SavedRun={id:number;name:string|null;timeframe:string;start:number;end:number;createdAt:string|null;summary:{netPnl:number;returnPct:number;winRate:number;trades:number;maxDrawdownPct:number}};
const day=(t:number)=>new Date(t*1000).toISOString().slice(0,10);
const when=(iso:string|null)=>iso?new Date(iso).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'—';

/** The signed-in user's saved backtest runs, newest first. */
export default function SavedRuns({activeId,refreshKey,onOpen,compact=false}:{activeId?:number|null;refreshKey?:unknown;onOpen:(id:number)=>void;compact?:boolean}){
  const [runs,setRuns]=useState<SavedRun[]|null>(null),[error,setError]=useState(''),[editing,setEditing]=useState<number|null>(null),[draft,setDraft]=useState('');
  const load=useCallback(async()=>{try{setRuns(await api<SavedRun[]>('/api/backtests'));setError('');}catch(reason){setError(String(reason));}},[]);
  useEffect(()=>{void load();},[load,refreshKey]);
  async function rename(id:number){
    setEditing(null);
    try{await api(`/api/backtests/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:draft})});await load();}catch(reason){setError(String(reason));}
  }
  async function remove(run:SavedRun){
    if(!window.confirm(`Delete the saved backtest "${run.name??`#${run.id}`}"?`))return;
    try{await api(`/api/backtests/${run.id}`,{method:'DELETE'});await load();}catch(reason){setError(String(reason));}
  }
  if(error)return <p className="error" role="alert">{error}</p>;
  if(!runs)return <p className="saved-runs-empty">Loading saved backtests…</p>;
  if(!runs.length)return <p className="saved-runs-empty">No saved backtests yet. Every run is saved here automatically.</p>;
  const shown=compact?runs.slice(0,5):runs;
  return <div className="saved-runs"><table><thead><tr><th>Run</th><th>Saved</th><th>Period (UTC)</th><th>TF</th><th>Net P&amp;L</th><th>Win rate</th><th>Max DD</th><th>Trades</th><th/></tr></thead><tbody>
    {shown.map(run=><tr key={run.id} className={run.id===activeId?'selected-row':''}>
      <td>{editing===run.id?<input autoFocus aria-label="Run name" value={draft} maxLength={80} onChange={event=>setDraft(event.target.value)} onBlur={()=>void rename(run.id)} onKeyDown={event=>{if(event.key==='Enter')void rename(run.id);if(event.key==='Escape')setEditing(null);}}/>:<button type="button" className="saved-run-name" title="Rename" onClick={()=>{setEditing(run.id);setDraft(run.name??'');}}>{run.name??`Run #${run.id}`}</button>}</td>
      <td>{when(run.createdAt)}</td><td>{day(run.start)} → {day(run.end-1)}</td><td>{run.timeframe}</td>
      <td className={run.summary.netPnl>=0?'positive':'negative'}>{run.summary.netPnl>=0?'+':'-'}${fmt(Math.abs(run.summary.netPnl))} <small>{fmt(run.summary.returnPct)}%</small></td>
      <td>{fmt(run.summary.winRate)}%</td><td className="negative">{fmt(Math.abs(run.summary.maxDrawdownPct))}%</td><td>{run.summary.trades}</td>
      <td className="saved-run-actions"><div>{run.id===activeId?<span className="saved-run-viewing">Viewing</span>:<button type="button" className="secondary" onClick={()=>onOpen(run.id)}>Open</button>}<button type="button" className="tv-icon" aria-label={`Delete run ${run.id}`} title="Delete" onClick={()=>void remove(run)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5h12M8 3h4M6 5l1 12h6l1-12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg></button></div></td>
    </tr>)}
  </tbody></table>{compact&&runs.length>5&&<p className="saved-runs-more">{runs.length-5} more in the results page</p>}</div>;
}

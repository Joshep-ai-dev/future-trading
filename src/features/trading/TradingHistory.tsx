import {Fragment,useEffect,useState} from 'react';
import {api} from '../../shared/api/api';
import {EmptyState,StatusBadge,TableFrame} from '../../shared/ui/ui';
import {fmt} from '../../shared/types/types';

type PastSession={id:number;startedAt:number;mode:'live'|'replay';timeframe:string;capital:number;equity:number|null;trades:number;wins:number;netPnl:number;archivedAt:string|null;completed:boolean;halted:boolean};
type PastTrade={id:number;direction:number;entryTime:number;exitTime:number;entryPrice:number;exitPrice:number;quantity:number;pnl:number;exitReason:string};
type BotEvent={id:number;venue:string;kind:string;detail:Record<string,unknown>;createdAt:string|null};
const time=(t:number)=>new Date(t*1000).toISOString().slice(0,16).replace('T',' ');
const signed=(v:number)=>`${v>=0?'+':'-'}$${fmt(Math.abs(v))}`;

/** Archived paper sessions of the signed-in user, with their trades on demand. */
export function PaperSessionHistory({refreshKey}:{refreshKey?:unknown}){
  const [sessions,setSessions]=useState<PastSession[]|null>(null),[open,setOpen]=useState<number|null>(null),[trades,setTrades]=useState<PastTrade[]>([]),[error,setError]=useState('');
  useEffect(()=>{api<PastSession[]>('/api/paper/history').then(setSessions).catch(reason=>setError(String(reason)));},[refreshKey]);
  async function toggle(session:PastSession){
    if(open===session.startedAt){setOpen(null);return;}
    setOpen(session.startedAt);setTrades([]);
    try{setTrades(await api<PastTrade[]>(`/api/paper/history/${session.startedAt}/trades`));}catch(reason){setError(String(reason));}
  }
  if(error)return <p className="exchange-inline-error">{error}</p>;
  if(!sessions)return <EmptyState compact title="Loading past sessions"/>;
  if(!sessions.length)return <EmptyState compact title="No past sessions" description="Starting a new virtual session archives the current one here."/>;
  return <TableFrame label="Past paper sessions" columns={['Started (UTC)','Mode','Timeframe','Start balance','End equity','Net P&L','Trades','Win rate','']}>
    {sessions.map(session=><Fragment key={session.id}>
      <tr className={open===session.startedAt?'selected-row':''}>
        <td>{time(session.startedAt)}</td><td><StatusBadge>{session.mode==='replay'?'Replay':'Live'}</StatusBadge></td><td>{session.timeframe}</td>
        <td>${fmt(session.capital)}</td><td>{session.equity==null?'—':`$${fmt(session.equity)}`}</td>
        <td className={session.netPnl>=0?'positive':'negative'}>{signed(session.netPnl)}</td><td>{session.trades}</td>
        <td>{session.trades?`${fmt(session.wins/session.trades*100)}%`:'—'}</td>
        <td><button type="button" className="secondary history-toggle" onClick={()=>void toggle(session)}>{open===session.startedAt?'Hide trades':'Trades'}</button></td>
      </tr>
      {open===session.startedAt&&<tr className="history-detail"><td colSpan={9}>{trades.length?<table><thead><tr><th>#</th><th>Side</th><th>Entry (UTC)</th><th>Exit (UTC)</th><th>Entry</th><th>Exit</th><th>Size</th><th>P&amp;L</th><th>Reason</th></tr></thead><tbody>{trades.map(trade=><tr key={trade.id}><td>{trade.id}</td><td><span className={`side-badge ${trade.direction===1?'long':'short'}`}>{trade.direction===1?'LONG':'SHORT'}</span></td><td>{time(trade.entryTime)}</td><td>{time(trade.exitTime)}</td><td>{fmt(trade.entryPrice,3)}</td><td>{fmt(trade.exitPrice,3)}</td><td>{fmt(trade.quantity,4)}</td><td className={trade.pnl>=0?'positive':'negative'}>{signed(trade.pnl)}</td><td>{trade.exitReason.replaceAll('_',' ')}</td></tr>)}</tbody></table>:<p className="muted">No closed trades in this session.</p>}</td></tr>}
    </Fragment>)}
  </TableFrame>;
}

const eventLabel:Record<string,string>={start:'Strategy started',stop:'Strategy stopped',open:'Position opened',close:'Position closed',trail:'Stop trailed',error:'Paused on error'};

/** Live bot actions recorded for the signed-in user. */
export function BotEventLog(){
  const [events,setEvents]=useState<BotEvent[]|null>(null),[error,setError]=useState('');
  useEffect(()=>{
    let active=true;
    const load=()=>api<BotEvent[]>('/api/exchange/bot-events').then(value=>{if(active)setEvents(value);}).catch(reason=>{if(active)setError(String(reason));});
    void load();const timer=setInterval(()=>void load(),10000);
    return()=>{active=false;clearInterval(timer);};
  },[]);
  if(error)return <p className="exchange-inline-error">{error}</p>;
  if(!events)return <EmptyState compact title="Loading bot log"/>;
  if(!events.length)return <EmptyState compact title="No bot activity yet" description="Starts, entries, exits, stop moves and errors of your live strategy are recorded here."/>;
  return <TableFrame label="Live bot log" columns={['Time','Exchange','Event','Details']}>
    {events.map(event=><tr key={event.id}><td>{event.createdAt?new Date(event.createdAt).toLocaleString():'—'}</td><td>{event.venue.toUpperCase()}</td>
      <td><StatusBadge tone={event.kind==='error'?'negative':event.kind==='open'?'positive':event.kind==='close'?'warning':'neutral'}>{eventLabel[event.kind]??event.kind}</StatusBadge></td>
      <td className="event-detail">{Object.entries(event.detail).map(([key,value])=><span key={key}>{key} <b>{typeof value==='number'?fmt(value,4):String(value)}</b></span>)}</td></tr>)}
  </TableFrame>;
}

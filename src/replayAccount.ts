import type {PaperTrade,Position} from './PaperTrading';

/** Display only: account state at the animated candle clock, never strategy input. */
export function accountAt(trades:PaperTrade[],position:Position|null|Position[],capital:number,clock:number,duration:number,price:number|null,stops:{time:number;price:number|null}[]){
  const closed=trades.filter(t=>t.exit_time+duration<=clock);
  const pending=trades.filter(t=>t.entry_time+duration<=clock&&t.exit_time+duration>clock);
  const current=Array.isArray(position)?position:position?[position]:[];
  const candidates=[...current.filter(p=>p.entry_time+duration<=clock),...pending];
  const opens=candidates.map(candidate=>{
    const history=candidate.stop_history?.filter(h=>h.time+duration<=clock);
    const knownStop=candidates.length===1?stops.filter(row=>row.time+duration<=clock).at(-1)?.price:null;
    return {...candidate,stop_history:history,trailing_active:history?history.some(h=>h.reason!=='initial'):candidate.trailing_active,stop:history?.at(-1)?.price??knownStop??candidate.initial_stop??candidate.stop};
  });
  const open=opens.length===1?opens[0]:null;
  const balance=capital+closed.reduce((sum,t)=>sum+t.pnl,0);
  const equity=balance+(price!==null?opens.reduce((sum,p)=>sum+(price-p.entry_price)*p.direction*p.quantity,0):0);
  return {closed,open,opens,balance,equity};
}

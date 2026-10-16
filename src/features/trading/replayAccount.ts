import type {PaperTrade,Position} from './PaperTrading';

/** Display only: account state at the animated candle clock, never strategy input. */
export function accountAt(trades:PaperTrade[],position:Position|null,capital:number,clock:number,duration:number,price:number|null,stops:{time:number;price:number|null}[]){
  const closed=trades.filter(t=>t.exit_time+duration<=clock);
  const pending=trades.find(t=>t.entry_time+duration<=clock&&t.exit_time+duration>clock);
  const candidate=position&&position.entry_time+duration<=clock?position:pending??null;
  const knownStop=stops.filter(row=>row.time+duration<=clock).at(-1)?.price;
  const history=candidate?.stop_history?.filter(h=>h.time+duration<=clock);
  const open=candidate?{...candidate,stop_history:history,trailing_active:history?history.some(h=>h.reason!=='initial'):candidate.trailing_active,stop:knownStop??candidate.initial_stop??candidate.stop}:null;
  const balance=capital+closed.reduce((sum,t)=>sum+t.pnl,0);
  const equity=balance+(open&&price!==null?(price-open.entry_price)*open.direction*open.quantity:0);
  return {closed,open,balance,equity};
}

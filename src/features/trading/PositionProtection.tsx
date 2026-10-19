import {useEffect,useState} from 'react';
import {api} from '../../shared/api/api';
import type {ExchangeVenue} from '../../shared/api/exchangeVenue';
import {liveNumber as number} from '../../shared/api/useExchangeStream';
import {Button} from '../../shared/ui/ui';

type Protection={stop:number|null;takeProfit:number|null};

/** Edit or remove the stop loss and take profit of the open position. */
export default function PositionProtection({venue,side,price,disabled,onRun}:{
  venue:ExchangeVenue;side:'long'|'short';price:number|null|undefined;disabled:boolean;
  onRun:(path:string,body:unknown)=>Promise<boolean>;
}){
  const [current,setCurrent]=useState<Protection|null>(null);
  const [stop,setStop]=useState(''),[takeProfit,setTakeProfit]=useState('');
  const [revision,setRevision]=useState(0);
  useEffect(()=>{
    let live=true;
    api<Protection>(`/api/exchange/protection?venue=${venue}`).then(value=>{
      if(!live)return;
      setCurrent(value);setStop(value.stop!=null?String(value.stop):'');setTakeProfit(value.takeProfit!=null?String(value.takeProfit):'');
    }).catch(()=>live&&setCurrent(null));
    return ()=>{live=false;};
  },[venue,side,revision]);

  const stopValue=stop.trim()?Number(stop):null,takeProfitValue=takeProfit.trim()?Number(takeProfit):null;
  const invalid=[stopValue,takeProfitValue].some(value=>value!=null&&!(Number.isFinite(value)&&value>0));
  const stopWrong=stopValue!=null&&price!=null&&(side==='long'?stopValue>=price:stopValue<=price);
  const takeProfitWrong=takeProfitValue!=null&&price!=null&&(side==='long'?takeProfitValue<=price:takeProfitValue>=price);
  const unchanged=current!=null&&stopValue===current.stop&&takeProfitValue===current.takeProfit;

  async function save(nextStop:number|null,nextTakeProfit:number|null){
    const summary=`Stop loss: ${nextStop??'none'} · Take profit: ${nextTakeProfit??'none'}`;
    if(!window.confirm(`Replace the TP/SL orders of this ${side} position at the exchange?\n${summary}`))return;
    await onRun('/api/exchange/protection',{venue,stop_price:nextStop,take_profit_price:nextTakeProfit,confirmation:'UPDATE LIVE TPSL'});
    setRevision(value=>value+1);
  }

  return <fieldset className="ticket-tpsl position-protection"><legend>Position TP / SL</legend>
    <p className="ticket-help">Current: stop loss <b>{number(current?.stop,3)}</b> · take profit <b>{number(current?.takeProfit,3)}</b>. Leave a field empty to remove that order.</p>
    <label className="ui-field ticket-stop"><span>Stop loss price <small>{side==='long'?'below':'above'} {number(price,3)}</small></span><input type="number" aria-label="New stop loss price" min="0" step="any" placeholder="No stop loss" value={stop} disabled={disabled} onChange={event=>setStop(event.target.value)}/></label>
    <label className="ui-field ticket-stop"><span>Take profit price <small>{side==='long'?'above':'below'} {number(price,3)}</small></span><input type="number" aria-label="New take profit price" min="0" step="any" placeholder="No take profit" value={takeProfit} disabled={disabled} onChange={event=>setTakeProfit(event.target.value)}/></label>
    {stopWrong&&<p className="ticket-warning">The stop loss must be {side==='long'?'below':'above'} the current price.</p>}
    {takeProfitWrong&&<p className="ticket-warning">The take profit must be {side==='long'?'above':'below'} the current price.</p>}
    {stopValue==null&&<p className="ticket-warning">Without a stop loss, losses are not limited.</p>}
    <div className="ticket-submit-row">
      <Button disabled={disabled||invalid||stopWrong||takeProfitWrong||unchanged} onClick={()=>void save(stopValue,takeProfitValue)}>Update TP/SL</Button>
      <Button variant="danger" disabled={disabled||(current?.stop==null&&current?.takeProfit==null)} onClick={()=>void save(null,null)}>Cancel both</Button>
    </div>
  </fieldset>;
}

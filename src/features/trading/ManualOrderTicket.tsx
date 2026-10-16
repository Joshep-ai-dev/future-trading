import {useState} from 'react';
import type {ExchangeVenue} from '../../shared/api/exchangeVenue';
import {liveNumber as number,useExchangeStream} from '../../shared/api/useExchangeStream';
import {Button,StatusBadge} from '../../shared/ui/ui';
import {estimateOrderSize} from './orderSizing';

type Props={venue:ExchangeVenue;connected:boolean;busy:boolean;blocked:boolean;botRunning:boolean;leverage:string;onLeverageChange:(value:string)=>void;onRun:(path:string,body:unknown)=>Promise<boolean>};
const leverageOptions=[...Array.from({length:20},(_,index)=>index+1),...Array.from({length:16},(_,index)=>(index+5)*5)];

export default function ManualOrderTicket({venue,connected,busy,blocked,botRunning,leverage,onLeverageChange,onRun}:Props){
  const {data,connected:streamConnected}=useExchangeStream(venue);
  const [action,setAction]=useState<'open'|'close'>('open');
  const [size,setSize]=useState('');
  const [unit,setUnit]=useState<'XAG'|'USDT'>('USDT');
  const [stop,setStop]=useState('');
  const [takeProfit,setTakeProfit]=useState('');
  const [confirmed,setConfirmed]=useState(false);
  const price=data?.market?.last;
  const {quantity,margin}=estimateOrderSize(size,unit,price,Number(leverage));
  const position=data?.positions?.length===1?data.positions[0]:null;
  const positionOpen=(data?.positions?.length??0)>0;
  const accountVerified=streamConnected&&data?.positions!=null&&!data.errors.positions&&!data.errors.connection;
  const disabled=!connected||busy||blocked||botRunning||!accountVerified;
  const validPrice=price!=null&&Number.isFinite(price)&&price>0;
  const openDisabled=disabled||positionOpen||!confirmed||quantity==null||!Number.isFinite(Number(stop))||Number(stop)<=0||!validPrice||data?.streams.market!=='live';

  async function open(direction:'long'|'short'){
    if(openDisabled||(direction==='long'?Number(stop)>=price!:Number(stop)<=price!))return;
    const ok=await onRun('/api/exchange/order',{venue,direction,quantity,stop_price:Number(stop),take_profit_price:takeProfit?Number(takeProfit):null,leverage:Number(leverage),confirmation:'PLACE LIVE ORDER'});
    if(ok){setConfirmed(false);setSize('');}
  }
  async function close(){
    if(!position||!window.confirm(`Close the entire ${position.side} XAG/USDT position with a reduce-only market order?`))return;
    await onRun('/api/exchange/close',{venue,confirmation:'CLOSE LIVE POSITION'});
  }

  return <div className="order-ticket" id="manual-ticket-panel" role="tabpanel" aria-labelledby="execution-tab-manual">
    <div className="ticket-segment" role="group" aria-label="Order action">{(['open','close'] as const).map(value=><button key={value} type="button" aria-pressed={action===value} onClick={()=>{setAction(value);setConfirmed(false);}}>{value==='open'?'Open':'Close'}</button>)}</div>
    {action==='open'?<>
      <div className="ticket-mode-row"><StatusBadge>Isolated margin</StatusBadge><label><span className="sr-only">Order leverage</span><select aria-label="Order leverage" value={leverage} disabled={disabled} onChange={event=>onLeverageChange(event.target.value)}>{leverageOptions.map(value=><option key={value} value={value}>{value}x</option>)}</select></label></div>
      <div className="ticket-order-type"><strong>Market</strong><span>Immediate execution</span></div>
      <div className="ticket-available"><span>Available margin</span><strong>{number(data?.balance?.free,4)} <small>USDT</small></strong></div>
      <div className="ticket-market-price"><span>Market price</span><strong>{number(price,3)} <small>USDT</small></strong></div>
      <label className="ticket-size"><span>Position size</span><div><input aria-label="Position size" type="number" min="0" step="any" placeholder="Enter amount" value={size} disabled={disabled||positionOpen} onChange={event=>setSize(event.target.value)}/><select aria-label="Position size unit" value={unit} onChange={event=>{setUnit(event.target.value as 'XAG'|'USDT');setSize('');setConfirmed(false);}}><option value="USDT">USDT</option><option value="XAG">XAG</option></select></div></label>
      <fieldset className="ticket-tpsl"><legend>TP / SL</legend><label className="ui-field ticket-stop"><span>Stop loss <small>Required · USDT</small></span><input type="number" aria-label="Stop loss price" min="0" step="any" placeholder="Stop loss price" value={stop} disabled={disabled||positionOpen} onChange={event=>setStop(event.target.value)}/></label><label className="ui-field ticket-stop"><span>Take profit <small>Optional · USDT</small></span><input type="number" aria-label="Take profit price" min="0" step="any" placeholder="Take profit price" value={takeProfit} disabled={disabled||positionOpen} onChange={event=>setTakeProfit(event.target.value)}/></label></fieldset>
      <div className="ticket-estimates"><div><span>Estimated size</span><b>{number(quantity)} XAG</b></div><div><span>Estimated margin</span><b>{number(margin,4)} USDT</b></div></div>
      <label className="ticket-confirm"><input type="checkbox" checked={confirmed} disabled={disabled||positionOpen} onChange={event=>setConfirmed(event.target.checked)}/><span>I confirm this places a real market order.</span></label>
      <div className="ticket-submit-row"><Button className="ticket-buy" disabled={openDisabled||Number(stop)>=price!} onClick={()=>void open('long')}>{busy?'Submitting...':'Open Long'}</Button><Button className="ticket-sell" disabled={openDisabled||Number(stop)<=price!} onClick={()=>void open('short')}>{busy?'Submitting...':'Open Short'}</Button></div>
      {positionOpen&&<p className="ticket-help">An XAG position is already open. Select Close to manage it.</p>}
    </>:<div className="ticket-close-panel">
      <div className="ticket-order-type"><strong>Market close</strong><StatusBadge>Reduce only</StatusBadge></div>
      {position?<><div className="ticket-position"><StatusBadge tone={position.side==='long'?'positive':'negative'}>{position.side.toUpperCase()}</StatusBadge><strong>{number(position.quantity)} XAG</strong></div><dl><div><dt>Entry price</dt><dd>{number(position.entryPrice,3)}</dd></div><div><dt>Mark price</dt><dd>{number(position.markPrice,3)}</dd></div><div><dt>Unrealized PnL</dt><dd className={(position.unrealizedPnl??0)<0?'negative':'positive'}>{number(position.unrealizedPnl,4)} USDT</dd></div></dl><Button variant="danger" disabled={disabled} onClick={()=>void close()}>Close entire {position.side} position</Button></>:<p className="ticket-help">{!accountVerified?'Waiting for verified position data.':positionOpen?'Multiple positions detected. Manage them on the exchange.':'No open XAG position to close.'}</p>}
    </div>}
    {botRunning&&<p className="ticket-help">Stop the running strategy to enable manual orders.</p>}
  </div>;
}

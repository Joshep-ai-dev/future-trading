import {useState} from 'react';
import type {ExchangeVenue} from '../../shared/api/exchangeVenue';
import {liveNumber as number,useExchangeStream} from '../../shared/api/useExchangeStream';
import {Button,StatusBadge} from '../../shared/ui/ui';
import {estimateOrderSize} from './orderSizing';
import PositionProtection from './PositionProtection';

type Props={venue:ExchangeVenue;connected:boolean;busy:boolean;blocked:boolean;botRunning:boolean;leverage:string;onLeverageChange:(value:string)=>void;onRun:(path:string,body:unknown)=>Promise<boolean>};
const leverageOptions=[...Array.from({length:20},(_,index)=>index+1),...Array.from({length:16},(_,index)=>(index+5)*5)];

export default function ManualOrderTicket({venue,connected,busy,blocked,botRunning,leverage,onLeverageChange,onRun}:Props){
  const {data,connected:streamConnected}=useExchangeStream(venue);
  const [action,setAction]=useState<'open'|'close'>('open');
  const [size,setSize]=useState('');
  const [unit,setUnit]=useState<'XAG'|'USDT'>('USDT');
  const [stop,setStop]=useState('');
  const [takeProfit,setTakeProfit]=useState('');
  const [useStop,setUseStop]=useState(true),[useTakeProfit,setUseTakeProfit]=useState(false);
  const [confirmed,setConfirmed]=useState(false);
  const [editingProtection,setEditingProtection]=useState(false);
  const price=data?.market?.last;
  const {quantity,notional,margin}=estimateOrderSize(size,unit,price,Number(leverage));
  const position=data?.positions?.length===1?data.positions[0]:null;
  const positionOpen=(data?.positions?.length??0)>0;
  const accountVerified=streamConnected&&data?.positions!=null&&!data.errors.positions&&!data.errors.connection;
  const disabled=!connected||busy||blocked||botRunning||!accountVerified;
  const validPrice=price!=null&&Number.isFinite(price)&&price>0;
  const stopValid=!useStop||(Number.isFinite(Number(stop))&&Number(stop)>0);
  const takeProfitValid=!useTakeProfit||(Number.isFinite(Number(takeProfit))&&Number(takeProfit)>0);
  const openDisabled=disabled||positionOpen||!confirmed||quantity==null||!stopValid||!takeProfitValid||!validPrice||data?.streams.market!=='live';
  // Why Open Long/Short are unavailable, first reason that applies.
  const openBlockReason=!connected?'Connect the exchange account first.'
    :botRunning?'The automated bot is running; stop it to trade manually.'
    :blocked?'Live trading is blocked for this account.'
    :!accountVerified?'Waiting for verified account and position data from the exchange.'
    :positionOpen?null
    :data?.streams.market!=='live'?'No live price from the exchange: the market may be closed or the price feed is reconnecting.'
    :!validPrice?'No current market price yet.'
    :quantity==null?'Enter the order size.'
    :!stopValid?'Enter a stop loss price or turn Stop loss off.'
    :!takeProfitValid?'Enter a take profit price or turn Take profit off.'
    :!confirmed?'Tick the confirmation box to enable the order buttons.'
    :null;
  const stopWrongSide=(direction:'long'|'short')=>useStop&&(direction==='long'?Number(stop)>=price!:Number(stop)<=price!);
  const takeProfitWrongSide=(direction:'long'|'short')=>useTakeProfit&&(direction==='long'?Number(takeProfit)<=price!:Number(takeProfit)>=price!);

  async function open(direction:'long'|'short'){
    if(openDisabled||stopWrongSide(direction)||takeProfitWrongSide(direction))return;
    const ok=await onRun('/api/exchange/order',{venue,direction,quantity,stop_price:useStop?Number(stop):null,take_profit_price:useTakeProfit?Number(takeProfit):null,leverage:Number(leverage),confirmation:'PLACE LIVE ORDER'});
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
      <label className="ticket-size"><span>{unit==='USDT'?'Margin':'Position size'}</span><div><input aria-label="Position size" type="number" min="0" step="any" placeholder="Enter amount" value={size} disabled={disabled||positionOpen} onChange={event=>setSize(event.target.value)}/><select aria-label="Position size unit" value={unit} onChange={event=>{setUnit(event.target.value as 'XAG'|'USDT');setSize('');setConfirmed(false);}}><option value="USDT">USDT</option><option value="XAG">XAG</option></select></div></label>
      <fieldset className="ticket-tpsl"><legend>TP / SL</legend>
        <label className="ticket-option"><input type="checkbox" checked={useStop} disabled={disabled||positionOpen} onChange={event=>{setUseStop(event.target.checked);setConfirmed(false);}}/><span>Stop loss</span><small>Reduce-only trigger at the exchange</small></label>
        {useStop&&<label className="ui-field ticket-stop"><span>Stop loss price <small>USDT</small></span><input type="number" aria-label="Stop loss price" min="0" step="any" placeholder={price?`Long: below ${price} · Short: above`:'Stop loss price'} value={stop} disabled={disabled||positionOpen} onChange={event=>setStop(event.target.value)}/></label>}
        <label className="ticket-option"><input type="checkbox" checked={useTakeProfit} disabled={disabled||positionOpen} onChange={event=>{setUseTakeProfit(event.target.checked);setConfirmed(false);}}/><span>Take profit</span><small>Closes the whole position at the target</small></label>
        {useTakeProfit&&<label className="ui-field ticket-stop"><span>Take profit price <small>USDT</small></span><input type="number" aria-label="Take profit price" min="0" step="any" placeholder="Take profit price" value={takeProfit} disabled={disabled||positionOpen} onChange={event=>setTakeProfit(event.target.value)}/></label>}
        {!useStop&&<p className="ticket-warning">No stop loss: losses are not limited. Leveraged positions can be liquidated.</p>}
      </fieldset>
      <div className="ticket-estimates"><div><span>Estimated size</span><b>{number(quantity)} XAG</b></div><div><span>Position value</span><b>{number(notional,2)} USDT</b></div><div><span>Estimated margin</span><b>{number(margin,4)} USDT</b></div></div>
      <label className="ticket-confirm"><input type="checkbox" checked={confirmed} disabled={disabled||positionOpen} onChange={event=>setConfirmed(event.target.checked)}/><span>I confirm this places a real market order.</span></label>
      <div className="ticket-submit-row"><Button className="ticket-buy" disabled={openDisabled||stopWrongSide('long')||takeProfitWrongSide('long')} onClick={()=>void open('long')}>{busy?'Submitting...':'Open Long'}</Button><Button className="ticket-sell" disabled={openDisabled||stopWrongSide('short')||takeProfitWrongSide('short')} onClick={()=>void open('short')}>{busy?'Submitting...':'Open Short'}</Button></div>
      {positionOpen&&<p className="ticket-help">An XAG position is already open. Select Close to manage it.</p>}
      {!busy&&openBlockReason&&<p className="ticket-help">{openBlockReason}</p>}
    </>:<div className="ticket-close-panel">
      <div className="ticket-order-type"><strong>Market close</strong><StatusBadge>Reduce only</StatusBadge></div>
      {position?<><div className="ticket-position"><StatusBadge tone={position.side==='long'?'positive':'negative'}>{position.side.toUpperCase()}</StatusBadge><strong>{number(position.quantity)} XAG</strong></div><dl><div><dt>Entry price</dt><dd>{number(position.entryPrice,3)}</dd></div><div><dt>Mark price</dt><dd>{number(position.markPrice,3)}</dd></div><div><dt>Unrealized PnL</dt><dd className={(position.unrealizedPnl??0)<0?'negative':'positive'}>{number(position.unrealizedPnl,4)} USDT</dd></div></dl><Button variant="danger" disabled={disabled} onClick={()=>void close()}>Close entire {position.side} position</Button>{(position.side==='long'||position.side==='short')&&<><Button variant="secondary" disabled={disabled} onClick={()=>setEditingProtection(true)}>Edit TP/SL</Button>{editingProtection&&<PositionProtection venue={venue} side={position.side} quantity={position.quantity} entryPrice={position.entryPrice} price={position.markPrice??price} disabled={disabled} onRun={onRun} onClose={()=>setEditingProtection(false)}/>}</>}</>:<p className="ticket-help">{!accountVerified?'Waiting for verified position data.':positionOpen?'Multiple positions detected. Manage them on the exchange.':'No open XAG position to close.'}</p>}
    </div>}
    {botRunning&&<p className="ticket-help">Stop the running strategy to enable manual orders.</p>}
  </div>;
}

import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {api} from '../../shared/api/api';
import type {ExchangeVenue} from '../../shared/api/exchangeVenue';
import {liveNumber as number} from '../../shared/api/useExchangeStream';
import {Button,StatusBadge} from '../../shared/ui/ui';

type Protection={stop:number|null;takeProfit:number|null};
type Props={venue:ExchangeVenue;asset?:string;side:'long'|'short';quantity?:number|null;entryPrice?:number|null;price:number|null|undefined;
  disabled:boolean;onRun:(path:string,body:unknown)=>Promise<boolean>;onClose:()=>void};

/** Modal to set, change or remove the stop loss and take profit of the open position. */
export default function PositionProtection({venue,asset='XAG',side,quantity,entryPrice,price,disabled,onRun,onClose}:Props){
  const dialog=useRef<HTMLDialogElement>(null);
  const [current,setCurrent]=useState<Protection|null>(null);
  const [loadError,setLoadError]=useState('');
  const [stop,setStop]=useState(''),[takeProfit,setTakeProfit]=useState('');
  const [saving,setSaving]=useState(false);
  const priceDigits=asset==='STABLE'?5:3;

  useEffect(()=>{const element=dialog.current,previous=document.activeElement as HTMLElement|null;element?.showModal();return ()=>{element?.close();previous?.focus();};},[]);
  useEffect(()=>{
    let live=true;
    api<Protection>(`/api/exchange/protection?venue=${venue}&side=${side}`).then(value=>{
      if(!live)return;
      setCurrent(value);setStop(value.stop!=null?String(value.stop):'');setTakeProfit(value.takeProfit!=null?String(value.takeProfit):'');
    }).catch(reason=>live&&setLoadError(String(reason)));
    return ()=>{live=false;};
  },[venue,side]);

  const parse=(text:string)=>text.trim()?Number(text):null;
  const stopValue=parse(stop),takeProfitValue=parse(takeProfit);
  const invalid=[stopValue,takeProfitValue].some(value=>value!=null&&!(Number.isFinite(value)&&value>0));
  const long=side==='long';
  const stopWrong=stopValue!=null&&price!=null&&(long?stopValue>=price:stopValue<=price);
  const takeProfitWrong=takeProfitValue!=null&&price!=null&&(long?takeProfitValue<=price:takeProfitValue>=price);
  const unchanged=current!=null&&stopValue===current.stop&&takeProfitValue===current.takeProfit;
  const busy=disabled||saving||current==null;
  const canSave=!(busy||invalid||stopWrong||takeProfitWrong||unchanged);
  // Result at the trigger, from the entry price, for the whole position.
  const outcome=(target:number|null)=>target==null||entryPrice==null||quantity==null?null:(target-entryPrice)*quantity*(long?1:-1);
  const distance=(target:number|null)=>target==null||!price?null:(target-price)/price*100;

  async function save(nextStop:number|null,nextTakeProfit:number|null){
    setSaving(true);
    const ok=await onRun('/api/exchange/protection',{venue,side,stop_price:nextStop,take_profit_price:nextTakeProfit,confirmation:'UPDATE LIVE TPSL'});
    setSaving(false);
    if(ok)onClose();
  }

  function row(label:string,value:string,setValue:(text:string)=>void,currentValue:number|null|undefined,target:number|null,wrong:boolean,rule:string){
    const pnl=outcome(target),gap=distance(target);
    return <div className={`tpsl-row${wrong?' is-invalid':''}`}>
      <div className="tpsl-row-head"><strong>{label}</strong><span>Current <b>{currentValue!=null?number(currentValue,priceDigits):'none'}</b></span></div>
      <div className="tpsl-input">
        <input type="number" min="0" step="any" inputMode="decimal" aria-label={`${label} price`} placeholder="Not set" value={value} disabled={busy} onChange={event=>setValue(event.target.value)}/>
        {value&&<button type="button" className="tpsl-clear" aria-label={`Remove ${label.toLowerCase()}`} disabled={busy} onClick={()=>setValue('')}>×</button>}
        <span>USDT</span>
      </div>
      <div className="tpsl-row-foot">
        {wrong?<span className="negative">Must be {rule} the mark price</span>:<span>{rule} {number(price,priceDigits)}{gap!=null?` · ${gap>=0?'+':''}${gap.toFixed(2)}%`:''}</span>}
        {pnl!=null&&!wrong&&<span className={pnl<0?'negative':'positive'}>≈ {pnl>=0?'+':''}{pnl.toFixed(2)} USDT</span>}
      </div>
    </div>;
  }

  return createPortal(<dialog ref={dialog} className="tpsl-modal" aria-labelledby="tpsl-title" onCancel={event=>{event.preventDefault();onClose();}}
    onClick={event=>{if(event.target===event.currentTarget)onClose();}}>
    <form className="tpsl-dialog" onSubmit={event=>{event.preventDefault();if(canSave)void save(stopValue,takeProfitValue);}}>
      <header className="tpsl-header">
        <div><h3 id="tpsl-title">TP / SL</h3><p>{asset}USDT Perpetual · {venue.toUpperCase()}</p></div>
        <button type="button" className="text-button" aria-label="Close" onClick={onClose}>×</button>
      </header>
      <dl className="tpsl-summary">
        <div><dt>Side</dt><dd><StatusBadge tone={long?'positive':'negative'}>{side.toUpperCase()}</StatusBadge></dd></div>
        <div><dt>Size</dt><dd>{number(quantity)} {asset}</dd></div>
        <div><dt>Entry</dt><dd>{number(entryPrice,priceDigits)}</dd></div>
        <div><dt>Mark</dt><dd>{number(price,priceDigits)}</dd></div>
      </dl>
      {loadError?<p className="ticket-warning">Could not read the current TP/SL: {loadError}</p>:current==null&&<p className="ticket-help">Reading TP/SL orders from the exchange…</p>}
      {row('Take profit',takeProfit,setTakeProfit,current?.takeProfit,takeProfitValue,takeProfitWrong,long?'Above':'Below')}
      {row('Stop loss',stop,setStop,current?.stop,stopValue,stopWrong,long?'Below':'Above')}
      {stopValue==null&&current!=null&&<p className="ticket-warning">No stop loss: losses are not limited and the position can be liquidated.</p>}
      <p className="tpsl-note">Market orders for the whole position, triggered at the exchange. Confirm replaces the existing TP/SL; an empty field removes it.</p>
      <footer className="tpsl-footer">
        <Button variant="ghost" className="tpsl-remove" disabled={busy||(current?.stop==null&&current?.takeProfit==null)} onClick={()=>{if(window.confirm('Remove both the stop loss and the take profit?'))void save(null,null);}}>Remove all</Button>
        <span/>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={!canSave}>{saving?'Saving…':'Confirm'}</Button>
      </footer>
    </form>
  </dialog>,document.body);
}

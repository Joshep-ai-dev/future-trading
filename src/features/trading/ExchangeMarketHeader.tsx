import {useEffect,useRef,useState} from 'react';
import {EXCHANGES,saveExchangeVenue,type ExchangeVenue} from '../../shared/api/exchangeVenue';
import {Metric,StatusBadge} from '../../shared/ui/ui';
import {liveNumber as number,reconnectExchangeStream,useExchangeStream} from '../../shared/api/useExchangeStream';
import {EXCHANGE_INSTRUMENTS,defaultInstrumentForVenue,instrumentDetails,instrumentSupported,saveExchangeInstrument,useExchangeInstrument,type ExchangeInstrument} from '../../shared/api/exchangeInstrument';
import {api} from '../../shared/api/api';

export default function ExchangeMarketHeader({venue,botRunning=false}:{venue:ExchangeVenue;botRunning?:boolean}){
  const {data,connected,disconnected}=useExchangeStream(venue);
  const instrumentId=useExchangeInstrument(),instrument=instrumentDetails(instrumentId);
  const picker=useRef<HTMLDetailsElement>(null);
  const [switching,setSwitching]=useState(false),[switchError,setSwitchError]=useState('');
  const priceDigits=instrument.id==='stable'?5:3;
  const collateral=venue==='hyperliquid'?'USDC':'USDT';
  const instrumentLabel=`${instrument.base} / ${collateral}`;
  const market=data?.market;
  const live=connected&&data?.streams.market==='live';
  useEffect(()=>{
    const close=(event:PointerEvent)=>{if(picker.current&&!picker.current.contains(event.target as Node))picker.current.open=false;};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&picker.current){picker.current.open=false;picker.current.querySelector('summary')?.focus();}};
    document.addEventListener('pointerdown',close);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',escape);};
  },[]);
  async function changeInstrument(value:ExchangeInstrument){
    if(value===instrumentId)return;
    setSwitchError('');
    if(connected){
      setSwitching(true);
      try{
        await api('/api/exchange/reconnect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({venue,instrument:value})});
        reconnectExchangeStream(venue);
        saveExchangeInstrument(value);
      }catch(error){setSwitchError(String(error));}
      finally{setSwitching(false);}
    }else saveExchangeInstrument(value);
  }
  function changeVenue(value:ExchangeVenue){
    if(value===venue||botRunning||switching)return;
    saveExchangeInstrument(defaultInstrumentForVenue(value));
    saveExchangeVenue(value);
  }
  return <div className="exchange-market-header">
    <div className="exchange-instrument"><span className="instrument-icon">{instrument.icon}</span><div><h1><details className="market-picker" ref={picker} onToggle={()=>{if((switching||botRunning)&&picker.current)picker.current.open=false;}}><summary aria-label="Select perpetual market" aria-disabled={switching||botRunning}>{instrumentLabel}<i aria-hidden="true"/></summary><div role="listbox" aria-label="Perpetual markets">{EXCHANGE_INSTRUMENTS.map(item=>{const supported=instrumentSupported(item.id,venue),label=`${item.base} / ${venue==='hyperliquid'?'USDC':'USDT'}`;return <button key={item.id} type="button" role="option" aria-selected={item.id===instrumentId} disabled={!supported} onClick={()=>{if(picker.current)picker.current.open=false;void changeInstrument(item.id);}}><span>{label}</span><small>{supported?'Perpetual':`Unavailable on ${venue.toUpperCase()}`}</small>{item.id===instrumentId&&<b aria-hidden="true">✓</b>}</button>;})}</div></details><StatusBadge>PERP</StatusBadge></h1><label className="exchange-venue-picker"><span className="sr-only">Trading exchange</span><select aria-label="Trading exchange" value={venue} disabled={switching||botRunning} onChange={event=>changeVenue(event.target.value as ExchangeVenue)}>{EXCHANGES.map(exchange=><option key={exchange.id} value={exchange.id}>{exchange.name}</option>)}</select></label><small className={switchError?'negative':''}>{switchError||`${venue.toUpperCase()} · ${collateral} perpetual`}</small></div></div>
    <div className="exchange-last"><strong>{number(market?.last,priceDigits)}</strong><small>{collateral}</small></div>
    <Metric label="24h change" value={market?.percentage==null?'—':`${market.percentage>=0?'+':''}${number(market.percentage,2)}%`} tone={(market?.percentage??0)<0?'negative':'positive'}/>
    <Metric label="24h high / low" value={`${number(market?.high,priceDigits)} / ${number(market?.low,priceDigits)}`}/>
    <Metric label="24h volume" value={number(market?.quoteVolume,0)} unit={collateral}/>
    <StatusBadge dot tone={disconnected?'neutral':live?'positive':'warning'}>{disconnected?'Disconnected':live?'Live market':'Connecting'}</StatusBadge>
  </div>;
}

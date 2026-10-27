import {useSyncExternalStore} from 'react';

export const EXCHANGE_INSTRUMENTS=[
  {id:'xag',base:'XAG',label:'XAG / USDT',icon:'Ag',unsupported:['hyperliquid'] as string[]},
  {id:'silver',base:'SILVER',label:'SILVER / USDC',icon:'Ag',unsupported:['okx','htx','mexc','binance'] as string[]},
  {id:'stable',base:'STABLE',label:'STABLE / USDC',icon:'S',unsupported:['okx','htx','mexc','binance'] as string[]},
] as const;
export type ExchangeInstrument=typeof EXCHANGE_INSTRUMENTS[number]['id'];

const storageKey='silver.exchange.instrument';
const changedEvent='silver:exchange-instrument-changed';
let activeInstrument:ExchangeInstrument|null=null;

export function readExchangeInstrument():ExchangeInstrument{
  if(activeInstrument)return activeInstrument;
  try{
    const saved=localStorage.getItem(storageKey);
    activeInstrument=EXCHANGE_INSTRUMENTS.some(item=>item.id===saved)?saved as ExchangeInstrument:'xag';
  }catch{activeInstrument='xag';}
  return activeInstrument;
}

export function saveExchangeInstrument(value:ExchangeInstrument){
  activeInstrument=value;
  try{localStorage.setItem(storageKey,value);}catch{/* Keep the selection for this session. */}
  if(typeof window!=='undefined')window.dispatchEvent(new Event(changedEvent));
}

function subscribe(listener:()=>void){
  if(typeof window==='undefined')return ()=>{};
  const changed=()=>listener();
  const storage=(event:StorageEvent)=>{if(event.key!==storageKey&&event.key!==null)return;activeInstrument=null;listener();};
  window.addEventListener(changedEvent,changed);
  window.addEventListener('storage',storage);
  return ()=>{window.removeEventListener(changedEvent,changed);window.removeEventListener('storage',storage);};
}

export function useExchangeInstrument(){
  return useSyncExternalStore<ExchangeInstrument>(subscribe,readExchangeInstrument,()=> 'xag');
}

export function instrumentDetails(value:ExchangeInstrument){
  return EXCHANGE_INSTRUMENTS.find(item=>item.id===value)!;
}

export function instrumentSupported(value:ExchangeInstrument,venue:string){
  return !instrumentDetails(value).unsupported.includes(venue);
}

export function defaultInstrumentForVenue(venue:string):ExchangeInstrument{
  return venue==='hyperliquid'?'silver':'xag';
}

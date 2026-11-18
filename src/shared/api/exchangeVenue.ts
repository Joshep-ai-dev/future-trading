import {useSyncExternalStore} from 'react';

export const EXCHANGES=[
  {id:'okx',name:'OKX',passphrase:true,wallet:false},
  {id:'htx',name:'HTX',passphrase:false,wallet:false},
  {id:'mexc',name:'MEXC',passphrase:false,wallet:false},
  {id:'hyperliquid',name:'Hyperliquid',passphrase:false,wallet:true},
] as const;
// Keep legacy account/status payloads readable without offering Binance in selectors.
export type ExchangeVenue=typeof EXCHANGES[number]['id']|'binance';

const storageKey='silver.exchange.venue';
const changedEvent='silver:exchange-venue-changed';
let activeVenue:ExchangeVenue|null=null;

export function readExchangeVenue():ExchangeVenue{
  if(activeVenue)return activeVenue;
  try{
    const saved=localStorage.getItem(storageKey);
    activeVenue=saved==='binance'?'htx':EXCHANGES.some(exchange=>exchange.id===saved)?saved as ExchangeVenue:'okx';
    if(saved==='binance')localStorage.setItem(storageKey,activeVenue);
  }catch{activeVenue='okx';}
  return activeVenue;
}

export function saveExchangeVenue(value:ExchangeVenue){
  if(value==='binance')value='htx';
  activeVenue=value;
  try{localStorage.setItem(storageKey,value);}catch{/* Keep this selection active for the current session. */}
  if(typeof window!=='undefined')window.dispatchEvent(new Event(changedEvent));
}

function subscribe(listener:()=>void){
  if(typeof window==='undefined')return ()=>{};
  const changed=()=>listener();
  const storage=(event:StorageEvent)=>{if(event.key!==storageKey&&event.key!==null)return;activeVenue=null;listener();};
  window.addEventListener(changedEvent,changed);
  window.addEventListener('storage',storage);
  return ()=>{window.removeEventListener(changedEvent,changed);window.removeEventListener('storage',storage);};
}

export function useExchangeVenue(){
  return useSyncExternalStore<ExchangeVenue>(subscribe,readExchangeVenue,()=> 'okx');
}

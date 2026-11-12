import {useSyncExternalStore} from 'react';

const eventName='silver:market-history-updated';
let revision=0;

export function notifyMarketDataUpdated(){
  revision++;
  if(typeof window!=='undefined')window.dispatchEvent(new Event(eventName));
}

function subscribe(listener:()=>void){
  if(typeof window==='undefined')return ()=>{};
  window.addEventListener(eventName,listener);
  return ()=>window.removeEventListener(eventName,listener);
}

export function useMarketDataRevision(){
  return useSyncExternalStore(subscribe,()=>revision,()=>0);
}

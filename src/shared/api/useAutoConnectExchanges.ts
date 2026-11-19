import {useEffect,useSyncExternalStore} from 'react';
import {api} from './api';
import {EXCHANGES,readExchangeVenue,type ExchangeVenue} from './exchangeVenue';
import {defaultInstrumentForVenue,instrumentSupported,readExchangeInstrument} from './exchangeInstrument';
import type {VenueStatus} from './exchangeTypes';
import {reconnectExchangeStream} from './useExchangeStream';

let connecting:readonly ExchangeVenue[]=[];
const listeners=new Set<()=>void>();
function update(venues:readonly ExchangeVenue[]){
  connecting=venues;
  listeners.forEach(listener=>listener());
}
function subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};}
export function useAutoConnectingExchanges(){
  return useSyncExternalStore(subscribe,()=>connecting);
}

/** Restore saved accounts once on sign-in/page load, independently of the current tab. */
export function useAutoConnectExchanges(userId:number|string){
  useEffect(()=>{
    let cancelled=false;
    async function restore(){
      try{
        const status=await api<{venues:VenueStatus[];savedVenues:ExchangeVenue[]}>('/api/exchange/status');
        if(cancelled)return;
        const venues=EXCHANGES.map(exchange=>exchange.id).filter(venue=>
          status.savedVenues?.includes(venue)&&!status.venues.some(account=>account.venue===venue&&account.connected));
        update(venues);
        await Promise.allSettled(venues.map(async venue=>{
          const selected=readExchangeInstrument();
          const instrument=venue===readExchangeVenue()&&instrumentSupported(selected,venue)?selected:defaultInstrumentForVenue(venue);
          try{
            await api('/api/exchange/reconnect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({venue,instrument})});
            if(!cancelled)reconnectExchangeStream(venue);
          }catch{/* Manual reconnect remains available if the saved connection fails. */}
          finally{if(!cancelled)update(connecting.filter(value=>value!==venue));}
        }));
      }catch{/* Loading the workspace must remain possible when exchange status is unavailable. */}
    }
    void restore();
    return()=>{cancelled=true;update([]);};
  },[userId]);
}

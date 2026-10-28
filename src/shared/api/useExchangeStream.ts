import {useCallback,useSyncExternalStore} from 'react';
import type {ExchangeVenue} from './exchangeVenue';

export type LivePosition={side:string;quantity:number;entryPrice:number|null;markPrice:number|null;unrealizedPnl:number|null;leverage:number|null;liquidationPrice:number|null;marginMode:string|null;initialMargin:number|null;percentage:number|null};
export type LiveOrder={id:string;side:string;type:string;price:number|null;triggerPrice:number|null;quantity:number|null;filled:number|null;status:string;marginMode?:string|null};
export type ExchangeSnapshot={executionError?:string|null;symbol:string;updatedAt:number;market:Record<string,number|null>|null;balance:Record<string,number|null>|null;positions:LivePosition[]|null;orders:LiveOrder[]|null;conditionalOrders?:LiveOrder[]|null;candle:number[]|null;errors:Record<string,string>;streams:{market:string;account:string};sectionTimes:Record<string,number>};
type State={data:ExchangeSnapshot|null;connected:boolean;disconnected:boolean;error:string};
type Store={state:State;listeners:Set<()=>void>;source:EventSource|null;closeTimer:ReturnType<typeof setTimeout>|null};
const stores=new Map<ExchangeVenue,Store>();
function storeFor(venue:ExchangeVenue){
  let store=stores.get(venue);
  if(!store){store={state:{data:null,connected:false,disconnected:false,error:''},listeners:new Set(),source:null,closeTimer:null};stores.set(venue,store);}
  return store;
}
function emit(store:Store,state:State){store.state=state;store.listeners.forEach(listener=>listener());}
function openStream(venue:ExchangeVenue,store:Store){
  if(store.source||store.state.disconnected||!store.listeners.size)return;
  const source=new EventSource(`/api/exchange/stream?venue=${venue}`);store.source=source;
  source.onmessage=event=>{
    if(store.source!==source)return;
    try{
      const data=JSON.parse(event.data) as ExchangeSnapshot;
      const previousCandle=store.state.data?.candle;
      if(previousCandle&&data.candle&&previousCandle.every((value,index)=>data.candle![index]===value))data.candle=previousCandle;
      emit(store,{data,connected:true,disconnected:false,error:''});
    }catch{emit(store,{...store.state,connected:false,error:'Invalid exchange stream data.'});}
  };
  source.onerror=()=>{if(store.source===source)emit(store,{...store.state,connected:false,error:'Waiting for exchange connection. Reconnecting automatically.'});};
}
function subscribe(venue:ExchangeVenue,listener:()=>void){
  const store=storeFor(venue);store.listeners.add(listener);
  if(store.closeTimer){clearTimeout(store.closeTimer);store.closeTimer=null;}
  openStream(venue,store);
  return()=>{
    store.listeners.delete(listener);
    if(!store.listeners.size)store.closeTimer=setTimeout(()=>{
      store.source?.close();store.source=null;store.closeTimer=null;
      emit(store,{data:null,connected:false,disconnected:store.state.disconnected,error:''});
    },300);
  };
}
export function disconnectExchangeStream(venue:ExchangeVenue){
  const store=storeFor(venue);
  store.source?.close();store.source=null;
  emit(store,{data:null,connected:false,disconnected:true,error:''});
}
export function reconnectExchangeStream(venue:ExchangeVenue){
  const store=storeFor(venue);
  store.source?.close();store.source=null;
  emit(store,{data:null,connected:false,disconnected:false,error:''});
  openStream(venue,store);
}
export function syncExchangeConnection(venue:ExchangeVenue,connected:boolean){
  const store=storeFor(venue);
  if(connected&&store.state.disconnected)reconnectExchangeStream(venue);
  else if(!connected&&!store.state.disconnected)disconnectExchangeStream(venue);
}
export function useExchangeStream(venue:ExchangeVenue){
  return useSyncExternalStore(useCallback(listener=>subscribe(venue,listener),[venue]),useCallback(()=>storeFor(venue).state,[venue]));
}
export const liveNumber=(value:number|null|undefined,digits=4)=>value==null||!Number.isFinite(value)?'—':value.toLocaleString(undefined,{maximumFractionDigits:digits});

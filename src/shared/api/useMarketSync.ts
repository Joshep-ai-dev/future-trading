import {createContext,useEffect,useRef,useState} from 'react';
import {api} from './api';
import {notifyMarketDataUpdated} from '../charts/marketDataRevision';

type SyncStatus={running:boolean;lastSuccess:number|null;error:string|null};
export const MarketSyncContext=createContext<SyncStatus|null>(null);

/** Keep history notifications running independently of the header UI. */
export function useMarketSync(onUpdated:()=>void){
  const [status,setStatus]=useState<SyncStatus|null>(null);
  const callback=useRef(onUpdated),success=useRef<number|null>(null);
  callback.current=onUpdated;
  useEffect(()=>{
    let active=true,timer:ReturnType<typeof setTimeout>;
    const abort=new AbortController();
    async function poll(){
      let delay=15000;
      try{
        const value=await api<SyncStatus>('/api/market-status',{signal:abort.signal});
        if(!active)return;
        setStatus(value);delay=value.running?1000:15000;
        if(value.lastSuccess!==null&&value.lastSuccess!==success.current){success.current=value.lastSuccess;notifyMarketDataUpdated();callback.current();}
      }catch{if(active)setStatus(old=>old?{...old,error:'History sync unavailable'}:{running:false,lastSuccess:null,error:'History sync unavailable'});}
      finally{if(active)timer=setTimeout(poll,delay);}
    }
    void poll();return()=>{active=false;abort.abort();clearTimeout(timer);};
  },[]);
  return status;
}

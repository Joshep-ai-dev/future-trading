import {useEffect,useState} from 'react';
import {api} from './api';
export type MarketQuote={price:number|null;priceSource:'last'|'mid'|'mark'|null;percentage:number|null;quoteVolume:number|null};
type Snapshot={quotes:Record<string,MarketQuote>;updatedAt:number|null;stale:boolean;warning:string|null};
export function useMarketQuotes(venue:string,enabled:boolean){
  const [state,setState]=useState<Snapshot&{venue:string;loading:boolean}>({venue,quotes:{},updatedAt:null,stale:false,warning:null,loading:false});
  useEffect(()=>{
    if(!enabled)return;
    let active=true,timer:ReturnType<typeof setTimeout>;
    const abort=new AbortController();
    setState(old=>old.venue===venue?{...old,loading:old.updatedAt===null}:{venue,quotes:{},updatedAt:null,stale:false,warning:null,loading:true});
    async function poll(){
      try{const result=await api<Snapshot>(`/api/exchange/quotes?venue=${encodeURIComponent(venue)}`,{signal:abort.signal});if(active)setState({...result,venue,loading:false});}
      catch(error){if(active)setState(old=>({...old,venue,loading:false,stale:true,warning:String(error)}));}
      finally{if(active)timer=setTimeout(poll,15000);}
    }
    void poll();return()=>{active=false;abort.abort();clearTimeout(timer);};
  },[venue,enabled]);
  return state.venue===venue?state:{venue,quotes:{},updatedAt:null,stale:false,warning:null,loading:true};
}

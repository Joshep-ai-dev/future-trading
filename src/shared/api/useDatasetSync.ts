import {useEffect,useState} from 'react';
import {api} from './api';
import {notifyMarketDataUpdated} from '../charts/marketDataRevision';

export function useDatasetSync(market:string,active:boolean){
  const [state,setState]=useState({market,running:false,lastSuccess:null as number|null,error:false});
  useEffect(()=>{
    setState({market,running:false,lastSuccess:null,error:false});
    if(!active||!market.startsWith('dataset:'))return;
    const abort=new AbortController();
    let pending=false;
    async function sync(){
      if(pending||abort.signal.aborted)return;
      pending=true;
      setState(old=>({...old,running:true}));
      try{
        const result=await api<{lastSuccess:number}>('/api/market/datasets/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({market}),signal:abort.signal});
        if(!abort.signal.aborted){setState({market,running:false,lastSuccess:result.lastSuccess,error:false});notifyMarketDataUpdated();}
      }catch{if(!abort.signal.aborted)setState(old=>({...old,running:false,error:true}));}
      finally{pending=false;}
    }
    void sync();
    const timer=setInterval(()=>void sync(),60000);
    return()=>{abort.abort();clearInterval(timer);};
  },[market,active]);
  return state.market===market?state:{market,running:false,lastSuccess:null,error:false};
}

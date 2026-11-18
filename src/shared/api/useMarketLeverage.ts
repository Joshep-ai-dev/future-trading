import {useEffect,useRef,useState} from 'react';
import {api} from './api';

type Profile={venue:string;symbol:string;minimum:number;maximum:number|null;current:number|null;differentSides:boolean;warnings:string[]};
export function useMarketLeverage(venue:string,instrument:string,connected:boolean,symbol?:string){
  const key=`${venue}:${instrument}`;
  const choices=useRef<Record<string,string>>({});
  const [state,setState]=useState<{key:string;value:string;profile:Profile|null;loading:boolean;error:string}>({key,value:'1',profile:null,loading:true,error:''});
  useEffect(()=>{
    let active=true;
    setState({key,value:choices.current[key]??'1',profile:null,loading:connected,error:''});
    if(connected){
      api<Profile>(`/api/exchange/leverage?venue=${encodeURIComponent(venue)}`).then(profile=>{
        if(!active)return;
        if(instrument.includes('/')&&profile.symbol!==instrument)throw new Error('Waiting for the selected market.');
        const min=profile.minimum,max=Math.min(profile.maximum??100,100);
        const selected=Number(choices.current[key]??profile.current??min);
        const value=String(Math.min(max,Math.max(min,Math.floor(selected))));
        setState({key,value,profile,loading:false,error:''});
      }).catch(error=>{if(active)setState({key,value:'1',profile:null,loading:false,error:String(error)});});
    }
    return()=>{active=false;};
  },[key,venue,instrument,connected,symbol]);
  const current=state.key===key?state:{key,value:'1',profile:null,loading:true,error:''};
  const minimum=current.profile?.minimum??1;
  const maximum=Math.min(current.profile?.maximum??100,100);
  const note=current.loading?'Reading market leverage...':current.error?'Leverage could not be read. Defaulting to 1x.':current.profile?.differentSides?'Long and short leverage differ. Choose leverage for new orders.':current.profile?.current!=null?`Exchange isolated leverage: ${current.profile.current}x.`:'Current isolated leverage unavailable. Using your market choice, or 1x by default.';
  return {value:current.value,minimum,maximum,loading:current.loading,note:current.profile?.maximum!=null?`${note} Market maximum: ${current.profile.maximum}x; position-size limits may apply.`:`${note} Exchange maximum unavailable.`,setValue:(value:string)=>{choices.current[key]=value;setState(previous=>({...previous,key,value}));}};
}

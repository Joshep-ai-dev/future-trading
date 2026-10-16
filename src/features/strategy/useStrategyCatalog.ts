import {useEffect,useState} from 'react';
import {api} from '../../shared/api/api';

export type FeatureGroupInfo={key:string;label:string;description:string};
export type ModelInfo={key:string;label:string;family:string;description:string;available:boolean;requires:string|null};
export type StrategyCatalog={strategies:{key:string;label:string;liveSupported:boolean}[];featureGroups:FeatureGroupInfo[];models:ModelInfo[]};

let cached:Promise<StrategyCatalog>|null=null;

/** Strategies, indicator groups and installed models reported by the backend (fetched once). */
export function useStrategyCatalog(){
  const [catalog,setCatalog]=useState<StrategyCatalog|null>(null),[error,setError]=useState('');
  useEffect(()=>{
    let active=true;
    cached??=api<StrategyCatalog>('/api/strategies').catch(reason=>{cached=null;throw reason;});
    cached.then(value=>{if(active)setCatalog(value);}).catch(reason=>{if(active)setError(String(reason));});
    return()=>{active=false;};
  },[]);
  return {catalog,error};
}

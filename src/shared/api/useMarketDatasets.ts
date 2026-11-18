import {useEffect,useState} from 'react';
import {api} from './api';
import {useMarketDataRevision} from '../charts/marketDataRevision';
export type MarketDataset={id:string;venue:string;symbol:string;label:string;bars:number;start:number;end:number;startDate:string;endDate:string;missingBars:number};
export function useMarketDatasets(){
  const revision=useMarketDataRevision();
  const [datasets,setDatasets]=useState<MarketDataset[]>([]);
  useEffect(()=>{let active=true;api<{datasets:MarketDataset[]}>('/api/market/datasets').then(result=>{if(active)setDatasets(result.datasets);}).catch(()=>{});return()=>{active=false;};},[revision]);
  return datasets;
}

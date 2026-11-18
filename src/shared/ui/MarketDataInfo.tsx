export default function MarketDataInfo({source,timestamp,label='Synced',syncing=false,error=false}:{source:string;timestamp:number|null;label?:string;syncing?:boolean;error?:boolean}){
  const time=timestamp===null?null:new Date(timestamp);
  return <span className={`market-data-info ${error?'is-delayed':''}`} title={error?'Automatic history sync will retry. Saved candles remain available.':time?`${label}: ${time.toLocaleString()}`:source}>
    <span>{source}</span><span aria-hidden="true">&#183;</span><span>{syncing?'Updating...':error?'Sync delayed':time?`${label} ${time.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`:'Saved history'}</span>
  </span>;
}

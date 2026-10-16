import type {ExchangeVenue} from './exchangeVenue';
import {Metric,StatusBadge} from './components/ui';
import {liveNumber as number,useExchangeStream} from './useExchangeStream';

export default function ExchangeMarketHeader({venue}:{venue:ExchangeVenue}){
  const {data,connected,disconnected}=useExchangeStream(venue);
  const market=data?.market;
  const live=connected&&data?.streams.market==='live';
  return <div className="exchange-market-header">
    <div className="exchange-instrument"><span className="instrument-icon">Ag</span><div><h1>XAG / USDT <StatusBadge>PERP</StatusBadge></h1><small>{venue.toUpperCase()} · USDT perpetual</small></div></div>
    <div className="exchange-last"><strong>{number(market?.last,3)}</strong><small>USDT</small></div>
    <Metric label="24h change" value={market?.percentage==null?'—':`${market.percentage>=0?'+':''}${number(market.percentage,2)}%`} tone={(market?.percentage??0)<0?'negative':'positive'}/>
    <Metric label="24h high / low" value={`${number(market?.high,3)} / ${number(market?.low,3)}`}/>
    <Metric label="24h volume" value={number(market?.quoteVolume,0)} unit="USDT"/>
    <StatusBadge dot tone={disconnected?'neutral':live?'positive':'warning'}>{disconnected?'Disconnected':live?'Live market':'Connecting'}</StatusBadge>
  </div>;
}

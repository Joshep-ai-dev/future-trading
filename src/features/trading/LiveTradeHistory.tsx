import {useEffect,useMemo,useState} from 'react';
import {api} from '../../shared/api/api';
import type {ExchangeVenue} from '../../shared/api/exchangeVenue';
import TradeView,{type PnlTrade} from '../../shared/ui/TradeView';
import {EmptyState} from '../../shared/ui/ui';

type ClosedOrder={id:string;side:string|null;pnl:number;leverage?:number|null;price:number;quantity:number;timestamp:number};

export default function LiveTradeHistory({venue}:{venue:ExchangeVenue}){
  const [orders,setOrders]=useState<ClosedOrder[]>([]),[error,setError]=useState('');
  useEffect(()=>{
    let active=true,pending=false;
    async function refresh(){
      if(pending)return;pending=true;
      try{const value=await api<{trades:ClosedOrder[]}>(`/api/exchange/trade-history?venue=${venue}`);if(active){setOrders(value.trades);setError('');}}
      catch(reason){if(active)setError(String(reason));}finally{pending=false;}
    }
    void refresh();const timer=setInterval(()=>void refresh(),10000);
    return()=>{active=false;clearInterval(timer);};
  },[venue]);
  const trades=useMemo<PnlTrade[]>(()=>orders.map((order,index)=>({
    id:index+1,direction:order.side==='sell'?1:-1,pnl:order.pnl,entry:null,exit:order.price,
    quantity:order.quantity,exitTime:order.timestamp,
  })),[orders]);
  if(error)return <div className="exchange-inline-error" role="status">{error}</div>;
  if(!trades.length)return <EmptyState compact title="No realized P&L history"/>;
  return <TradeView trades={trades} capital={0} scope="Live"><div className="table-scroll"><table><thead><tr><th>Closed</th><th>Side</th><th>Leverage</th><th>Close price</th><th>Quantity</th><th>Realized P&amp;L</th></tr></thead><tbody>{orders.map(order=><tr key={order.id}><td>{order.timestamp?new Date(order.timestamp*1000).toLocaleString():'—'}</td><td><span className={`side-badge ${order.side==='sell'?'short':'long'}`}>{order.side?.toUpperCase()}</span></td><td>{order.leverage?`${order.leverage}x`:'—'}</td><td>{order.price}</td><td>{order.quantity}</td><td className={order.pnl>=0?'positive':'negative'}>{order.pnl>=0?'+':''}{order.pnl.toFixed(4)} USDT</td></tr>)}</tbody></table></div></TradeView>;
}

import {useState} from 'react';
import {api} from './api';
import type {ExchangeVenue} from './exchangeVenue';
import {liveNumber as n,useExchangeStream} from './useExchangeStream';

export function ExchangeMarketHeader({venue}:{venue:ExchangeVenue}){
  const {data,connected}=useExchangeStream(venue);
  const market=data?.market;
  const live=connected&&data?.streams.market==='live';
  return <div className="exchange-market-header">
    <div className="exchange-instrument"><span className="instrument-icon">Ag</span><div><h1>XAG / USDT <span>PERP</span></h1><small>{venue.toUpperCase()} · USDT perpetual</small></div></div>
    <div className="exchange-last"><strong>{n(market?.last,3)}</strong><small>USDT</small></div>
    <div className="exchange-header-stat"><small>24h change</small><b className={(market?.percentage??0)<0?'negative':'positive'}>{market?.percentage==null?'—':`${market.percentage>=0?'+':''}${n(market.percentage,2)}%`}</b></div>
    <div className="exchange-header-stat"><small>24h high / low</small><b>{n(market?.high,3)} / {n(market?.low,3)}</b></div>
    <div className="exchange-header-stat"><small>Bid / Ask</small><b><span className="positive">{n(market?.bid,3)}</span> / <span className="negative">{n(market?.ask,3)}</span></b></div>
    <div className={`exchange-stream-badge ${live?'is-live':''}`}><i/>{live?'LIVE MARKET':'CONNECTING'}</div>
  </div>;
}

export function ExchangeOrderBook({venue}:{venue:ExchangeVenue}){
  const {data}=useExchangeStream(venue);
  const book=data?.book;
  const max=Math.max(1,...(book?.bids??[]).map(row=>row[1]),...(book?.asks??[]).map(row=>row[1]));
  return <section className="exchange-order-book"><div className="exchange-book-title"><h3>Order book</h3><span>{venue.toUpperCase()} · XAG</span></div><div className="exchange-book-labels"><span>Price (USDT)</span><span>Size (contracts)</span></div>
    {(['asks','bids'] as const).map(side=><div key={side} className={`exchange-book-side ${side}`}>{(side==='asks'?[...(book?.asks??[])].reverse():book?.bids??[]).map(([price,size])=><div className="exchange-book-row" key={price}><i style={{width:`${size/max*100}%`}}/><span>{n(price,3)}</span><span>{n(size,2)}</span></div>)}{side==='asks'&&<div className="exchange-book-mid">{n(data?.market?.last,3)} <small>USDT</small></div>}</div>)}
    {!book&&<p className="exchange-loading">Connecting to market depth…</p>}{data?.errors.bookStream&&<p className="exchange-inline-error">{data.errors.bookStream}</p>}
  </section>;
}

export default function ExchangeOverview({venue,accountView=false}:{venue:ExchangeVenue;accountView?:boolean}){
  const {data,connected,error}=useExchangeStream(venue);
  const [tab,setTab]=useState<'positions'|'orders'|'assets'>('positions'),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const accountLive=connected&&data?.streams.account==='live';
  async function closePosition(){
    if(!window.confirm('Close the XAG/USDT position with a reduce-only market order?'))return;
    setBusy(true);setMessage('');
    try{const result=await api<{message?:string}>('/api/exchange/close',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({venue,confirmation:'CLOSE LIVE POSITION'})});setMessage(result.message??'Close submitted. Waiting for exchange confirmation.');}
    catch(reason){setMessage(String(reason));}finally{setBusy(false);}
  }
  const positions=data?.positions,orders=data?.orders;
  const sectionError=data?.errors[tab==='assets'?'balance':tab];
  return <section className={`exchange-activity ${accountView?'exchange-account-overview':''}`} aria-label="Live exchange account">
    {accountView&&<ExchangeMarketHeader venue={venue}/>}
    <div className="exchange-account-strip"><div><small>Account equity</small><strong>{n(data?.balance?.total,2)} <span>USDT</span></strong></div><div><small>Available</small><strong>{n(data?.balance?.free,2)} <span>USDT</span></strong></div><div><small>Used margin</small><strong>{n(data?.balance?.used,2)} <span>USDT</span></strong></div><div className={`exchange-stream-badge ${accountLive?'is-live':''}`}><i/>{accountLive?'ACCOUNT LIVE':'ACCOUNT SYNCING'}</div></div>
    <div className="exchange-activity-tabs" role="tablist" aria-label="Exchange activity">{([['positions','Positions',positions?.length],['orders','Open orders',orders?.length],['assets','Assets',null]] as const).map(([key,label,count])=><button key={key} role="tab" aria-selected={tab===key} aria-controls={`exchange-${venue}-${key}`} id={`exchange-tab-${venue}-${key}`} onClick={()=>setTab(key)}>{label}{count!=null&&<span>{count}</span>}</button>)}<small>{venue.toUpperCase()} · XAGUSDT</small></div>
    {(error||data?.errors.connection)&&<p className="exchange-inline-error" role="status">{error||data?.errors.connection} Displayed values may be stale.</p>}
    {data?.executionError&&<p className="exchange-inline-error">{data.executionError}</p>}
    {data?.errors.accountStream&&<p className="exchange-inline-error">{data.errors.accountStream}</p>}
    {sectionError&&<p className="exchange-inline-error" role="status">{sectionError} Position and order data is unverified.</p>}
    <div role="tabpanel" id={`exchange-${venue}-${tab}`} aria-labelledby={`exchange-tab-${venue}-${tab}`} className="exchange-activity-content">
      {tab==='positions'&&(positions?.length?<div className="exchange-table-scroll"><table><thead><tr>{['Contract','Mark price','Entry price','Margin (USDT)','Unrealized PnL','PnL (%)','Liquidation','Size (XAG)','Action'].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{positions.map((p,index)=><tr key={index}><td><strong>XAGUSDT <small>Perpetual</small></strong><div className="exchange-position-tags"><span className={p.side==='long'?'long':'short'}>{p.side?.toUpperCase()}</span><span>{n(p.leverage,1)}×</span><span>{p.marginMode??'—'}</span></div></td><td>{n(p.markPrice,3)}</td><td>{n(p.entryPrice,3)}</td><td>{n(p.initialMargin,4)}</td><td className={(p.unrealizedPnl??0)<0?'negative':'positive'}>{p.unrealizedPnl!=null&&p.unrealizedPnl>=0?'+':''}{n(p.unrealizedPnl,4)} <small>USDT</small></td><td className={(p.percentage??0)<0?'negative':'positive'}>{n(p.percentage,2)}{p.percentage!=null?'%':''}</td><td>{n(p.liquidationPrice,3)}</td><td>{n(p.quantity)}</td><td><button type="button" className="exchange-close" disabled={busy||!connected||!!sectionError||!!data?.executionError||positions.length!==1} onClick={()=>void closePosition()}>Close {p.side}</button></td></tr>)}</tbody></table></div>:!sectionError&&<div className="exchange-empty"><span>◇</span><strong>{positions?'No open XAG positions':'Loading positions'}</strong><p>{positions?'Your exchange positions will appear here as they change.':'Waiting for a verified account snapshot.'}</p></div>)}
      {tab==='orders'&&(orders?.length?<div className="exchange-table-scroll"><table><thead><tr>{['Contract','Side','Type','Size (XAG)','Filled','Price','Trigger','Status'].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{orders.map((order,index)=><tr key={order.id??index}><td>XAGUSDT</td><td className={order.side==='buy'?'positive':'negative'}>{order.side?.toUpperCase()}</td><td>{order.type??'—'}</td><td>{n(order.quantity)}</td><td>{n(order.filled)}</td><td>{n(order.price,3)}</td><td>{n(order.triggerPrice,3)}</td><td>{order.status??'—'}</td></tr>)}</tbody></table></div>:!sectionError&&<div className="exchange-empty"><span>≡</span><strong>{orders?'No standard open orders':'Loading orders'}</strong><p>Conditional and protective stops may be listed separately on the exchange.</p></div>)}
      {tab==='assets'&&<div className="exchange-table-scroll"><table><thead><tr><th>Asset</th><th>Equity</th><th>Available</th><th>Used margin</th></tr></thead><tbody><tr><td><strong>USDT</strong></td><td>{n(data?.balance?.total,4)}</td><td>{n(data?.balance?.free,4)}</td><td>{n(data?.balance?.used,4)}</td></tr></tbody></table></div>}
    </div>
    {message&&<p className="exchange-inline-error" role="status">{message}</p>}
    <div className="exchange-activity-footer"><span>Exchange account · no simulated balances</span><span>{data?.sectionTimes[tab==='assets'?'balance':tab]?`Account snapshot ${new Date(data.sectionTimes[tab==='assets'?'balance':tab]).toLocaleTimeString()}`:'Waiting for account data'}</span></div>
  </section>;
}

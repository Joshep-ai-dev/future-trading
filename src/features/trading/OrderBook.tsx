import {useEffect,useMemo,useRef,useState} from 'react';
import {useExchangeStream,type LiveTrade,type OrderBookSnapshot} from '../../shared/api/useExchangeStream';
import {api} from '../../shared/api/api';
import {instrumentDetails,useExchangeInstrument} from '../../shared/api/exchangeInstrument';
import type {ExchangeVenue} from '../../shared/api/exchangeVenue';

const LEVELS=11;
type Level={price:number;size:number;total:number};

/** Smallest positive gap between listed prices: the book's effective tick size. */
function tickOf(book:OrderBookSnapshot|null|undefined){
  const prices=[...(book?.asks??[]),...(book?.bids??[])].map(level=>level[0]).sort((a,b)=>a-b);
  let tick=Infinity;
  for(let index=1;index<prices.length;index++){const gap=prices[index]-prices[index-1];if(gap>1e-12&&gap<tick)tick=gap;}
  if(!Number.isFinite(tick))return null;
  const power=10**Math.floor(Math.log10(tick));
  return Math.round(tick/power)*power;
}
const digitsOf=(step:number)=>Math.min(8,Math.max(0,Math.ceil(-Math.log10(step)-1e-9)));

/** Group one side into price buckets (asks round up, bids down) and accumulate totals from the spread outward. */
function group(levels:[number,number][],step:number,side:'ask'|'bid',quote:boolean):Level[]{
  const buckets=new Map<number,number>();
  for(const [price,size] of levels){
    const bucket=(side==='ask'?Math.ceil(price/step-1e-9):Math.floor(price/step+1e-9))*step;
    const key=Number(bucket.toFixed(10));
    buckets.set(key,(buckets.get(key)??0)+(quote?size*price:size));
  }
  const sorted=[...buckets].sort((a,b)=>side==='ask'?a[0]-b[0]:b[0]-a[0]).slice(0,LEVELS);
  let total=0;
  return sorted.map(([price,size])=>{total+=size;return {price,size,total};});
}
const amount=(value:number)=>value.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});

type BookData={symbol?:string;orderBook?:OrderBookSnapshot|null;trades?:LiveTrade[]|null};

/** Live page: order book and trades from the connected exchange's stream. */
export default function OrderBook({venue}:{venue:ExchangeVenue}){
  const {data,connected}=useExchangeStream(venue);
  const base=instrumentDetails(useExchangeInstrument()).base;
  return <OrderBookPanel id="live-order-book" data={data} base={base} resetKey={`${venue}-${base}`}
    emptyBook={connected?'Order book is not available for this exchange.':'Connect an exchange to stream the order book.'}
    emptyTrades={connected?'Waiting for trades...':'Connect an exchange to stream trades.'}/>;
}

/** Paper page: public OKX XAG order book, polled about once per second while shown. */
export function PublicOrderBook({active,base,unavailable}:{active:boolean;base:string;unavailable?:string}){
  const [data,setData]=useState<BookData|null>(null),[error,setError]=useState('');
  useEffect(()=>{
    if(!active||unavailable){setData(null);return;}
    let alive=true,timer:ReturnType<typeof setTimeout>;
    const abort=new AbortController();
    async function poll(){
      try{const next=await api<BookData>('/api/market/orderbook',{signal:abort.signal});if(alive){setData(next);setError('');}}
      catch(reason){if(alive)setError(String(reason));}
      finally{if(alive)timer=setTimeout(poll,1000);}
    }
    void poll();
    return()=>{alive=false;abort.abort();clearTimeout(timer);};
  },[active,unavailable]);
  const message=unavailable??(error?'Order book is unavailable. Retrying automatically.':'Loading order book...');
  return <OrderBookPanel id="paper-order-book" data={unavailable?null:data} base={base} resetKey={base} emptyBook={message} emptyTrades={unavailable??(error?'Trades are unavailable. Retrying automatically.':'Loading trades...')}/>;
}

function OrderBookPanel({id,data,base,resetKey,emptyBook,emptyTrades}:{id:string;data:BookData|null;base:string;resetKey:string;emptyBook:string;emptyTrades:string}){
  const quoteName=data?.symbol?.split('/')[1]?.split(':')[0]??'USDT';
  const [tab,setTab]=useState<'book'|'trades'>('book');
  const [multiplier,setMultiplier]=useState(1);
  const [quote,setQuote]=useState(false);
  const book=data?.orderBook;
  const tickRef=useRef<number|null>(null);
  const detected=tickOf(book);
  if(detected!==null&&(tickRef.current===null||detected<tickRef.current))tickRef.current=detected;
  useEffect(()=>{tickRef.current=null;setMultiplier(1);},[resetKey]);
  const tick=tickRef.current;
  const step=tick===null?null:tick*multiplier;
  const unit=quote?quoteName:base;
  const {asks,bids,max}=useMemo(()=>{
    if(!book||step===null)return {asks:[] as Level[],bids:[] as Level[],max:0};
    const asks=group(book.asks,step,'ask',quote),bids=group(book.bids,step,'bid',quote);
    return {asks,bids,max:Math.max(asks.at(-1)?.total??0,bids.at(-1)?.total??0)};
  },[book,step,quote]);
  const bestAsk=book?.asks[0]?.[0],bestBid=book?.bids[0]?.[0];
  const spread=bestAsk!==undefined&&bestBid!==undefined?bestAsk-bestBid:null;
  const spreadPct=spread!==null&&bestAsk&&bestBid?spread/((bestAsk+bestBid)/2)*100:null;
  const priceDigits=step===null?3:digitsOf(step);
  const row=(level:Level,side:'ask'|'bid')=><div key={`${side}-${level.price}`} className={`order-book-row is-${side}`} role="row">
    <i className="order-book-depth" style={{width:`${max?level.total/max*100:0}%`}} aria-hidden="true"/>
    <span role="cell" className="order-book-price">{level.price.toFixed(priceDigits)}</span>
    <span role="cell">{amount(level.size)}</span>
    <span role="cell">{amount(level.total)}</span>
  </div>;
  const trades=data?.trades??[];
  return <section id={id} className="terminal-panel order-book-panel" aria-label="Order book and recent trades">
    <div className="order-book-tabs" role="tablist" aria-label="Market depth">
      <button type="button" role="tab" aria-selected={tab==='book'} onClick={()=>setTab('book')}>Order Book</button>
      <button type="button" role="tab" aria-selected={tab==='trades'} onClick={()=>setTab('trades')}>Trades</button>
    </div>
    {tab==='book'?<>
      <div className="order-book-controls">
        <select aria-label="Price grouping" value={multiplier} disabled={tick===null} onChange={event=>setMultiplier(Number(event.target.value))}>
          {[1,10,100,1000].map(value=><option key={value} value={value}>{tick===null?'—':(tick*value).toFixed(digitsOf(tick*value))}</option>)}
        </select>
        <select aria-label="Size unit" value={quote?'quote':'base'} onChange={event=>setQuote(event.target.value==='quote')}>
          <option value="base">{base}</option><option value="quote">{quoteName}</option>
        </select>
      </div>
      <div className="order-book-table" role="table" aria-label={`${base} order book`}>
        <div className="order-book-row is-head" role="row"><span role="columnheader">Price</span><span role="columnheader">Size ({unit})</span><span role="columnheader">Total ({unit})</span></div>
        <div className="order-book-side is-asks">{[...asks].reverse().map(level=>row(level,'ask'))}</div>
        <div className="order-book-spread" role="row"><span>Spread</span><span>{spread===null?'—':spread.toFixed(priceDigits)}</span><span>{spreadPct===null?'—':`${spreadPct.toFixed(3)}%`}</span></div>
        <div className="order-book-side is-bids">{bids.map(level=>row(level,'bid'))}</div>
        {!book&&<p className="order-book-empty" role="status">{emptyBook}</p>}
      </div>
    </>:<div className="order-book-table order-trades" role="table" aria-label={`${base} recent trades`}>
      <div className="order-book-row is-head" role="row"><span role="columnheader">Price</span><span role="columnheader">Size ({base})</span><span role="columnheader">Time</span></div>
      {trades.map((trade,index)=><div key={trade.id??index} className={`order-book-row ${trade.side==='sell'?'is-ask':'is-bid'}`} role="row">
        <span role="cell" className="order-book-price">{trade.price==null?'—':trade.price.toFixed(priceDigits)}</span>
        <span role="cell">{trade.quantity==null?'—':amount(trade.quantity)}</span>
        <span role="cell">{trade.timestamp==null?'—':new Date(trade.timestamp).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})}</span>
      </div>)}
      {!trades.length&&<p className="order-book-empty" role="status">{emptyTrades}</p>}
    </div>}
  </section>;
}

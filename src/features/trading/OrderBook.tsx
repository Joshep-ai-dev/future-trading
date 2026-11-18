import {useEffect,useMemo,useRef,useState} from 'react';
import {useExchangeStream,type LiveTrade,type OrderBookSnapshot} from '../../shared/api/useExchangeStream';
import {instrumentDetails,useExchangeInstrument} from '../../shared/api/exchangeInstrument';
import type {ExchangeVenue} from '../../shared/api/exchangeVenue';

const ROW_HEIGHT=24,MIN_LEVELS=5,MAX_LEVELS=50;
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
function group(levels:[number,number][],step:number,side:'ask'|'bid',quote:boolean,limit:number):Level[]{
  const buckets=new Map<number,number>();
  for(const [price,size] of levels){
    const bucket=(side==='ask'?Math.ceil(price/step-1e-9):Math.floor(price/step+1e-9))*step;
    const key=Number(bucket.toFixed(10));
    buckets.set(key,(buckets.get(key)??0)+(quote?size*price:size));
  }
  const sorted=[...buckets].sort((a,b)=>side==='ask'?a[0]-b[0]:b[0]-a[0]).slice(0,limit);
  let total=0;
  return sorted.map(([price,size])=>{total+=size;return {price,size,total};});
}
const amount=(value:number)=>value.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});

type Tab='book'|'trades';
type PanelData={symbol?:string;book:OrderBookSnapshot|null;trades:LiveTrade[]|null};

/** Latest value of a server-sent event stream; the stream is open only while ``url`` is set. */
function useEventStream<T>(url:string|null){
  const [value,setValue]=useState<T|null>(null);
  useEffect(()=>{
    setValue(null);
    if(!url)return;
    const source=new EventSource(url);
    source.onmessage=event=>{try{setValue(JSON.parse(event.data) as T);}catch{/* Ignore malformed frames. */}};
    return()=>source.close();
  },[url]);
  return value;
}

/** Live page: reads only the selected tab from the connected exchange, only while shown. */
export default function OrderBook({venue}:{venue:ExchangeVenue}){
  const {data,connected}=useExchangeStream(venue);
  const base=instrumentDetails(useExchangeInstrument()).base;
  const [tab,setTab]=useState<Tab>('book');
  const book=useEventStream<OrderBookSnapshot>(connected&&tab==='book'?`/api/exchange/depth?venue=${venue}&kind=orderBook`:null);
  const trades=useEventStream<LiveTrade[]>(connected&&tab==='trades'?`/api/exchange/depth?venue=${venue}&kind=trades`:null);
  return <OrderBookPanel id="live-order-book" tab={tab} onTab={setTab} data={{symbol:data?.symbol,book,trades}} base={base} resetKey={`${venue}-${base}`}
    emptyBook={connected?'Waiting for the order book...':'Connect an exchange to stream the order book.'}
    emptyTrades={connected?'Waiting for trades...':'Connect an exchange to stream trades.'}/>;
}

/** Paper page: real-time public OKX XAG book or trades (selected tab only), streamed while shown. */
export function PublicOrderBook({active,base,unavailable}:{active:boolean;base:string;unavailable?:string}){
  const [tab,setTab]=useState<Tab>('book');
  const live=active&&!unavailable;
  const book=useEventStream<OrderBookSnapshot>(live&&tab==='book'?'/api/market/realtime?kind=orderBook':null);
  const trades=useEventStream<LiveTrade[]>(live&&tab==='trades'?'/api/market/realtime?kind=trades':null);
  return <OrderBookPanel id="paper-order-book" tab={tab} onTab={setTab} data={{symbol:'XAG/USDT:USDT',book,trades}} base={base} resetKey={base}
    emptyBook={unavailable??'Loading order book...'} emptyTrades={unavailable??'Loading trades...'}/>;
}

function OrderBookPanel({id,tab,onTab,data,base,resetKey,emptyBook,emptyTrades}:{id:string;tab:Tab;onTab:(tab:Tab)=>void;data:PanelData;base:string;resetKey:string;emptyBook:string;emptyTrades:string}){
  const quoteName=data.symbol?.split('/')[1]?.split(':')[0]??'USDT';
  const [multiplier,setMultiplier]=useState(1);
  const [quote,setQuote]=useState(false);
  const book=data.book;
  // Show as many levels per side as fit the panel height (head + spread rows excluded).
  const table=useRef<HTMLDivElement>(null);
  const [levels,setLevels]=useState(11);
  useEffect(()=>{
    const element=table.current;if(!element)return;
    const measure=()=>{
      const free=element.clientHeight-26-26;
      const next=Math.min(MAX_LEVELS,Math.max(MIN_LEVELS,Math.floor(free/2/ROW_HEIGHT)));
      setLevels(old=>old===next?old:next);
    };
    measure();const observer=new ResizeObserver(measure);observer.observe(element);
    return()=>observer.disconnect();
  },[tab]);
  const tickRef=useRef<number|null>(null);
  const detected=tickOf(book);
  if(detected!==null&&(tickRef.current===null||detected<tickRef.current))tickRef.current=detected;
  useEffect(()=>{tickRef.current=null;setMultiplier(1);},[resetKey]);
  const tick=tickRef.current;
  const step=tick===null?null:tick*multiplier;
  const unit=quote?quoteName:base;
  const {asks,bids,max}=useMemo(()=>{
    if(!book||step===null)return {asks:[] as Level[],bids:[] as Level[],max:0};
    const asks=group(book.asks,step,'ask',quote,levels),bids=group(book.bids,step,'bid',quote,levels);
    return {asks,bids,max:Math.max(asks.at(-1)?.total??0,bids.at(-1)?.total??0)};
  },[book,step,quote,levels]);
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
  const trades=data.trades??[];
  return <section id={id} className="terminal-panel order-book-panel" aria-label="Order book and recent trades">
    <div className="order-book-tabs" role="tablist" aria-label="Market depth">
      <button type="button" role="tab" aria-selected={tab==='book'} onClick={()=>onTab('book')}>Order Book</button>
      <button type="button" role="tab" aria-selected={tab==='trades'} onClick={()=>onTab('trades')}>Trades</button>
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
      <div ref={table} className="order-book-table" role="table" aria-label={`${base} order book`}>
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

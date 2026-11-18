import MarketSymbolLabel from '../../shared/ui/MarketSymbolLabel';
import {useMarketQuotes,type MarketQuote} from '../../shared/api/useMarketQuotes';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {EXCHANGES,type ExchangeVenue} from '../../shared/api/exchangeVenue';
import MarketHeader from '../../shared/ui/MarketHeader';
import {liveNumber as number,reconnectExchangeStream,useExchangeStream} from '../../shared/api/useExchangeStream';
import {useExchangeMarkets,instrumentDetails,saveExchangeInstrument,useExchangeInstrument,type ExchangeInstrument} from '../../shared/api/exchangeInstrument';
import {api} from '../../shared/api/api';

export default function ExchangeMarketHeader({venue,botRunning=false,actions}:{venue:ExchangeVenue;botRunning?:boolean;actions?:ReactNode}){
  const {data,connected}=useExchangeStream(venue);
  const instrumentId=useExchangeInstrument(),instrument=instrumentDetails(instrumentId);
  const {markets,error:marketError,loading,retry}=useExchangeMarkets(venue);
  const [search,setSearch]=useState('');
  const [pickerOpen,setPickerOpen]=useState(false);
  const quoteState=useMarketQuotes(venue,pickerOpen);
  const [sort,setSort]=useState<{key:'symbol'|'price'|'percentage'|'quoteVolume';descending:boolean}>({key:'quoteVolume',descending:true});
  const quotes:Record<string,MarketQuote>={...quoteState.quotes};
  if(data?.symbol&&data.market&&connected&&data.streams.market==='live'){
    const snapshot=quotes[data.symbol];
    quotes[data.symbol]={price:data.market.last??snapshot?.price??null,priceSource:data.market.last!=null?'last':snapshot?.priceSource??null,percentage:data.market.percentage??snapshot?.percentage??null,quoteVolume:data.market.quoteVolume??snapshot?.quoteVolume??null};
  }
  const formatPrice=(value:number|null|undefined)=>value==null?'\u2014':new Intl.NumberFormat('en-US',{maximumSignificantDigits:8}).format(value);
  const formatVolume=(value:number|null|undefined)=>value==null?'\u2014':new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:2}).format(value);
  function changeSort(key:typeof sort.key){setSort(old=>({key,descending:old.key===key?!old.descending:key!=='symbol'}));}

  useEffect(()=>setSearch(''),[venue]);
  const searchInput=useRef<HTMLInputElement>(null);
  const visibleMarkets=markets.filter(item=>item.label.toLowerCase().replace(/\s/g,'').includes(search.toLowerCase().replace(/\s/g,''))).sort((a,b)=>{
    if(sort.key==='symbol')return a.base.localeCompare(b.base)*(sort.descending?-1:1);
    const left=quotes[a.id]?.[sort.key],right=quotes[b.id]?.[sort.key];
    if(left==null&&right==null)return a.base.localeCompare(b.base);
    if(left==null)return 1;if(right==null)return -1;
    return (left-right)*(sort.descending?-1:1)||a.base.localeCompare(b.base);
  });
  const exchange=EXCHANGES.find(item=>item.id===venue)!;
  const picker=useRef<HTMLDetailsElement>(null);
  const [switching,setSwitching]=useState(false),[switchError,setSwitchError]=useState('');
  const priceDigits=instrument.id==='stable'?5:3;
  const collateral=venue==='hyperliquid'?'USDC':'USDT';
  const market=data?.market;
  useEffect(()=>{
    const close=(event:PointerEvent)=>{if(picker.current&&!picker.current.contains(event.target as Node))picker.current.open=false;};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&picker.current){picker.current.open=false;picker.current.querySelector('summary')?.focus();}};
    document.addEventListener('pointerdown',close);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',escape);};
  },[]);
  async function changeInstrument(value:ExchangeInstrument){
    if(value===instrumentId||switching||botRunning)return;
    setSwitchError('');
    if(connected){
      setSwitching(true);
      try{
        await api('/api/exchange/reconnect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({venue,instrument:value})});
        reconnectExchangeStream(venue);
        saveExchangeInstrument(value);
      }catch(error){setSwitchError(String(error));}
      finally{setSwitching(false);}
    }else saveExchangeInstrument(value);
  }
  return <MarketHeader
    icon={instrument.icon}
    selector={
      <details className="live-symbol-picker" ref={picker} onToggle={()=>{
        setPickerOpen(!!picker.current?.open);
        if(!picker.current?.open)return;
        if(switching||botRunning){picker.current.open=false;return;}
        setSearch('');searchInput.current?.focus();
      }}>
        <summary aria-label="Select perpetual market" aria-disabled={switching||botRunning}>
          <MarketSymbolLabel base={instrument.base} quote={collateral}/>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5"/></svg>
        </summary>
        <div className="live-symbol-menu live-symbol-quotes-menu">
          <div className="live-symbol-menu-heading"><strong>Markets</strong><span>{exchange.name}</span></div>
          <div className="live-symbol-search"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.5"/><path d="m13 13 4 4" stroke="currentColor" strokeWidth="1.5"/></svg><input ref={searchInput} aria-label="Search perpetual markets" placeholder="Search markets" value={search} onChange={event=>setSearch(event.target.value)}/></div>
          <div className="live-symbol-columns">{([{key:'symbol',label:'Symbol'},{key:'price',label:'Price'},{key:'percentage',label:'24h change'},{key:'quoteVolume',label:'24h volume'}] as const).map(column=><button key={column.key} type="button" className={column.key==='quoteVolume'?'market-volume-column':''} aria-label={`Sort by ${column.label}${sort.key===column.key?sort.descending?', descending':', ascending':''}`} onClick={()=>changeSort(column.key)}>{column.label}{sort.key===column.key&&<span aria-hidden="true">{sort.descending?' \u2193':' \u2191'}</span>}</button>)}</div>
          {loading&&<p className="live-symbol-message" role="status">Loading markets...</p>}
          {marketError&&<div className="live-symbol-message" role="alert"><p>{marketError}</p><button type="button" onClick={retry}>Retry</button></div>}
          <div className="live-symbol-results" role="listbox" aria-label="Perpetual markets">
            {visibleMarkets.map(item=>{
              const quote=quotes[item.id];
              return <button key={item.id} type="button" role="option" aria-selected={item.id===instrumentId||item.base===instrument.base} disabled={switching||botRunning} onClick={()=>{if(picker.current)picker.current.open=false;void changeInstrument(item.id);}}>
                <span className="market-symbol-cell"><strong>{item.base}</strong><small> / {collateral}</small></span>
                <span className="market-price-cell" title={quote?.priceSource==='mark'?'Mark price':quote?.priceSource==='mid'?'Mid price':'Last price'}>{formatPrice(quote?.price)}</span>
                <span className={`market-change-cell ${quote?.percentage==null?'':quote.percentage<0?'is-down':'is-up'}`}>{quote?.percentage==null?'\u2014':`${quote.percentage>=0?'+':''}${quote.percentage.toFixed(2)}%`}</span>
                <span className="market-volume-column market-volume-cell" title={`24h volume in ${collateral}`}>{formatVolume(quote?.quoteVolume)}</span>
              </button>;
            })}
            {!loading&&!marketError&&!visibleMarkets.length&&<p className="live-symbol-message">No markets found for &quot;{search}&quot;</p>}
          </div>
          {!loading&&!marketError&&<div className="live-symbol-menu-footer"><span>{visibleMarkets.length} perpetual markets</span><span title={quoteState.warning??(quoteState.updatedAt?`Snapshot: ${new Date(quoteState.updatedAt).toLocaleTimeString()}`:'')}>{quoteState.loading?'Loading prices...':quoteState.stale?'Delayed quotes':quoteState.warning?'Some quotes unavailable':'Updates every 15s'}</span></div>}
        </div>
      </details>
    }
    price={number(market?.last,priceDigits)}
    quote={collateral}
    metrics={[
      {label:'24h change',value:market?.percentage==null?'\u2014':`${market.percentage>=0?'+':''}${number(market.percentage,2)}%`,tone:(market?.percentage??0)<0?'negative':'positive'},
      {label:'24h high / low',value:`${number(market?.high,priceDigits)} / ${number(market?.low,priceDigits)}`},
      {label:'24h volume',value:number(market?.quoteVolume,0),unit:collateral},
    ]}
    actions={actions}
    notice={(switchError||switching||botRunning)&&<div className={`live-header-notice ${switchError?'negative':''}`} role="status">{switchError|| (switching?'Switching market...':'Stop the bot to change markets.')}</div>}
  />;
}

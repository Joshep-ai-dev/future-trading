import MarketSymbolLabel from '../../shared/ui/MarketSymbolLabel';
import {useEffect,useRef,useState} from 'react';
import {api} from '../../shared/api/api';
import {useExchangeMarkets} from '../../shared/api/exchangeInstrument';
import {notifyMarketDataUpdated} from '../../shared/charts/marketDataRevision';
import {displaySymbol} from '../../shared/charts/displaySymbol';
import type {MarketDataset} from '../../shared/api/useMarketDatasets';
export default function PaperMarketPicker({symbol,market,datasets,disabled,onChange}:{symbol:string;market:string;datasets:MarketDataset[];disabled:boolean;onChange:(market:string)=>void}){
  const picker=useRef<HTMLDetailsElement>(null),input=useRef<HTMLInputElement>(null);
  const [search,setSearch]=useState('');
  const [open,setOpen]=useState(false),[venue,setVenue]=useState<'saved'|'htx'|'hyperliquid'>('saved');
  const [loading,setLoading]=useState(false),[error,setError]=useState('');
  const catalog=useExchangeMarkets(venue==='saved'?'htx':venue,open&&venue!=='saved');
  const options=[{id:'xag',symbol:'XAG/USDT',venue:'OKX',description:'Local history'},{id:'stable',symbol:'STABLE/USDT',venue:'OKX',description:'Local history'},...datasets.map(item=>({id:item.id,symbol:item.symbol,venue:item.venue.toUpperCase(),description:`${item.bars.toLocaleString()} candles - ${item.startDate} to ${item.endDate}`}))];
  const choices=venue==='saved'?options:catalog.markets.map(item=>({id:item.id,symbol:item.id,venue:venue.toUpperCase(),description:'Live public API - virtual funds'}));
  const filtered=choices.filter(item=>`${item.symbol} ${item.venue}`.toLowerCase().includes(search.toLowerCase().trim()));
  useEffect(()=>{
    const outside=(event:PointerEvent)=>{if(picker.current&&!picker.current.contains(event.target as Node))picker.current.open=false;};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&picker.current?.open){picker.current.open=false;picker.current.querySelector('summary')?.focus();}};
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
  },[]);
  async function choose(item:typeof options[number]){
    if(venue==='saved'){onChange(item.id);if(picker.current)picker.current.open=false;return;}
    setLoading(true);setError('');
    try{
      const result=await api<MarketDataset>('/api/market/datasets/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({venue,symbol:item.symbol})});
      notifyMarketDataUpdated();onChange(result.id);if(picker.current)picker.current.open=false;
    }catch(reason){setError(String(reason));}finally{setLoading(false);}
  }
  const [base,quote]=displaySymbol(symbol).split('/');
  return <details ref={picker} className="live-symbol-picker paper-market-picker" onToggle={()=>{setOpen(!!picker.current?.open);if(!picker.current?.open)return;if(disabled){picker.current.open=false;return;}setSearch('');input.current?.focus();}}>
    <summary aria-label="Select paper market" aria-disabled={disabled}><MarketSymbolLabel base={base} quote={quote}/><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5"/></svg></summary>
    <div className="live-symbol-menu paper-symbol-menu"><div className="live-symbol-menu-heading"><strong>Paper markets</strong><span>Public market data</span></div><div className="paper-market-venues" role="group" aria-label="Paper market source">{(['saved','htx','hyperliquid'] as const).map(value=><button key={value} type="button" aria-pressed={venue===value} disabled={loading} onClick={()=>{setVenue(value);setSearch('');setError('');}}>{value==='saved'?'Saved':value==='htx'?'HTX':'Hyperliquid'}</button>)}</div><div className="live-symbol-search"><input ref={input} aria-label="Search paper markets" placeholder="Search symbol or exchange" value={search} onChange={event=>setSearch(event.target.value)}/></div><div className="live-symbol-results" role="listbox" aria-label="Paper markets">{filtered.map(item=><button key={item.id} type="button" role="option" aria-selected={market===item.id} disabled={disabled||loading} onClick={()=>void choose(item)}><span className="paper-market-option"><span><strong>{displaySymbol(item.symbol)}</strong><small>{item.venue}</small></span><small>{item.description}</small></span>{market===item.id&&<span className="paper-market-selected" aria-hidden="true">&#10003;</span>}</button>)}{!filtered.length&&<p className="live-symbol-message">{catalog.loading&&venue!=='saved'?'Loading public markets...':'No markets found.'}</p>}</div><div className="live-symbol-menu-footer">{loading?'Loading recent exchange candles...':error|| (venue!=='saved'&&catalog.error)||'HTX and Hyperliquid sync automatically. No live API credentials required.'}</div></div>
  </details>;
}

import {useCallback,useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {api} from './api';
import Tabs,{type Page} from './Tabs';
import BacktestPanel from './BacktestPanel';
import MarketStatus from './MarketStatus';
import './style.css';

type Range={startDate:string;endDate:string};
function App() {
  const [page,setPage]=useState<Page>('paper');
  const [range,setRange]=useState<Range|null>(null),[error,setError]=useState('');
  const loadRange=useCallback(async()=>{
    try{setRange(await api<Range>('/api/data-range'));setError('');}
    catch(e){setError(String(e));}
  },[]);
  useEffect(()=>{void loadRange();},[loadRange]);
  function navigate(next:Page){setPage(next);window.scrollTo({top:0});}
  return <main><header><div><small>OKX | XAG-USDT-SWAP</small><h1>BB Outer Band Reversal + Trailing SL</h1><p>Configure the strategy, inspect backtest results, or run a virtual bot.</p></div><span className="badge">Virtual trading</span></header>
    <Tabs value={page} onChange={navigate}/>
    <MarketStatus onUpdated={()=>void loadRange()}/>
    {error&&<p className="error" role="alert">{error}</p>}
    {range?<BacktestPanel range={range} view={page} onViewChange={navigate}/>:<p role="status">Loading market history...</p>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);

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
  return <main className="app-shell"><header className="app-header"><a className="brand" href="#" onClick={e=>{e.preventDefault();navigate('paper');}} aria-label="Silver terminal home"><span className="brand-mark"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 16l5-7 5 4 6-9M4 21h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg></span><span>SILVER<span className="brand-sub">TERMINAL</span></span></a>
    <Tabs value={page} onChange={navigate}/><div className="header-account"><span className="paper-badge">PAPER ACCOUNT</span><span className="avatar" title="Local virtual trading account">S</span></div></header>
    <MarketStatus onUpdated={()=>void loadRange()}/>
    {error&&<p className="error" role="alert">{error}</p>}
    {range?<BacktestPanel range={range} view={page} onViewChange={navigate}/>:<p role="status">Loading market history...</p>}
    <footer className="app-footer"><span><i className="status-dot"/> LOCAL WORKSPACE</span><span>OKX · XAG / USDT perpetual</span><span>Virtual funds · Candle-based execution</span></footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);

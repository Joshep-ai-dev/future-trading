import {useCallback,useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {api} from './api';
import type {Page} from './Tabs';
import AppHeader from './components/AppHeader';
import BacktestPanel from './BacktestPanel';
import MarketStatus from './MarketStatus';
import {useExchangeVenue} from './exchangeVenue';
import './style.css';

type Range={startDate:string;endDate:string};
function App() {
  const [page,setPage]=useState<Page>('paper');
  const [accountMode,setAccountMode]=useState<'live'|'paper'>(()=>{try{return localStorage.getItem('silver.account.mode')==='live'?'live':'paper';}catch{return 'paper';}});
  const exchangeVenue=useExchangeVenue();
  const [range,setRange]=useState<Range|null>(null),[error,setError]=useState('');
  const loadRange=useCallback(async()=>{
    try{setRange(await api<Range>('/api/data-range'));setError('');}
    catch(e){setError(String(e));}
  },[]);
  useEffect(()=>{void loadRange();},[loadRange]);
  function navigate(next:Page){setPage(next);window.scrollTo({top:0});}
  function changeAccountMode(mode:'live'|'paper'){setAccountMode(mode);try{localStorage.setItem('silver.account.mode',mode);}catch{/* Account mode remains available for this session. */}}
  return <main className="app-shell"><AppHeader page={page} onNavigate={navigate} accountMode={accountMode} onModeChange={changeAccountMode}/>
    {page!=='account'&&!(page==='paper'&&accountMode==='live')&&<MarketStatus accountMode={accountMode} onUpdated={()=>void loadRange()}/>}
    {error&&<p className="error" role="alert">{error}</p>}
    {range?<BacktestPanel range={range} view={page} onViewChange={navigate} accountMode={accountMode} onAccountModeChange={changeAccountMode}/>:<p role="status">Loading market history...</p>}
    <footer className="app-footer"><span><i className="status-dot"/> LOCAL WORKSPACE</span><span>{accountMode==='live'?exchangeVenue.toUpperCase():'OKX'} · XAG / USDT perpetual</span><span>{accountMode==='live'?'Exchange market stream · Real account':'Virtual funds · Candle-based execution'}</span></footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);

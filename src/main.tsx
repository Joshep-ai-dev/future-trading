import {useCallback,useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {api} from './shared/api/api';
import type {Page} from './app/Tabs';
import AppHeader from './app/layout/AppHeader';
import BacktestPanel from './app/BacktestPanel';
import MarketStatus from './shared/ui/MarketStatus';
import AuthScreen,{type SignedInUser} from './features/auth/AuthScreen';
import {useExchangeVenue} from './shared/api/exchangeVenue';
import './style.css';

type Range={startDate:string;endDate:string};
function App({user,onSignedOut}:{user:SignedInUser;onSignedOut:()=>void}) {
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
  async function signOut(){await api('/api/auth/sign-out',{method:'POST'});onSignedOut();}
  return <main className="app-shell"><AppHeader page={page} onNavigate={navigate} accountMode={accountMode} onModeChange={changeAccountMode} user={user} onSignOut={()=>void signOut()}/>
    {page!=='account'&&!(page==='paper'&&accountMode==='live')&&<MarketStatus accountMode={accountMode} onUpdated={()=>void loadRange()}/>}
    {error&&<p className="error" role="alert">{error}</p>}
    {range?<BacktestPanel range={range} view={page} onViewChange={navigate} accountMode={accountMode} onAccountModeChange={changeAccountMode}/>:<p role="status">Loading market history...</p>}
    <footer className="app-footer"><span><i className="status-dot"/> LOCAL WORKSPACE</span><span>{accountMode==='live'?exchangeVenue.toUpperCase():'OKX'} · XAG / USDT perpetual</span><span>{accountMode==='live'?'Exchange market stream · Real account':'Virtual funds · Candle-based execution'}</span></footer>
  </main>;
}
function Root(){
  const [auth,setAuth]=useState<{configured:boolean;available:boolean;error:string|null;user:SignedInUser|null}|null>(null);
  useEffect(()=>{void api<{configured:boolean;available:boolean;error:string|null;user:SignedInUser|null}>('/api/auth/me').then(setAuth).catch(error=>setAuth({configured:false,available:false,error:String(error),user:null}));},[]);
  if(!auth)return <main className="auth-page"><p role="status">Loading account…</p></main>;
  if(!auth.user)return <AuthScreen configured={auth.configured} databaseError={auth.error} onAuthenticated={user=>setAuth({configured:true,available:true,error:null,user})}/>;
  return <App user={auth.user} onSignedOut={()=>setAuth({configured:true,available:true,error:null,user:null})}/>;
}
createRoot(document.getElementById('root')!).render(<Root/>);

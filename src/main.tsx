import {useCallback,useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {api} from './api';
import Tabs,{type Page} from './Tabs';
import BacktestPanel from './BacktestPanel';
import MarketStatus from './MarketStatus';
import {EXCHANGES,saveExchangeVenue,useExchangeVenue} from './exchangeVenue';
import './style.css';

type Range={startDate:string;endDate:string};
function App() {
  const [page,setPage]=useState<Page>('paper');
  const [accountMode,setAccountMode]=useState<'live'|'paper'>(()=>{try{return localStorage.getItem('silver.account.mode')==='live'?'live':'paper';}catch{return 'paper';}});
  const exchangeVenue=useExchangeVenue();
  const [profileOpen,setProfileOpen]=useState(false);
  const profileRef=useRef<HTMLDivElement>(null);
  const [range,setRange]=useState<Range|null>(null),[error,setError]=useState('');
  const loadRange=useCallback(async()=>{
    try{setRange(await api<Range>('/api/data-range'));setError('');}
    catch(e){setError(String(e));}
  },[]);
  useEffect(()=>{void loadRange();},[loadRange]);
  useEffect(()=>{
    if(!profileOpen)return;
    const outside=(event:PointerEvent)=>{if(!profileRef.current?.contains(event.target as Node))setProfileOpen(false);};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')setProfileOpen(false);};
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
    return ()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
  },[profileOpen]);
  function navigate(next:Page){setPage(next);window.scrollTo({top:0});}
  function changeAccountMode(mode:'live'|'paper'){setAccountMode(mode);try{localStorage.setItem('silver.account.mode',mode);}catch{/* Account mode remains available for this session. */}}
  function menuNavigate(next:Page){setProfileOpen(false);navigate(next);}
  return <main className="app-shell"><header className="app-header"><a className="brand" href="#" onClick={e=>{e.preventDefault();navigate('paper');}} aria-label="Silver terminal home"><span className="brand-mark"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 16l5-7 5 4 6-9M4 21h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg></span><span>SILVER<span className="brand-sub">TERMINAL</span></span></a>
    {page!=='account'&&<Tabs value={page} onChange={navigate}/>}<div className="header-account"><label className="header-exchange-picker"><span>{accountMode==='paper'?'DATA':'EXCHANGE'}</span><select aria-label={accountMode==='paper'?'Paper chart data source':'Selected live exchange'} value={accountMode==='paper'?'local':exchangeVenue} onChange={event=>{if(event.target.value!=='local')saveExchangeVenue(event.target.value as typeof exchangeVenue);}}><optgroup label={accountMode==='paper'?'Paper chart source':'Live execution venue'}>{accountMode==='paper'?<option value="local">Local data</option>:EXCHANGES.map(exchange=><option key={exchange.id} value={exchange.id}>{exchange.name}</option>)}</optgroup>{accountMode==='paper'&&<optgroup label="Live exchange venues (select Live account)" disabled>{EXCHANGES.map(exchange=><option key={exchange.id} value={exchange.id}>{exchange.name}</option>)}</optgroup>}</select></label><label className="header-mode-picker"><span className="sr-only">Account mode</span><select aria-label="Account mode" value={accountMode} onChange={event=>changeAccountMode(event.target.value as 'live'|'paper')}><option value="paper">PAPER ACCOUNT</option><option value="live">LIVE ACCOUNT</option></select></label><div className="profile-menu-anchor" ref={profileRef}><button type="button" className="avatar" title="Open profile menu" aria-label="Open profile menu" aria-haspopup="true" aria-expanded={profileOpen} onClick={()=>setProfileOpen(open=>!open)}>S</button>{profileOpen&&<nav className="profile-menu" aria-label="Workspace navigation"><span className="profile-menu-heading">WORKSPACE MENU</span><div className="profile-menu-mode"><span>SELECTED MODE</span><strong>{accountMode==='paper'?'Paper account':'Live exchange'}</strong></div><div className="profile-menu-divider"/><button type="button" onClick={()=>menuNavigate('account')}>Account settings</button><button type="button" onClick={()=>menuNavigate('strategy')}>Bot settings</button><button type="button" onClick={()=>menuNavigate('paper')}>Trading terminal</button></nav>}</div></div></header>
    {page!=='account'&&!(page==='paper'&&accountMode==='live')&&<MarketStatus accountMode={accountMode} onUpdated={()=>void loadRange()}/>}
    {error&&<p className="error" role="alert">{error}</p>}
    {range?<BacktestPanel range={range} view={page} onViewChange={navigate} accountMode={accountMode} onAccountModeChange={changeAccountMode}/>:<p role="status">Loading market history...</p>}
    <footer className="app-footer"><span><i className="status-dot"/> LOCAL WORKSPACE</span><span>{accountMode==='live'?exchangeVenue.toUpperCase():'OKX'} · XAG / USDT perpetual</span><span>{accountMode==='live'?'Exchange market stream · Real account':'Virtual funds · Candle-based execution'}</span></footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);

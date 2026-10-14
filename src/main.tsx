import {useCallback,useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {api} from './api';
import Tabs,{type Page} from './Tabs';
import BacktestPanel from './BacktestPanel';
import MarketStatus from './MarketStatus';
import './style.css';

type Range={startDate:string;endDate:string};
function App() {
  const [page,setPage]=useState<Page>('paper');
  const [accountMode,setAccountMode]=useState<'live'|'paper'>(()=>{try{return localStorage.getItem('silver.account.mode')==='live'?'live':'paper';}catch{return 'paper';}});
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
    {page!=='account'&&<Tabs value={page} onChange={navigate}/>}<div className="header-account"><span className="paper-badge" role="status">{accountMode==='paper'?'PAPER ACCOUNT':'LIVE ACCOUNT'}</span><div className="profile-menu-anchor" ref={profileRef}><button type="button" className="avatar" title="Open profile menu" aria-label="Open profile menu" aria-haspopup="true" aria-expanded={profileOpen} onClick={()=>setProfileOpen(open=>!open)}>S</button>{profileOpen&&<nav className="profile-menu" aria-label="Workspace navigation"><span className="profile-menu-heading">WORKSPACE MENU</span><div className="profile-menu-mode"><span>SELECTED MODE</span><strong>{accountMode==='paper'?'Paper account':'Live exchange'}</strong></div><div className="profile-menu-divider"/><button type="button" onClick={()=>menuNavigate('account')}>Account &amp; execution</button><button type="button" onClick={()=>menuNavigate('strategy')}>Bot settings</button><button type="button" onClick={()=>menuNavigate('paper')}>Trading terminal</button></nav>}</div></div></header>
    {page!=='account'&&<MarketStatus onUpdated={()=>void loadRange()}/>}
    {error&&<p className="error" role="alert">{error}</p>}
    {range?<BacktestPanel range={range} view={page} onViewChange={navigate} accountMode={accountMode} onAccountModeChange={changeAccountMode}/>:<p role="status">Loading market history...</p>}
    <footer className="app-footer"><span><i className="status-dot"/> LOCAL WORKSPACE</span><span>OKX · XAG / USDT perpetual</span><span>Virtual funds · Candle-based execution</span></footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);

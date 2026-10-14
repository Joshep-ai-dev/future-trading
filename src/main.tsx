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
  function changeAccountMode(mode:'live'|'paper'){setAccountMode(mode);try{localStorage.setItem('silver.account.mode',mode);}catch{/* Account mode remains available for this session. */}setProfileOpen(false);navigate('account');}
  return <main className="app-shell"><header className="app-header"><a className="brand" href="#" onClick={e=>{e.preventDefault();navigate('paper');}} aria-label="Silver terminal home"><span className="brand-mark"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 16l5-7 5 4 6-9M4 21h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg></span><span>SILVER<span className="brand-sub">TERMINAL</span></span></a>
    {page!=='account'&&<Tabs value={page} onChange={navigate}/>}<div className="header-account" ref={profileRef}><button type="button" className="paper-badge account-mode-badge" aria-haspopup="menu" aria-expanded={profileOpen} onClick={()=>setProfileOpen(open=>!open)}>{accountMode==='paper'?'PAPER ACCOUNT':'LIVE ACCOUNT'} <span aria-hidden="true">⌄</span></button><button type="button" className="avatar" title="Open profile menu" aria-label="Open profile menu" aria-expanded={profileOpen} onClick={()=>setProfileOpen(open=>!open)}>S</button>{profileOpen&&<div className="profile-menu" role="menu" aria-label="Profile menu"><span className="profile-menu-heading">ACCOUNT MODE</span><label className={accountMode==='paper'?'selected':''}><input type="radio" name="header-account-mode" checked={accountMode==='paper'} onChange={()=>changeAccountMode('paper')}/>Paper account</label><label className={accountMode==='live'?'selected':''}><input type="radio" name="header-account-mode" checked={accountMode==='live'} onChange={()=>changeAccountMode('live')}/>Live exchange</label><div className="profile-menu-divider"/><button type="button" role="menuitem" onClick={()=>{setProfileOpen(false);navigate('account');}}>Account settings</button><button type="button" role="menuitem" onClick={()=>{setProfileOpen(false);navigate('paper');}}>Trading terminal</button></div>}</div></header>
    {page!=='account'&&<MarketStatus onUpdated={()=>void loadRange()}/>}
    {error&&<p className="error" role="alert">{error}</p>}
    {range?<BacktestPanel range={range} view={page} onViewChange={navigate} accountMode={accountMode} onAccountModeChange={changeAccountMode}/>:<p role="status">Loading market history...</p>}
    <footer className="app-footer"><span><i className="status-dot"/> LOCAL WORKSPACE</span><span>OKX · XAG / USDT perpetual</span><span>Virtual funds · Candle-based execution</span></footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);

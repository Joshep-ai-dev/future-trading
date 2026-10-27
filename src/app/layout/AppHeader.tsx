import {useEffect,useRef} from 'react';
import Tabs,{type Page} from '../Tabs';
import {EXCHANGES,saveExchangeVenue,useExchangeVenue} from '../../shared/api/exchangeVenue';
import {defaultInstrumentForVenue,saveExchangeInstrument} from '../../shared/api/exchangeInstrument';
import {SelectMenu} from '../../shared/ui/ui';
import type {SignedInUser} from '../../features/auth/AuthScreen';

export type AccountMode='live'|'paper';
export default function AppHeader({page,onNavigate,accountMode,onModeChange,user,onSignOut}:{page:Page;onNavigate:(page:Page)=>void;accountMode:AccountMode;onModeChange:(mode:AccountMode)=>void;user:SignedInUser;onSignOut:()=>void}){
  const venue=useExchangeVenue();
  const menu=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{
    const close=(event:PointerEvent)=>{if(menu.current?.open&&!menu.current.contains(event.target as Node))menu.current.open=false;};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&menu.current?.open){menu.current.open=false;menu.current.querySelector('summary')?.focus();}};
    document.addEventListener('pointerdown',close);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',escape);};
  },[]);
  const choose=(action:()=>void)=>{if(menu.current)menu.current.open=false;action();};
  return <header className="app-header">
    <div className="header-primary"><a className="brand" href="#" onClick={event=>{event.preventDefault();onNavigate('paper');}} aria-label="Silver terminal home"><span className="brand-mark"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 16l5-7 5 4 6-9M4 21h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg></span><span>SILVER<span className="brand-sub">TRADING WORKSPACE</span></span></a><Tabs value={page} onChange={onNavigate}/></div>
    <div className="header-account">
      <div className="header-context" aria-label="Trading context"><div className="header-exchange-picker"><SelectMenu caption={accountMode==='paper'?'Market source':'Exchange'} label={accountMode==='paper'?'Paper chart data source':'Selected live exchange'} value={accountMode==='paper'?'local':venue} disabled={accountMode==='paper'} options={accountMode==='paper'?[{value:'local',label:'Local history'}]:EXCHANGES.map(exchange=>({value:exchange.id,label:exchange.name}))} onChange={value=>{if(value!=='local'){saveExchangeInstrument(defaultInstrumentForVenue(value));saveExchangeVenue(value);}}}/></div><div className="header-mode-toggle" role="group" aria-label="Account mode">{(['paper','live'] as const).map(mode=><button key={mode} type="button" aria-pressed={accountMode===mode} className={`mode-${mode}`} onClick={()=>onModeChange(mode)}><i aria-hidden="true"/>{mode==='paper'?'Paper':'Live'}</button>)}</div></div>
      <details className="user-menu" ref={menu}><summary aria-label="Open account menu"><span className="user-avatar">{user.displayName.slice(0,1).toUpperCase()}</span><span className="user-identity"><strong>{user.displayName}</strong><small>{user.level}</small></span><span className="user-chevron" aria-hidden="true">⌄</span></summary><div className="user-menu-popover"><div><strong>{user.displayName}</strong><span>{user.email}</span><small>{user.level} account</small></div><button type="button" onClick={()=>choose(()=>onNavigate('account'))}>Account settings</button><button type="button" onClick={()=>choose(onSignOut)}>Sign out</button></div></details>
    </div>
  </header>;
}

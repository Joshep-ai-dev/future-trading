import Tabs,{type Page} from '../Tabs';
import {EXCHANGES,saveExchangeVenue,useExchangeVenue} from '../../shared/api/exchangeVenue';
import {SelectMenu,StatusBadge} from '../../shared/ui/ui';
import type {SignedInUser} from '../../features/auth/AuthScreen';

export type AccountMode='live'|'paper';
export default function AppHeader({page,onNavigate,accountMode,onModeChange,user,onSignOut}:{page:Page;onNavigate:(page:Page)=>void;accountMode:AccountMode;onModeChange:(mode:AccountMode)=>void;user:SignedInUser;onSignOut:()=>void}){
  const venue=useExchangeVenue();
  return <header className="app-header">
    <div className="header-primary"><a className="brand" href="#" onClick={event=>{event.preventDefault();onNavigate('paper');}} aria-label="Silver terminal home"><span className="brand-mark"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 16l5-7 5 4 6-9M4 21h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg></span><span>SILVER<span className="brand-sub">TRADING WORKSPACE</span></span></a><Tabs value={page} onChange={onNavigate}/></div>
    <div className="header-account">
      <div className="header-context" aria-label="Trading context"><div className="header-exchange-picker"><SelectMenu caption={accountMode==='paper'?'Market source':'Exchange'} label={accountMode==='paper'?'Paper chart data source':'Selected live exchange'} value={accountMode==='paper'?'local':venue} disabled={accountMode==='paper'} options={accountMode==='paper'?[{value:'local',label:'Local history'}]:EXCHANGES.map(exchange=>({value:exchange.id,label:exchange.name}))} onChange={value=>{if(value!=='local')saveExchangeVenue(value);}}/></div><div className="header-mode-picker"><SelectMenu caption="Account" label="Account mode" value={accountMode} options={[{value:'paper',label:'Paper account'},{value:'live',label:'Live account'}]} onChange={onModeChange}/></div></div>
      <StatusBadge tone={accountMode==='live'?'warning':'neutral'} dot>{accountMode==='live'?'Real funds':'Simulation'}</StatusBadge>
      <details className="user-menu"><summary aria-label="Open account menu"><span className="user-avatar">{user.displayName.slice(0,1).toUpperCase()}</span><span className="user-identity"><strong>{user.displayName}</strong><small>{user.level}</small></span><span className="user-chevron" aria-hidden="true">⌄</span></summary><div className="user-menu-popover"><div><strong>{user.displayName}</strong><span>{user.email}</span><small>{user.level} account</small></div><button type="button" onClick={()=>onNavigate('account')}>Account settings</button><button type="button" onClick={onSignOut}>Sign out</button></div></details>
    </div>
  </header>;
}

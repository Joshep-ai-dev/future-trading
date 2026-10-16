import Tabs,{type Page} from '../Tabs';
import {EXCHANGES,saveExchangeVenue,useExchangeVenue} from '../exchangeVenue';
import {StatusBadge} from './ui';
import type {SignedInUser} from '../AuthScreen';

export type AccountMode='live'|'paper';
export default function AppHeader({page,onNavigate,accountMode,onModeChange,user,onSignOut}:{page:Page;onNavigate:(page:Page)=>void;accountMode:AccountMode;onModeChange:(mode:AccountMode)=>void;user:SignedInUser;onSignOut:()=>void}){
  const venue=useExchangeVenue();
  return <header className="app-header">
    <a className="brand" href="#" onClick={event=>{event.preventDefault();onNavigate('paper');}} aria-label="Silver terminal home"><span className="brand-mark"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 16l5-7 5 4 6-9M4 21h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg></span><span>SILVER<span className="brand-sub">TRADING WORKSPACE</span></span></a>
    <Tabs value={page} onChange={onNavigate}/>
    <div className="header-account">
      <label className="header-exchange-picker"><span>{accountMode==='paper'?'Market source':'Exchange'}</span><select aria-label={accountMode==='paper'?'Paper chart data source':'Selected live exchange'} value={accountMode==='paper'?'local':venue} disabled={accountMode==='paper'} onChange={event=>saveExchangeVenue(event.target.value as typeof venue)}>{accountMode==='paper'?<option value="local">Local history</option>:EXCHANGES.map(exchange=><option key={exchange.id} value={exchange.id}>{exchange.name}</option>)}</select></label>
      <label className="header-mode-picker"><span className="sr-only">Account mode</span><select aria-label="Account mode" value={accountMode} onChange={event=>onModeChange(event.target.value as AccountMode)}><option value="paper">Paper account</option><option value="live">Live account</option></select></label>
      <StatusBadge tone={accountMode==='live'?'warning':'neutral'}>{accountMode==='live'?'REAL FUNDS':'SIMULATION'}</StatusBadge>
      <div className="user-chip"><span>{user.displayName.slice(0,1).toUpperCase()}</span><div><strong>{user.displayName}</strong><small>{user.level}</small></div><button type="button" onClick={onSignOut}>Sign out</button></div>
    </div>
  </header>;
}

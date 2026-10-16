import {useState} from 'react';
import {CHART_TIME_ZONES,saveChartTimeZone,useChartTimeZone,type ChartTimeZone} from './chartTimeZone';
import LiveExecution from './LiveExecution';
import {Button,PageHeader,Panel,StatusBadge} from './components/ui';
import type {AccountMode} from './components/AppHeader';
import type {BacktestSettings} from './types';

type Section='connections'|'preferences';
function SettingsIcon({section}:{section:Section}){
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">{section==='connections'?<><path d="m9 15 6-6M7 17l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M17 7l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(2 0) scale(.85)"/></>:<><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/></>}</svg>;
}

export default function AccountPage({onBack,settings,accountMode,onAccountModeChange}:{onBack:()=>void;settings:BacktestSettings;accountMode:AccountMode;onAccountModeChange:(mode:AccountMode)=>void}){
  const chartTimeZone=useChartTimeZone();
  const [section,setSection]=useState<Section>('connections');
  return <section id="page-account" className="account-page account-settings-page" role="tabpanel" aria-labelledby="tab-account">
    <PageHeader eyebrow="YOUR WORKSPACE" title="Account settings" actions={<StatusBadge tone={accountMode==='live'?'warning':'neutral'} dot>{accountMode==='live'?'Live account':'Paper account'}</StatusBadge>}/>
    <div className="account-settings-shell">
      <aside className="account-navigation">
        <div className="account-workspace-identity"><span>S</span><div><strong>Silver workspace</strong><small>Local trading terminal</small></div></div>
        <nav aria-label="Account settings sections">{([['connections','Exchange connections'],['preferences','Preferences']] as const).map(([value,label])=><button type="button" key={value} aria-current={section===value?'page':undefined} onClick={()=>setSection(value)}><SettingsIcon section={value}/><span>{label}</span><span aria-hidden="true">›</span></button>)}</nav>
        <div className="account-navigation-footer"><span className="ui-eyebrow">PRIVATE BY DESIGN</span><Button variant="ghost" onClick={onBack}>← Back to trading</Button></div>
      </aside>
      <div className="account-settings-main">
        {section==='connections'?<Panel className="account-connections-surface" title="Exchange connections"><LiveExecution view="account" settings={settings} onOpenTerminal={onBack}/></Panel>:<Panel title="Workspace preferences" className="account-preferences-surface">
          <div className="preference-row"><div><h3>Trading account</h3></div><label className="ui-field"><span className="sr-only">Trading account mode</span><select aria-label="Trading account mode" value={accountMode} onChange={event=>onAccountModeChange(event.target.value as AccountMode)}><option value="paper">Paper account</option><option value="live">Live account</option></select></label></div>
          <div className="preference-row"><div><h3>Chart & trading time zone</h3></div><label className="ui-field"><span className="sr-only">Display and trading time zone</span><select aria-label="Display and trading time zone" value={chartTimeZone} onChange={event=>saveChartTimeZone(event.target.value as ChartTimeZone)}>{CHART_TIME_ZONES.map(zone=><option key={zone.value} value={zone.value}>{zone.label}</option>)}</select></label></div>
          <div className="preferences-footer"><StatusBadge dot tone="positive">Saved automatically</StatusBadge></div>
        </Panel>}
      </div>
    </div>
  </section>;
}

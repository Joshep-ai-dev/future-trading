import {useState} from 'react';
import {CHART_TIME_ZONES,saveChartTimeZone,useChartTimeZone,type ChartTimeZone} from './chartTimeZone';
import LiveExecution from './LiveExecution';
import type {BacktestSettings} from './types';

type AccountMode='live'|'paper';
type AccountSection='execution'|'display';

function AccountPage({onBack,onBotSettings,settings,accountMode,onAccountModeChange}:{onBack:()=>void;onBotSettings:()=>void;settings:BacktestSettings;accountMode:AccountMode;onAccountModeChange:(mode:AccountMode)=>void}){
  const [section,setSection]=useState<AccountSection>('execution');
  const chartTimeZone=useChartTimeZone();
  return <section className="account-page" aria-labelledby="account-page-title">
    <div className="account-page-heading">
      <div><span className="eyebrow">ACCOUNT WORKSPACE</span><h1 id="account-page-title">Account</h1><p>Manage your trading account, execution preferences and display settings.</p></div>
      <button className="secondary" onClick={onBack}>Trading terminal</button>
    </div>
    <div className="account-settings-layout">
      <nav className="account-settings-nav" aria-label="Account settings sections">
        <span className="account-settings-nav-title">SETTINGS</span>
        <button type="button" className={section==='execution'?'selected':''} aria-current={section==='execution'?'page':undefined} onClick={()=>setSection('execution')}><strong>Account &amp; execution</strong><small>Mode, exchange, orders</small></button>
        <button type="button" className={section==='display'?'selected':''} aria-current={section==='display'?'page':undefined} onClick={()=>setSection('display')}><strong>Display preferences</strong><small>Time zone and timestamps</small></button>
        <div className="account-settings-nav-divider"/>
        <button type="button" onClick={onBotSettings}><strong>Bot settings</strong><small>Strategy rules and sizing</small><span aria-hidden="true">↗</span></button>
      </nav>

      <div className="account-settings-content">
        {section==='execution'?<section className="account-preference-card account-execution-card" aria-labelledby="account-execution-title">
          <div className="account-workspace-heading"><div><span className="eyebrow">ACCOUNT MODE</span><h2 id="account-execution-title">Account &amp; execution</h2><p>Choose paper trading or connect a live exchange account.</p></div><div className="account-switch" role="radiogroup" aria-label="Account mode"><label className={accountMode==='paper'?'selected':''}><input type="radio" name="account-mode" value="paper" checked={accountMode==='paper'} onChange={()=>onAccountModeChange('paper')}/><span>Paper account</span></label><label className={accountMode==='live'?'selected':''}><input type="radio" name="account-mode" value="live" checked={accountMode==='live'} onChange={()=>onAccountModeChange('live')}/><span>Live exchange</span></label></div></div>
          {accountMode==='live'?<LiveExecution settings={settings}/>:<div className="account-paper-mode"><div><strong>Paper account is selected</strong><p>Practice with virtual funds in the Trading terminal. No exchange orders are sent from paper mode.</p></div><button className="secondary" onClick={onBack}>Open paper terminal</button></div>}
        </section>:<section className="terminal-panel account-preference-card account-display-card" aria-labelledby="time-preferences-title">
          <div className="account-preference-heading"><span className="account-step">01</span><div><h2 id="time-preferences-title">Display preferences</h2><p>One time zone controls chart candles and all trade timestamps.</p></div></div>
          <label className="account-preference-field single-timezone-field"><span>Display and trading time zone</span><select aria-label="Display and trading time zone" value={chartTimeZone} onChange={event=>saveChartTimeZone(event.target.value as ChartTimeZone)}>{CHART_TIME_ZONES.map(zone=><option key={zone.value} value={zone.value}>{zone.label}</option>)}</select><small>Applies across Trading and Results. It changes timestamp display only; market data and backtest date boundaries remain UTC. Saved in this browser.</small></label>
        </section>}
      </div>
    </div>
  </section>;
}

export default AccountPage;

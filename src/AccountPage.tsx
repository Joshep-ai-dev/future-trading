import {CHART_TIME_ZONES,saveChartTimeZone,useChartTimeZone,type ChartTimeZone} from './chartTimeZone';
import LiveExecution from './LiveExecution';
import type {BacktestSettings} from './types';

type AccountMode='live'|'paper';
function AccountPage({onBack,settings,accountMode,onAccountModeChange}:{onBack:()=>void;settings:BacktestSettings;accountMode:AccountMode;onAccountModeChange:(mode:AccountMode)=>void}){
  const chartTimeZone=useChartTimeZone();
  return <section className="account-page" aria-labelledby="account-page-title">
    <div className="account-page-heading">
      <div><span className="eyebrow">PROFILE · PREFERENCES</span><h1 id="account-page-title">Account</h1><p>Manage display and trade-time preferences for this workspace.</p></div>
      <button className="secondary" onClick={onBack}>Back to terminal</button>
    </div>
    <section className="account-preference-card" aria-labelledby="time-preferences-title">
      <div className="account-preference-heading"><span className="account-step">01</span><div><h2 id="time-preferences-title">Time preferences</h2><p>Choose how chart candles and trade events are displayed across the terminal.</p></div></div>
      <label className="account-preference-field single-timezone-field"><span>Display and trading time zone</span><select aria-label="Display and trading time zone" value={chartTimeZone} onChange={event=>saveChartTimeZone(event.target.value as ChartTimeZone)}>{CHART_TIME_ZONES.map(zone=><option key={zone.value} value={zone.value}>{zone.label}</option>)}</select><small>One setting controls chart candles, crosshairs and every trade timestamp across Trading and Results. Market data and backtest date boundaries remain UTC. Saved in this browser.</small></label>
    </section>
    <section className="account-preference-card account-execution-card" aria-labelledby="account-type-title"><div className="account-workspace-heading"><div><span className="eyebrow">ACCOUNTS</span><h2 id="account-type-title">Account &amp; execution</h2><p>Choose the account used to manage live orders or paper trading.</p></div><div className="account-switch" role="radiogroup" aria-label="Account type"><label className={accountMode==='live'?'selected':''}><input type="radio" name="account-mode" value="live" checked={accountMode==='live'} onChange={()=>onAccountModeChange('live')}/><span>Live exchange</span></label><label className={accountMode==='paper'?'selected':''}><input type="radio" name="account-mode" value="paper" checked={accountMode==='paper'} onChange={()=>onAccountModeChange('paper')}/><span>Paper account</span></label></div></div>{accountMode==='live'?<LiveExecution settings={settings}/>:<div className="account-paper-mode"><div><strong>Paper account</strong><p>Practice with virtual funds in the Trading terminal. No exchange orders are sent.</p></div><button className="secondary" onClick={onBack}>Open Trading terminal</button></div>}</section>
  </section>;
}

export default AccountPage;

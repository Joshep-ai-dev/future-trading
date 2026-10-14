import {CHART_TIME_ZONES,saveChartTimeZone,useChartTimeZone,type ChartTimeZone} from './chartTimeZone';
import LiveExecution from './LiveExecution';
import type {BacktestSettings} from './types';

type AccountMode='live'|'paper';

function AccountPage({onBack,settings,accountMode,onAccountModeChange}:{onBack:()=>void;settings:BacktestSettings;accountMode:AccountMode;onAccountModeChange:(mode:AccountMode)=>void}){
  const chartTimeZone=useChartTimeZone();
  return <section className="account-page" aria-labelledby="account-page-title">
    <div className="account-page-heading">
      <div><span className="eyebrow">PROFILE · PREFERENCES</span><h1 id="account-page-title">Account</h1><p>Manage account access and the time zone used across your workspace.</p></div>
      <button className="secondary" onClick={onBack}>Back to terminal</button>
    </div>
    <section className="account-preference-card account-mode-card" aria-labelledby="account-mode-title">
      <div className="account-preference-heading"><span className="account-step">01</span><div><h2 id="account-mode-title">Account mode</h2><p>Choose whether the terminal uses virtual funds or a connected exchange.</p></div></div>
      <div className="account-switch" role="radiogroup" aria-label="Account mode">
        <label className={accountMode==='paper'?'selected':''}><input type="radio" name="account-mode" value="paper" checked={accountMode==='paper'} onChange={()=>onAccountModeChange('paper')}/><span>Paper account</span><small>Simulated orders</small></label>
        <label className={accountMode==='live'?'selected':''}><input type="radio" name="account-mode" value="live" checked={accountMode==='live'} onChange={()=>onAccountModeChange('live')}/><span>Live exchange</span><small>Real XAG/USDT orders</small></label>
      </div>
    </section>
    <section className="account-preference-card account-display-card" aria-labelledby="time-preferences-title">
      <div className="account-preference-heading"><span className="account-step">02</span><div><h2 id="time-preferences-title">Time zone</h2><p>One preference keeps chart labels and trade history in sync.</p></div></div>
      <label className="account-preference-field single-timezone-field"><span>Display and trading time zone</span><select aria-label="Display and trading time zone" value={chartTimeZone} onChange={event=>saveChartTimeZone(event.target.value as ChartTimeZone)}>{CHART_TIME_ZONES.map(zone=><option key={zone.value} value={zone.value}>{zone.label}</option>)}</select><small>Applies to candles, crosshairs, orders and trade timestamps. Market data and backtest date boundaries remain UTC. Saved in this browser.</small></label>
    </section>
    <section className="account-preference-card account-exchange-card" aria-labelledby="exchange-account-title">
      <div className="account-preference-heading"><span className="account-step">03</span><div><h2 id="exchange-account-title">Exchange connection</h2><p>Connect an exchange API key for live XAG/USDT perpetual trading.</p></div></div>
      <LiveExecution view="account" settings={settings}/>
    </section>
  </section>;
}

export default AccountPage;

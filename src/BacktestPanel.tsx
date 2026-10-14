import {useEffect,useState,type FormEvent} from 'react';
import {api} from './api';
import BBReversalSettings,{bbDefaults} from './BBReversalSettings';
import PaperTrading from './PaperTrading';
import ResultsWorkspace from './ResultsWorkspace';
import AccountPage from './AccountPage';
import LiveExecution from './LiveExecution';
import type {Page} from './Tabs';
import {fmt,type BacktestSettings,type BacktestResult,type FineTuneResult,type TuneMetrics} from './types';

function initial(range:{startDate:string;endDate:string}):BacktestSettings {
  return {bb_reversal:{...bbDefaults},atr_active:false,atr_period:14,atr_multiplier:2,ema_fast:20,ema_slow:50,rsi_period:20,rsi_threshold:50,rsi_active:true,bb_period:20,chartart_stop_pct:1,exit_condition:'none',stop_mode:'trailing',strategy:'bb_outer_reversal',direction_active:true,direction_timeframe:'1h',setup_active:true,setup_timeframe:'15m',entry_active:true,entry_timeframe:'5m',start_date:range.startDate,end_date:range.endDate,capital:2000,tick_size:.01,fee_bps:0,spread:0,slippage:0,funding_bps:0,max_leverage:1,session_start:0,session_end:24,session_timezone:'UTC'};
}
const settingsKey='silver.bb.settings.v1';
type SavedProfile={name:string;settings:BacktestSettings};
function restoreSettings(raw:unknown,range:{startDate:string;endDate:string}){
  const defaults=initial(range);
  try{
    const saved=raw as Partial<BacktestSettings>|null;
    if(!saved||saved.strategy!=='bb_outer_reversal')return defaults;
    const values=Object.fromEntries(Object.entries(defaults).filter(([key,value])=>key!=='bb_reversal'&&typeof saved[key]===typeof value&&(typeof value!=='number'||Number.isFinite(saved[key]))).map(([key])=>[key,saved[key]]));
    const bb=Object.fromEntries(Object.entries(defaults.bb_reversal).filter(([key,value])=>typeof saved.bb_reversal?.[key]===typeof value&&(typeof value!=='number'||Number.isFinite(saved.bb_reversal[key]))).map(([key])=>[key,saved.bb_reversal[key]]));
    const restored={...defaults,...values,bb_reversal:{...defaults.bb_reversal,...bb}};
    if(!/^\d{4}-\d{2}-\d{2}$/.test(restored.start_date)||restored.start_date<range.startDate||restored.start_date>range.endDate)restored.start_date=range.startDate;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(restored.end_date)||restored.end_date<restored.start_date||restored.end_date>range.endDate)restored.end_date=range.endDate;
    return restored;
  }catch{return defaults;}
}
function restore(range:{startDate:string;endDate:string}){
  try{return restoreSettings(JSON.parse(localStorage.getItem(settingsKey)??'null'),range);}
  catch{return initial(range);}
}
export default function BacktestPanel({range,view,onViewChange,accountMode,onAccountModeChange}:{range:{startDate:string;endDate:string};view:Page;onViewChange:(page:Page)=>void;accountMode:'live'|'paper';onAccountModeChange:(mode:'live'|'paper')=>void}) {
  const [settings,setSettings]=useState(()=>restore(range));
  useEffect(()=>{try{localStorage.setItem(settingsKey,JSON.stringify(settings));}catch{/* Storage restrictions must not block trading controls. */}},[settings]);
  const [profiles,setProfiles]=useState<SavedProfile[]>([]);
  const [profileName,setProfileName]=useState('');
  const [selectedProfile,setSelectedProfile]=useState('');
  const [profileBusy,setProfileBusy]=useState(false),[profileMessage,setProfileMessage]=useState('');
  useEffect(()=>{let active=true;api<SavedProfile[]>('/api/profiles').then(value=>{if(active)setProfiles(value.map(profile=>({...profile,settings:restoreSettings(profile.settings,range)})));}).catch(error=>{if(active)setProfileMessage(String(error));});return()=>{active=false;};},[range]);
  async function saveProfile(){
    const name=profileName.trim();
    if(!name)return;
    setProfileBusy(true);setProfileMessage('');
    try{
      const profile=await api<SavedProfile>('/api/profiles',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,settings})});
      setProfiles(old=>{const existing=old.some(item=>item.name.toLocaleLowerCase()===profile.name.toLocaleLowerCase());return existing?old.map(item=>item.name.toLocaleLowerCase()===profile.name.toLocaleLowerCase()?profile:item):[...old,profile].sort((a,b)=>a.name.localeCompare(b.name));});
      setSelectedProfile(profile.name);setProfileName(profile.name);setProfileMessage(`Saved to backend database: ${profile.name}`);
    }catch(error){setProfileMessage(String(error));}finally{setProfileBusy(false);}
  }
  function applyProfile(){
    const profile=profiles.find(item=>item.name===selectedProfile);
    if(profile)setSettings(restoreSettings(profile.settings,range));
  }
  async function deleteProfile(){
    if(!selectedProfile)return;
    setProfileBusy(true);setProfileMessage('');
    try{
      await api<{deleted:string}>(`/api/profiles?name=${encodeURIComponent(selectedProfile)}`,{method:'DELETE'});
      setProfiles(old=>old.filter(profile=>profile.name!==selectedProfile));
      setSelectedProfile('');setProfileName('');setProfileMessage('Deleted the saved setup from the backend database.');
    }catch(error){setProfileMessage(String(error));}finally{setProfileBusy(false);}
  }
  const [result,setResult]=useState<BacktestResult|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [tuning,setTuning]=useState(false),[tuneError,setTuneError]=useState('');
  const [tuneResult,setTuneResult]=useState<FineTuneResult|null>(null);
  const [section,setSection]=useState('execution');
  const [runId,setRunId]=useState(0);
  async function run(e?:FormEvent){
    e?.preventDefault();setBusy(true);setError('');onViewChange('results');
    try{setResult(await api<BacktestResult>('/api/backtest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(settings)}));setRunId(value=>value+1);}
    catch(e){setError(String(e));}finally{setBusy(false);}
  }
  async function runFineTune(){
    setTuning(true);setTuneError('');setTuneResult(null);
    try{setTuneResult(await api<FineTuneResult>('/api/backtest/fine-tune',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({settings})}));}
    catch(error){setTuneError(String(error));}finally{setTuning(false);}
  }
  function renderTuneMetrics(label:string,metrics:TuneMetrics){
    return <div className="tune-period" key={label}><strong>{label}</strong><span>Win rate <b>{fmt(metrics.winRate)}%</b></span><span>Net P&amp;L <b className={metrics.netPnl>=0?'positive':'negative'}>{metrics.netPnl>=0?'+':''}${fmt(metrics.netPnl)}</b></span><span>Max drawdown <b className="negative">{fmt(Math.abs(metrics.maxDrawdownPct))}%</b></span><span>Average loss <b>{fmt(metrics.averageLossPct)}% of start</b></span><span>Trades <b>{metrics.trades}</b></span></div>;
  }
  const tuneLabels:Record<string,string>={initial_sl:'Initial stop',trail_trigger:'Trail activation',trail_distance:'Trail distance',adx_threshold:'ADX threshold',min_bb_width_pct:'Minimum BB width'};
  const stale=!!result&&Object.keys(settings).some(k=>JSON.stringify(settings[k as keyof BacktestSettings])!==JSON.stringify(result.settings[k as keyof BacktestSettings]));
  function download(){if(!result)return;const url=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='bb-reversal-backtest.json';link.click();URL.revokeObjectURL(url);}
  const chapters=[['execution','Execution & allocation'],['filters','Entry filters'],['stops','Stops & trailing'],['rsi-exit','RSI + price exit'],['trend','Trend adjustment'],['range','Backtest range']];
  return <section className="backtest">
    <PaperTrading settings={settings} onChange={setSettings} onConfigure={()=>onViewChange('strategy')} visible={view==='paper'} accountMode={accountMode} liveControls={<LiveExecution view="terminal" settings={settings} onSettingsChange={setSettings} onConfigure={()=>onViewChange('strategy')} onManageAccount={()=>onViewChange('account')}/>}/>
    {view==='account'&&<AccountPage settings={settings} onBack={()=>onViewChange('paper')} accountMode={accountMode} onAccountModeChange={onAccountModeChange}/>}
    <div id="page-strategy" role="tabpanel" aria-labelledby="tab-strategy" hidden={view!=='strategy'}>
      <div className="workspace-heading"><div><span className="eyebrow">BOT CONFIGURATION</span><h1>Build your trading setup</h1><p>Configure once, then test or trade virtually. Your draft settings are saved in this browser.</p></div><div className="workspace-actions"><button className="secondary" disabled={busy} onClick={()=>setSettings(initial(range))}>Restore defaults</button><button className="secondary" onClick={()=>onViewChange('paper')}>Open terminal</button></div></div>
      <section className="settings-profiles" aria-label="Saved trading bot setups"><div className="profile-description"><strong>Saved bot setups</strong><small>Save named settings in the backend database, then apply them to backtests and paper or live bot configuration.</small></div><div className="profile-actions"><select aria-label="Select saved bot setup" value={selectedProfile} onChange={event=>{setSelectedProfile(event.target.value);setProfileName(event.target.value);}}><option value="">Choose a saved setup</option>{profiles.map(profile=><option key={profile.name} value={profile.name}>{profile.name}</option>)}</select><input aria-label="Setup name" placeholder="Setup name" maxLength={48} value={profileName} onChange={event=>setProfileName(event.target.value)}/><button type="button" className="secondary" disabled={profileBusy||!profileName.trim()} onClick={()=>void saveProfile()}>{profiles.some(profile=>profile.name.toLocaleLowerCase()===profileName.trim().toLocaleLowerCase())?'Save changes':'Save setup'}</button><button type="button" className="secondary" disabled={profileBusy||!selectedProfile} onClick={applyProfile}>Apply</button><button type="button" className="secondary" disabled={profileBusy||!selectedProfile} onClick={()=>void deleteProfile()}>Delete</button></div>{profileMessage&&<small className="profile-message" role="status">{profileMessage}</small>}</section>
      <div className="settings-layout"><aside className="settings-navigation"><div className="configuration-profile"><span className="strategy-icon">BB</span><h2>Outer Band Reversal</h2><p>Trailing stop loss</p><span className="paper-badge">BOTH DIRECTIONS</span></div>
        <nav aria-label="Settings sections">{chapters.map(([key,label],i)=><button key={key} className={section===key?'current':''} onClick={()=>{setSection(key);document.getElementById(`settings-${key}`)?.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});}}><span>0{i+1}</span>{label}</button>)}</nav>
        <div className="configuration-summary"><span className="eyebrow">YOUR CONFIGURATION</span><dl><div><dt>Timeframe</dt><dd>{settings.entry_timeframe.toUpperCase()}</dd></div><div><dt>Leverage</dt><dd>{settings.max_leverage}x</dd></div><div><dt>Trade amount</dt><dd>{settings.bb_reversal.amount_unit==='percent'?`${settings.bb_reversal.amount_per_trade}%`:`$${fmt(settings.bb_reversal.amount_per_trade)}`}</dd></div><div><dt>SMA adjustment</dt><dd>{settings.bb_reversal.use_sma_trend_adjustment?'On':'Off'}</dd></div></dl></div>
      </aside><form className="configuration-form" onSubmit={run}><fieldset disabled={busy||tuning}>
        <BBReversalSettings settings={settings} onChange={setSettings}/>
        <section className="settings-section" id="settings-range"><div className="section-heading"><h3>Backtest range & account</h3><span className="paper-badge">SINGLE PERIOD</span></div><div className="settings-grid"><label>Starting balance ($)<input type="number" required min={1} max={1e9} step="any" value={settings.capital} onChange={e=>setSettings({...settings,capital:Number(e.target.value)})}/></label>
          {(['start_date','end_date'] as const).map((key,i)=><label key={key}>{['Start date (UTC)','End date (UTC, inclusive)'][i]}<input type="date" required min={key==='end_date'?settings.start_date:range.startDate} max={range.endDate} value={settings[key]} onChange={e=>setSettings({...settings,[key]:e.target.value})}/></label>)}
        </div><p className="settings-help">Available: {range.startDate} to {range.endDate}. One account balance runs through the full range. Live and replay dates are configured separately in the terminal.</p></section>
        <div className="configuration-runbar"><div><strong>Ready to test your setup?</strong><small>Changes apply to the next run or new bot session.</small></div><div className="configuration-run-actions"><button type="button" className="secondary" disabled={busy||tuning} onClick={()=>void runFineTune()}>{tuning?'Searching candidates…':'Fine tune settings'}</button><button type="submit" disabled={busy||tuning}>{busy?'Running backtest...':'Run full backtest'}</button></div></div>
      </fieldset>
      {(tuneError||tuneResult)&&<section className="fine-tune-panel" aria-live="polite">{tuneError?<p className="error" role="alert">{tuneError}</p>:tuneResult&&<><div className="fine-tune-heading"><div><h3>Fine tuning results</h3><p>Model: {tuneResult.model}. Evaluated {tuneResult.candidatesEvaluated} candidates, including {tuneResult.seedCandidates} initial and {tuneResult.adaptiveCandidatesEvaluated} ML guided settings. The top {tuneResult.shortlisted} were checked on validation data; the forward test is held out from selection.</p></div><button type="button" onClick={()=>setSettings(tuneResult.bestSettings)}>Apply best settings</button></div><div className="tune-parameters"><strong>Recommended values</strong>{Object.entries(tuneResult.bestParameters).map(([key,value])=><span key={key}>{tuneLabels[key]??key}<b>{typeof value==='number'?fmt(value,3):String(value)}</b></span>)}</div><div className="tune-scorecards">{renderTuneMetrics('Training',tuneResult.periods.train.metrics)}{renderTuneMetrics('Validation',tuneResult.periods.validation.metrics)}{renderTuneMetrics('Forward test',tuneResult.periods.forwardTest.metrics)}</div><small className="settings-help">Ranking objective: {tuneResult.objective} The forward test is historical evidence, not a guarantee of future performance. Consider requiring more trades before using a candidate.</small></>}</section>}
      <details className="execution-notes"><summary>Execution assumptions</summary><p>Signals use completed candles and fill at close. Stops include adverse gaps; trailing stops never loosen. Position notional is allocated amount times leverage. A depleted balance blocks new trades. Costs, session filters and liquidation are not modeled.</p></details></form></div>
    </div>
    {error&&view!=='paper'&&<p className="error" role="alert">{error}</p>}
    <div id="page-results" role="tabpanel" aria-labelledby="tab-results" hidden={view!=='results'}><ResultsWorkspace key={runId} result={result} busy={busy} stale={stale} onRun={()=>void run()} onConfigure={()=>onViewChange('strategy')} onExport={download}/></div>
  </section>;
}

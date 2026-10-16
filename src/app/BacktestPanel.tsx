import {Button,PageHeader} from '../shared/ui/ui';
import {lazy,Suspense,useEffect,useState,type FormEvent} from 'react';
import {api} from '../shared/api/api';
import {htxCostDefaults} from '../features/strategy/executionCostDefaults';
import {bbDefaults} from '../features/strategy/strategyDefaults';
import BBReversalSettings,{Field} from '../features/strategy/BBReversalSettings';

import LiveTrading from '../features/trading/LiveTrading';


import LiveExecution from '../features/trading/LiveExecution';
import type {Page} from './Tabs';
import {fmt,type BacktestSettings,type BacktestResult,type FineTuneCase,type FineTuneResult,type TuneMetrics} from '../shared/types/types';

const PaperTrading=lazy(()=>import('../features/trading/PaperTrading'));
const ResultsWorkspace=lazy(()=>import('../features/research/ResultsWorkspace'));
const AccountPage=lazy(()=>import('../features/account/AccountPage'));


function initial(range:{startDate:string;endDate:string}):BacktestSettings {
  return {bb_reversal:{...bbDefaults},atr_active:false,atr_period:14,atr_multiplier:2,ema_fast:20,ema_slow:50,rsi_period:20,rsi_threshold:50,rsi_active:true,bb_period:20,chartart_stop_pct:1,exit_condition:'none',stop_mode:'trailing',strategy:'bb_outer_reversal',direction_active:true,direction_timeframe:'1h',setup_active:true,setup_timeframe:'15m',entry_active:true,entry_timeframe:'5m',start_date:range.startDate,end_date:range.endDate,capital:2000,tick_size:.01,...htxCostDefaults,max_leverage:1,session_start:0,session_end:24,session_timezone:'UTC'};
}
const settingsKey='silver.bb.settings.v2';
type SavedProfile={name:string;settings:BacktestSettings};
function restoreSettings(raw:unknown,range:{startDate:string;endDate:string}){
  const defaults=initial(range);
  try{
    const saved=raw as Partial<BacktestSettings>|null;
    if(!saved||saved.strategy!=='bb_outer_reversal')return defaults;
    const savedValues=saved as Record<string,unknown>;
    const savedBb=(saved.bb_reversal??{}) as Record<string,unknown>;
    const values=Object.fromEntries(Object.entries(defaults).filter(([key,value])=>key!=='bb_reversal'&&typeof savedValues[key]===typeof value&&(typeof value!=='number'||Number.isFinite(savedValues[key]))).map(([key])=>[key,savedValues[key]]));
    const bb=Object.fromEntries(Object.entries(defaults.bb_reversal).filter(([key,value])=>typeof savedBb[key]===typeof value&&(typeof value!=='number'||Number.isFinite(savedBb[key]))).map(([key])=>[key,savedBb[key]]));
    const restored={...defaults,...values,bb_reversal:{...defaults.bb_reversal,...bb}};
    if(!/^\d{4}-\d{2}-\d{2}$/.test(restored.start_date)||restored.start_date<range.startDate||restored.start_date>range.endDate)restored.start_date=range.startDate;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(restored.end_date)||restored.end_date<restored.start_date||restored.end_date>range.endDate)restored.end_date=range.endDate;
    return restored;
  }catch{return defaults;}
}
function restore(range:{startDate:string;endDate:string}){
  try{
    const current=localStorage.getItem(settingsKey);
    const restored=restoreSettings(JSON.parse(current??localStorage.getItem('silver.bb.settings.v1')??'null'),range);
    // One-time migration of the former zero-cost browser default. New intentional
    // zero values and saved named profiles remain unchanged.
    if(current===null&&restored.fee_bps===0&&restored.slippage===0&&restored.spread===0&&restored.funding_bps===0){
      return {...restored,...htxCostDefaults};
    }
    return restored;
  }
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
  async function saveProfile(settingsToSave=settings){
    const name=profileName.trim();
    if(!name){setProfileMessage('Enter a setup name above before saving.');document.querySelector<HTMLInputElement>('[aria-label="Setup name"]')?.focus();return;}
    setProfileBusy(true);setProfileMessage('');
    try{
      const profile=await api<SavedProfile>('/api/profiles',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,settings:settingsToSave})});
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
  const [searchObjective,setSearchObjective]=useState<'profit'|'balanced'>('profit');
  const [tuning,setTuning]=useState(false),[tuneError,setTuneError]=useState('');
  const [tuneResult,setTuneResult]=useState<FineTuneResult|null>(null);
  const [selectedTuneCaseId,setSelectedTuneCaseId]=useState('');
  const [tuneProgress,setTuneProgress]=useState({percent:0,message:''});
  const [runId,setRunId]=useState(0);
  async function run(e?:FormEvent){
    e?.preventDefault();setBusy(true);setError('');onViewChange('results');
    try{setResult(await api<BacktestResult>('/api/backtest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(settings)}));setRunId(value=>value+1);}
    catch(e){setError(String(e));}finally{setBusy(false);}
  }
  async function openRun(id:number){
    setBusy(true);setError('');onViewChange('results');
    try{const opened=await api<BacktestResult>(`/api/backtests/${id}`);setResult(opened);setRunId(value=>value+1);}
    catch(e){setError(String(e));}finally{setBusy(false);}
  }
  async function runFineTune(){
    setTuning(true);setTuneError('');setTuneResult(null);setTuneProgress({percent:0,message:'Connecting to the tuning worker'});
    try{
      const response=await fetch('/api/backtest/fine-tune',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({settings,search_method:'grid',objective:searchObjective})});
      if(!response.ok)throw new Error(`Fine tuning request failed (${response.status})`);
      if(!response.body)throw new Error('Fine tuning progress stream is unavailable.');
      const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',finalResult:FineTuneResult|null=null;
      const receiveLine=(line:string)=>{
        if(!line.trim())return;
        const update=JSON.parse(line);
        if(update.type==='progress')setTuneProgress({percent:update.percent,message:update.message});
        else if(update.type==='result')finalResult=update.result as FineTuneResult;
        else if(update.type==='error')throw new Error(update.detail);
        // Older backend processes return the result as plain JSON instead of a progress event stream.
        else if(update.bestSettings)finalResult=update as FineTuneResult;
      };
      while(true){
        const {done,value}=await reader.read();buffer+=decoder.decode(value??new Uint8Array(),{stream:!done});
        const lines=buffer.split('\n');buffer=lines.pop()??'';
        for(const line of lines)receiveLine(line);
        if(done&&buffer.trim()){receiveLine(buffer);buffer='';}
        if(done)break;
      }
      if(!finalResult)throw new Error('Fine tuning ended before returning a result.');
      setTuneResult(finalResult);
      setSelectedTuneCaseId((finalResult as FineTuneResult).candidates?.[0]?.id??'best');
    }
    catch(error){setTuneError(String(error));}finally{setTuning(false);}
  }
  function renderTuneMetrics(label:string,metrics:TuneMetrics){
    return <div className="tune-period" key={label}><strong>{label}</strong><span>Win rate <b>{fmt(metrics.winRate)}%</b></span><span>Average winner <b>${fmt(metrics.averageWin??null)}</b></span><span>Average loser <b>${fmt(metrics.averageLoss??null)}</b></span><span>Winner / loser size <b>{fmt(metrics.payoffRatio??null)}×</b></span><span>Losing trades <b>{metrics.losses}</b></span><span>Net P&amp;L <b className={metrics.netPnl>=0?'positive':'negative'}>{metrics.netPnl>=0?'+':''}${fmt(metrics.netPnl)}</b></span><span>Max drawdown <b className="negative">{fmt(Math.abs(metrics.maxDrawdownPct))}%</b></span><span>Average loss <b>{fmt(metrics.averageLossPct)}% of start</b></span><span>Trades <b>{metrics.trades}</b></span></div>;
  }
  const tuneLabels:Record<string,string>={bb_length:'BB length',bb_mult:'BB multiplier',min_bb_width_pct:'Minimum BB width',atr_length:'ATR length',min_atr:'Minimum ATR',adx_length:'ADX length',adx_threshold:'ADX threshold',pullback_bars:'Rebound window',initial_sl:'Initial stop',trail_trigger:'Trail activation',trail_distance:'Trail distance',trail_multiplier:'Trail multiplier',sma_length:'Trend SMA length',use_sma_trend_adjustment:'SMA adjustment',sma_slope_bars:'SMA slope lookback',counter_profit_pct:'Countertrend profit (%)',counter_sl_pct:'Countertrend stop (%)',rsi_exit_enabled:'RSI exit enabled',rsi_exit_length:'Exit RSI length',rsi_exit_move:'RSI exit price move',rsi_exit_short:'Short RSI threshold',rsi_exit_long:'Long RSI threshold',amount_per_trade:'Amount per trade',amount_unit:'Amount unit',leverage:'Leverage'};
  const tuneCases:FineTuneCase[]=tuneResult?.candidates?.length?tuneResult.candidates:tuneResult?[{id:'best',rank:1,bestSettings:tuneResult.bestSettings,bestParameters:tuneResult.bestParameters,periods:{train:{metrics:tuneResult.periods.train.metrics},validation:{metrics:tuneResult.periods.validation.metrics},forwardTest:{metrics:tuneResult.periods.forwardTest.metrics}}}]:[];
  const selectedTuneCase=tuneCases.find(candidate=>candidate.id===selectedTuneCaseId)??tuneCases[0];
  const stale=!!result&&Object.keys(settings).some(k=>JSON.stringify(settings[k as keyof BacktestSettings])!==JSON.stringify(result.settings[k as keyof BacktestSettings]));
  function download(){if(!result)return;const url=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='bb-reversal-backtest.json';link.click();URL.revokeObjectURL(url);}
  return <section className="backtest"><Suspense fallback={<div className="workspace-loading" role="status">Loading workspace...</div>}>
    {accountMode==='live'?(view==='paper'&&<LiveTrading settings={settings} controls={<LiveExecution view="terminal" settings={settings} onSettingsChange={setSettings} onConfigure={()=>onViewChange('strategy')} onManageAccount={()=>onViewChange('account')}/>}/>):<PaperTrading settings={settings} onChange={setSettings} onConfigure={()=>onViewChange('strategy')} visible={view==='paper'}/>}

    {view==='account'&&<AccountPage settings={settings} onBack={()=>onViewChange('paper')} accountMode={accountMode} onAccountModeChange={onAccountModeChange}/>}
    {view==='strategy'&&<div id="page-strategy" className="setup-page" role="tabpanel" aria-labelledby="tab-strategy">
      <PageHeader eyebrow="BB OUTER BAND REVERSAL" title="Bot settings" description="Set how the bot sizes, enters and exits trades. Changes apply to the next backtest or new bot session." actions={<><Button variant="ghost" disabled={busy} onClick={()=>setSettings(initial(range))}>Restore defaults</Button><Button variant="secondary" onClick={()=>onViewChange('paper')}>Open terminal</Button></>}/>
      <form className="setup-layout" onSubmit={run}>
        <fieldset className="setup-main" disabled={busy||tuning}>
          <BBReversalSettings settings={settings} onChange={setSettings}/>
          <details className="setup-assumptions"><summary>How the simulation works</summary><p>Signals use completed candles and fill at close. Stops include adverse gaps; trailing stops never loosen. Position size is the allocated amount times leverage. A depleted balance blocks new trades. Fees, slippage, spread and prorated funding are included; liquidation is not modeled.</p></details>
        </fieldset>
        <aside className="setup-aside" aria-label="Setup summary">
          <section className="setup-summary">
            <h2>Your setup</h2>
            <dl>
              <div><dt>Timeframe</dt><dd>{settings.entry_timeframe}</dd></div>
              <div><dt>Per trade</dt><dd>{settings.bb_reversal.amount_unit==='percent'?`${settings.bb_reversal.amount_per_trade}% of balance`:`$${fmt(settings.bb_reversal.amount_per_trade)}`}</dd></div>
              <div><dt>Leverage</dt><dd>{settings.max_leverage}×</dd></div>
              <div><dt>Stop / trail</dt><dd>{settings.bb_reversal.initial_sl} / {settings.bb_reversal.trail_distance}</dd></div>
              <div><dt>Trend adjustment</dt><dd>{settings.bb_reversal.use_sma_trend_adjustment?'On':'Off'}</dd></div>
              <div><dt>RSI exit</dt><dd>{settings.bb_reversal.rsi_exit_enabled?'On':'Off'}</dd></div>
            </dl>
          </section>
          <section className="setup-summary" id="settings-range">
            <h2>Backtest period</h2>
            <fieldset disabled={busy||tuning} className="setup-range">
              <Field label="Starting balance" unit="USD"><input type="number" required min={1} max={1e9} step="any" value={settings.capital} onChange={e=>setSettings({...settings,capital:Number(e.target.value)})}/></Field>
              <div className="setup-dates">{(['start_date','end_date'] as const).map((key,i)=><Field key={key} label={['From (UTC)','To (UTC)'][i]}><input type="date" required min={key==='end_date'?settings.start_date:range.startDate} max={range.endDate} value={settings[key]} onChange={e=>setSettings({...settings,[key]:e.target.value})}/></Field>)}</div>
              <small className="setup-note">History available {range.startDate} → {range.endDate}.</small>
            </fieldset>
            <button type="submit" className="setup-run" disabled={busy||tuning}>{busy?'Running backtest…':'Run backtest'}</button>
            <div className="setup-search"><select aria-label="Grid search ranking goal" value={searchObjective} disabled={busy||tuning} onChange={e=>setSearchObjective(e.target.value as 'profit'|'balanced')}><option value="profit">Goal: higher profit</option><option value="balanced">Goal: balanced</option></select><button type="button" className="secondary" disabled={busy||tuning} onClick={()=>void runFineTune()}>{tuning?'Searching…':'Find better settings'}</button></div>
          </section>
          <section className="setup-summary" aria-label="Saved trading bot setups">
            <h2>Saved setups</h2>
            <select aria-label="Select saved bot setup" value={selectedProfile} onChange={event=>{setSelectedProfile(event.target.value);setProfileName(event.target.value);}}><option value="">{profiles.length?'Choose a saved setup':'No saved setups yet'}</option>{profiles.map(profile=><option key={profile.name} value={profile.name}>{profile.name}</option>)}</select>
            <div className="setup-inline-actions"><button type="button" className="secondary" disabled={profileBusy||!selectedProfile} onClick={applyProfile}>Load</button><button type="button" className="secondary danger-text" disabled={profileBusy||!selectedProfile} onClick={()=>void deleteProfile()}>Delete</button></div>
            <div className="setup-save"><input aria-label="Setup name" placeholder="Name this setup" maxLength={48} value={profileName} onChange={event=>setProfileName(event.target.value)}/><button type="button" className="secondary" disabled={profileBusy||!profileName.trim()} onClick={()=>void saveProfile()}>{profiles.some(profile=>profile.name.toLocaleLowerCase()===profileName.trim().toLocaleLowerCase())?'Update':'Save'}</button></div>
            {profileMessage&&<small className="setup-note" role="status">{profileMessage}</small>}
          </section>
        </aside>
      </form>
      {(tuning||tuneError||tuneResult)&&<section className="fine-tune-panel" aria-live="polite">
        {tuning&&<div className="tune-progress"><div className="tune-progress-heading"><strong>{tuneProgress.message||'Preparing fine tuning'}</strong><span>{tuneProgress.percent}%</span></div><div className="tune-progress-track"><span style={{width:`${tuneProgress.percent}%`}}/></div><small>Evaluating every grid combination on training and validation data. Forward test is reserved for reporting.</small></div>}
        {tuneError&&<p className="error" role="alert">{tuneError}</p>}
        {tuneResult&&selectedTuneCase&&<>
          <div className="fine-tune-heading"><div><h3>Historical search results</h3><p>Model: {tuneResult.model}. Evaluated {tuneResult.candidatesEvaluated} strategy candidates, including {tuneResult.adaptiveCandidatesEvaluated} ML guided settings. {tuneResult.searchMethod==='grid'?'Every combination was evaluated. Allocation, leverage, dates and costs stay as configured.':`Model cross-validation RMSE: ${fmt(tuneResult.modelCrossValidationRmse??0,3)}.`}</p></div></div>
          {tuneResult.gridAxes&&<details className="tune-model-details"><summary>Grid values searched</summary><div>{Object.entries(tuneResult.gridAxes).map(([name,values])=><span key={name}>{tuneLabels[name]??name}<b>{values.join(' / ')}</b></span>)}</div></details>}<div className="tune-case-picker"><label htmlFor="fine-tune-case">Select a candidate</label><select id="fine-tune-case" value={selectedTuneCase.id} onChange={event=>setSelectedTuneCaseId(event.target.value)}>{tuneCases.map(candidate=><option key={candidate.id} value={candidate.id}>Case {candidate.rank} · validation {fmt(candidate.periods.validation.metrics.winRate)}% win rate · {candidate.periods.validation.metrics.netPnl>=0?'+':''}${fmt(candidate.periods.validation.metrics.netPnl)} P&amp;L</option>)}</select><small>Cases are ranked by validation performance. Forward-test results are shown for comparison; choosing based on them can overfit that period.</small></div>
          <div className="fine-tune-heading tune-selected-heading"><div><h3>Selected case {selectedTuneCase.rank}</h3><p>Compare each case, then apply or save the selected settings using the setup name above.</p></div><div className="tune-result-actions"><button type="button" className="secondary" onClick={()=>setSettings(selectedTuneCase.bestSettings)}>Apply selected settings</button><button type="button" disabled={profileBusy||!profileName.trim()} onClick={()=>void saveProfile(selectedTuneCase.bestSettings)}>Save selected setup</button></div></div>
          {selectedTuneCase.periods.validation.metrics.netPnl<=0&&<p className="error">This candidate lost money in validation. It is a search result, not a profitable recommendation.</p>}<div className="tune-parameters"><strong>Selected candidate parameters</strong>{Object.entries(selectedTuneCase.bestParameters).map(([key,value])=><span key={key}>{tuneLabels[key]??key}<b>{typeof value==='number'?fmt(value,3):String(value)}</b></span>)}</div>
          <div className="tune-scorecards">{renderTuneMetrics('Training',selectedTuneCase.periods.train.metrics)}{renderTuneMetrics('Validation',selectedTuneCase.periods.validation.metrics)}{renderTuneMetrics('Forward test',selectedTuneCase.periods.forwardTest.metrics)}</div>
          {tuneResult.modelHyperparameters&&<details className="tune-model-details"><summary>Model hyperparameters selected by cross validation</summary><div>{Object.entries(tuneResult.modelHyperparameters).map(([key,value])=><span key={key}>{key.replace(/_/g,' ')} <b>{Array.isArray(value)?value.join(' / '):value}</b></span>)}</div></details>}
          <small className="settings-help">Ranking objective: {tuneResult.objective} Forward-test metrics are historical evidence, not a guarantee of future performance.</small>
        </>}
      </section>}

    </div>}
    {error&&view!=='paper'&&<p className="error" role="alert">{error}</p>}
    {view==='results'&&<div id="page-results" role="tabpanel" aria-labelledby="tab-results" hidden={view!=='results'}><ResultsWorkspace key={runId} result={result} busy={busy} stale={stale} onRun={()=>void run()} onConfigure={()=>onViewChange('strategy')} onExport={download} onOpenRun={id=>void openRun(id)} onApplySettings={()=>{if(result)setSettings(restoreSettings(result.settings,range));}} summary={[['Period (UTC)',`${settings.start_date} → ${settings.end_date}`],['Timeframe',settings.entry_timeframe],['Starting balance',`$${fmt(settings.capital)}`],['Leverage',`${settings.max_leverage}×`],['Per trade',settings.bb_reversal.amount_unit==='percent'?`${settings.bb_reversal.amount_per_trade}% of balance`:`$${fmt(settings.bb_reversal.amount_per_trade)}`]]}/></div>}
  </Suspense></section>;
}

import {Button,PageHeader} from '../shared/ui/ui';
import {lazy,Suspense,useEffect,useRef,useState,type FormEvent} from 'react';
import {api} from '../shared/api/api';
import {htxCostDefaults} from '../features/strategy/executionCostDefaults';
import {STRATEGY_LABELS,bbDefaults,mlDefaults} from '../features/strategy/strategyDefaults';
import BBReversalSettings,{Field} from '../features/strategy/BBReversalSettings';
import MLStrategySettings from '../features/strategy/MLStrategySettings';
import TradingCostsCard from '../features/strategy/TradingCostsCard';

import LiveTrading from '../features/trading/LiveTrading';


import LiveExecution from '../features/trading/LiveExecution';
import type {Page} from './Tabs';
import {fmt,type BacktestSettings,type BacktestResult,type FineTuneCase,type FineTuneResult,type TuneMetrics} from '../shared/types/types';

const PaperTrading=lazy(()=>import('../features/trading/PaperTrading'));
const ResultsWorkspace=lazy(()=>import('../features/research/ResultsWorkspace'));
const AccountPage=lazy(()=>import('../features/account/AccountPage'));


function initial(range:{startDate:string;endDate:string}):BacktestSettings {
  return {bb_reversal:{...bbDefaults},ml:{...mlDefaults,models:{...mlDefaults.models},feature_groups:[...mlDefaults.feature_groups]},atr_active:false,atr_period:14,atr_multiplier:2,ema_fast:20,ema_slow:50,rsi_period:20,rsi_threshold:50,rsi_active:true,bb_period:20,chartart_stop_pct:1,exit_condition:'none',stop_mode:'trailing',strategy:'bb_outer_reversal',direction_active:true,direction_timeframe:'1h',setup_active:true,setup_timeframe:'15m',entry_active:true,entry_timeframe:'5m',start_date:range.startDate,end_date:range.endDate,capital:2000,tick_size:.01,...htxCostDefaults,max_leverage:1,session_start:0,session_end:24,session_timezone:'UTC'};
}
const settingsKey='silver.bb.settings.v2';
type SavedProfile={name:string;settings:BacktestSettings};
function restoreSettings(raw:unknown,range:{startDate:string;endDate:string}){
  const defaults=initial(range);
  try{
    const saved=raw as Partial<BacktestSettings>|null;
    if(!saved||(saved.strategy!=='bb_outer_reversal'&&saved.strategy!=='ml_ensemble'))return defaults;
    const savedValues=saved as Record<string,unknown>;
    const savedBb=(saved.bb_reversal??{}) as Record<string,unknown>;
    const values=Object.fromEntries(Object.entries(defaults).filter(([key,value])=>key!=='bb_reversal'&&key!=='ml'&&typeof savedValues[key]===typeof value&&(typeof value!=='number'||Number.isFinite(savedValues[key]))).map(([key])=>[key,savedValues[key]]));
    const bb=Object.fromEntries(Object.entries(defaults.bb_reversal).filter(([key,value])=>typeof savedBb[key]===typeof value&&(typeof value!=='number'||Number.isFinite(savedBb[key]))).map(([key])=>[key,savedBb[key]]));
    const savedMl=(saved.ml??{}) as Record<string,unknown>;
    const ml=Object.fromEntries(Object.entries(defaults.ml).filter(([key,value])=>typeof savedMl[key]===typeof value&&(typeof value!=='number'||Number.isFinite(savedMl[key]))).map(([key])=>[key,savedMl[key]]));
    const restored={...defaults,...values,strategy:saved.strategy,bb_reversal:{...defaults.bb_reversal,...bb},ml:{...defaults.ml,...ml}};
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
  const [searchMethod,setSearchMethod]=useState<'grid'|'ml'>('grid');
  const [validationStart,setValidationStart]=useState(''),[forwardStart,setForwardStart]=useState('');
  const [tuning,setTuning]=useState(false),[tuneError,setTuneError]=useState('');
  const [tuneResult,setTuneResult]=useState<FineTuneResult|null>(null);
  const [selectedTuneCaseId,setSelectedTuneCaseId]=useState('');
  const [tuneProgress,setTuneProgress]=useState({percent:0,message:''});
  const [runId,setRunId]=useState(0);
  async function run(e?:FormEvent,override?:BacktestSettings){
    e?.preventDefault();setBusy(true);setError('');onViewChange('results');
    try{setResult(await api<BacktestResult>('/api/backtest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(override??settings)}));setRunId(value=>value+1);}
    catch(e){setError(String(e));}finally{setBusy(false);}
  }
  async function openRun(id:number){
    setBusy(true);setError('');onViewChange('results');
    try{const opened=await api<BacktestResult>(`/api/backtests/${id}`);setResult(opened);setRunId(value=>value+1);}
    catch(e){setError(String(e));}finally{setBusy(false);}
  }
  const tuneAbort=useRef<AbortController|null>(null);
  async function stopFineTune(){
    setTuneProgress(old=>({...old,message:'Stopping the search…'}));
    try{await api('/api/backtest/fine-tune/stop',{method:'POST'});}catch{/* The stream abort below still ends the request. */}
    tuneAbort.current?.abort();
  }
  async function runFineTune(){
    setTuning(true);setTuneError('');setTuneResult(null);setTuneProgress({percent:0,message:'Connecting to the tuning worker'});
    const abort=new AbortController();tuneAbort.current=abort;
    try{
      const response=await fetch('/api/backtest/fine-tune',{method:'POST',signal:abort.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({settings,search_method:searchMethod,objective:searchObjective,validation_start:validationStart||null,forward_start:forwardStart||null})});
      if(!response.ok)throw new Error(`Fine tuning request failed (${response.status})`);
      if(!response.body)throw new Error('Fine tuning progress stream is unavailable.');
      const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',finalResult:FineTuneResult|null=null;
      const receiveLine=(line:string)=>{
        if(!line.trim())return;
        const update=JSON.parse(line);
        if(update.type==='progress')setTuneProgress({percent:update.percent,message:update.message});
        else if(update.type==='result')finalResult=update.result as FineTuneResult;
        else if(update.type==='error')throw new Error(update.detail);
        else if(update.type==='stopped')throw new DOMException('Search stopped.','AbortError');
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
    catch(error){setTuneError(error instanceof DOMException&&error.name==='AbortError'?'Search stopped. Start it again any time.':String(error));}
    finally{setTuning(false);tuneAbort.current=null;}
  }
  function renderTuneMetrics(label:string,metrics:TuneMetrics){
    return <div className="tune-period" key={label}><strong>{label}</strong><span>Win rate <b>{fmt(metrics.winRate)}%</b></span><span>Average winner <b>${fmt(metrics.averageWin??null)}</b></span><span>Average loser <b>${fmt(metrics.averageLoss??null)}</b></span><span>Winner / loser size <b>{fmt(metrics.payoffRatio??null)}×</b></span><span>Losing trades <b>{metrics.losses}</b></span><span>Net P&amp;L <b className={metrics.netPnl>=0?'positive':'negative'}>{metrics.netPnl>=0?'+':''}${fmt(metrics.netPnl)}</b></span><span>Max drawdown <b className="negative">{fmt(Math.abs(metrics.maxDrawdownPct))}%</b></span><span>Average loss <b>{fmt(metrics.averageLossPct)}% of start</b></span><span>Trades <b>{metrics.trades}</b></span></div>;
  }
  const tuneLabels:Record<string,string>={quality_threshold:'Minimum win chance',tp_quantile:'Target quantile',sl_quantile:'Stop quantile',min_reward_risk:'Min reward/risk',trail_start:'Trailing starts at',horizon:'Horizon (bars)',take_profit_atr:'Take profit (× ATR)',stop_atr:'Stop loss (× ATR)',capacity:'Model capacity',entry_threshold:'Entry probability',min_edge:'Edge over opposite',reverse_on_signal:'Reverse on signal',bb_length:'BB length',bb_mult:'BB multiplier',min_bb_width_pct:'Minimum BB width',atr_length:'ATR length',min_atr:'Minimum ATR',adx_length:'ADX length',adx_threshold:'ADX threshold',pullback_bars:'Rebound window',initial_sl:'Initial stop',trail_trigger:'Trail activation',trail_distance:'Trail distance',trail_multiplier:'Trail multiplier',sma_length:'Trend SMA length',use_sma_trend_adjustment:'SMA adjustment',sma_slope_bars:'SMA slope lookback',counter_profit_pct:'Countertrend profit (%)',counter_sl_pct:'Countertrend stop (%)',rsi_exit_enabled:'RSI exit enabled',rsi_exit_length:'Exit RSI length',rsi_exit_move:'RSI exit price move',rsi_exit_short:'Short RSI threshold',rsi_exit_long:'Long RSI threshold',amount_per_trade:'Amount per trade',amount_unit:'Amount unit',leverage:'Leverage'};
  const tuneCases:FineTuneCase[]=tuneResult?.candidates?.length?tuneResult.candidates:tuneResult?[{id:'best',rank:1,bestSettings:tuneResult.bestSettings,bestParameters:tuneResult.bestParameters,periods:{train:{metrics:tuneResult.periods.train.metrics},validation:{metrics:tuneResult.periods.validation.metrics},forwardTest:{metrics:tuneResult.periods.forwardTest.metrics}}}]:[];
  const selectedTuneCase=tuneCases.find(candidate=>candidate.id===selectedTuneCaseId)??tuneCases[0];
  const stale=!!result&&Object.keys(settings).some(k=>JSON.stringify(settings[k as keyof BacktestSettings])!==JSON.stringify(result.settings[k as keyof BacktestSettings]));
  function download(){if(!result)return;const url=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='bb-reversal-backtest.json';link.click();URL.revokeObjectURL(url);}
  return <section className="backtest"><Suspense fallback={<div className="workspace-loading" role="status">Loading workspace...</div>}>
    {accountMode==='live'?(view==='paper'&&<LiveTrading settings={settings} controls={<LiveExecution view="terminal" settings={settings} onSettingsChange={setSettings} onConfigure={()=>onViewChange('strategy')} onManageAccount={()=>onViewChange('account')} profiles={profiles} onApplySetup={setup=>setSettings(restoreSettings(setup.settings,range))}/>}/>):<PaperTrading profiles={profiles} onApplySetup={setup=>setSettings(restoreSettings(setup.settings,range))} settings={settings} onChange={setSettings} onConfigure={()=>onViewChange('strategy')} visible={view==='paper'}/>}

    {view==='account'&&<AccountPage settings={settings} onBack={()=>onViewChange('paper')} accountMode={accountMode} onAccountModeChange={onAccountModeChange}/>}
    {view==='strategy'&&<div id="page-strategy" className="setup-page" role="tabpanel" aria-labelledby="tab-strategy">
      <PageHeader eyebrow={(STRATEGY_LABELS[settings.strategy]??"").toUpperCase()} title="Bot settings" description="Set how the bot sizes, enters and exits trades. Changes apply to the next backtest or new bot session." actions={<><Button variant="ghost" disabled={busy} onClick={()=>setSettings(initial(range))}>Restore defaults</Button><Button variant="secondary" onClick={()=>onViewChange('paper')}>Open terminal</Button></>}/>
      <form className="setup-layout" onSubmit={run}>
        <fieldset className="setup-main" disabled={busy||tuning}>
          <div className="strategy-picker" role="radiogroup" aria-label="Strategy">{([['bb_outer_reversal','BB Outer Band Reversal','Rule-based: buys and sells Bollinger band rebounds with a trailing stop. Paper and live.'],['ml_ensemble','ML Ensemble','Machine learning: indicator features and an ensemble of models predict the next move. Backtest and paper.']] as const).map(([key,label,text])=><button key={key} type="button" role="radio" aria-checked={settings.strategy===key} onClick={()=>setSettings({...settings,strategy:key})}><span className="strategy-picker-icon" aria-hidden="true">{key==='ml_ensemble'?'ML':'BB'}</span><span><strong>{label}</strong><small>{text}</small></span></button>)}</div>
          {settings.strategy==='ml_ensemble'?<MLStrategySettings settings={settings} onChange={setSettings}/>:<BBReversalSettings settings={settings} onChange={setSettings}/>}
          <TradingCostsCard settings={settings} onChange={setSettings} step={settings.strategy==='ml_ensemble'?8:4}/>
          <details className="setup-assumptions"><summary>How the simulation works</summary><p>Signals use completed candles and fill at close. Stops include adverse gaps; trailing stops never loosen. Position size is the allocated amount times leverage. A depleted balance blocks new trades. Fees, slippage, spread and prorated funding are included; liquidation is not modeled.</p></details>
        </fieldset>
        <aside className="setup-aside" aria-label="Setup summary">
          <section className="setup-summary">
            <h2>Your setup</h2>
            <dl>
              <div><dt>Timeframe</dt><dd>{settings.entry_timeframe}</dd></div>
              <div><dt>Strategy</dt><dd>{STRATEGY_LABELS[settings.strategy]??settings.strategy}</dd></div>
              {settings.strategy==='ml_ensemble'?<>
                <div><dt>Per trade</dt><dd>{settings.ml.amount_unit==='percent'?`${settings.ml.amount_per_trade}% of balance`:`$${fmt(settings.ml.amount_per_trade)}`}</dd></div>
                <div><dt>Leverage</dt><dd>{settings.max_leverage}×</dd></div>
                <div><dt>Models</dt><dd>{Object.values(settings.ml.models).filter(weight=>weight>0).length} active</dd></div>
                <div><dt>Indicator groups</dt><dd>{settings.ml.feature_groups.length}</dd></div>
                <div><dt>Exits</dt><dd>{settings.ml.exit_mode==='learned'?'Learned by the models':`${settings.ml.take_profit_atr} / ${settings.ml.stop_atr} ATR`}</dd></div>
                <div><dt>Regimes traded</dt><dd>{settings.ml.regimes.length===4?'All':settings.ml.regimes.join(', ')}</dd></div>
                <div><dt>Entry probability</dt><dd>{Math.round(settings.ml.entry_threshold*100)}%</dd></div>
              </>:<>
                <div><dt>Per trade</dt><dd>{settings.bb_reversal.amount_unit==='percent'?`${settings.bb_reversal.amount_per_trade}% of balance`:`$${fmt(settings.bb_reversal.amount_per_trade)}`}</dd></div>
                <div><dt>Leverage</dt><dd>{settings.max_leverage}×</dd></div>
                <div><dt>Stop / trail</dt><dd>{settings.bb_reversal.initial_sl} / {settings.bb_reversal.trail_distance}</dd></div>
                <div><dt>Trend adjustment</dt><dd>{settings.bb_reversal.use_sma_trend_adjustment?'On':'Off'}</dd></div>
                <div><dt>RSI exit</dt><dd>{settings.bb_reversal.rsi_exit_enabled?'On':'Off'}</dd></div>
              </>}
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
            <div className="setup-search-panel">
              <span className="setup-label">Find better settings</span>
              <div className="setup-search">
                <select aria-label="Search method" value={searchMethod} disabled={busy||tuning} onChange={e=>setSearchMethod(e.target.value as 'grid'|'ml')}><option value="grid">Grid search</option><option value="ml">{settings.strategy==='ml_ensemble'?'Random search':'ML-guided search'}</option></select>
                <select aria-label="Search ranking goal" value={searchObjective} disabled={busy||tuning} onChange={e=>setSearchObjective(e.target.value as 'profit'|'balanced')}><option value="profit">Goal: profit</option><option value="balanced">Goal: balanced</option></select>
              </div>
              <div className="setup-periods">
                <Field label="Validation from"><input type="date" value={validationStart} min={settings.start_date} max={settings.end_date} disabled={busy||tuning} onChange={e=>setValidationStart(e.target.value)}/></Field>
                <Field label="Forward test from"><input type="date" value={forwardStart} min={validationStart||settings.start_date} max={settings.end_date} disabled={busy||tuning} onChange={e=>setForwardStart(e.target.value)}/></Field>
              </div>
              <small className="setup-note">{validationStart||forwardStart?`Training ${settings.start_date} → ${validationStart||'60%'} · validation → ${forwardStart||'80%'} · forward test → ${settings.end_date}.`:'Empty = automatic 60% training · 20% validation · 20% forward test.'}{(validationStart||forwardStart)&&<button type="button" className="text-button" onClick={()=>{setValidationStart('');setForwardStart('');}}>Reset</button>}</small>
              {tuning?<button type="button" className="secondary danger-text" onClick={()=>void stopFineTune()}>■ Stop search</button>:<button type="button" className="secondary" disabled={busy} onClick={()=>void runFineTune()}>Start search</button>}
              <small className="setup-note">{settings.strategy==='ml_ensemble'?(searchMethod==='grid'?'Retrains the models for 18 exit settings plus capacity checks, then tests 40 entry rules each. Takes several minutes.':'Retrains 24 random model settings and tests 40 entry rules each. Takes several minutes.'):'Ranks on validation data; the last 20% of the range is a forward test.'}</small>
            </div>
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
        {tuneError&&<p className={tuneError.startsWith('Search stopped')?'notice':'error'} role="alert">{tuneError}</p>}
        {tuneResult&&selectedTuneCase&&<>
          <div className="fine-tune-heading"><div><h3>Historical search results</h3><p>Model: {tuneResult.model}. Evaluated {tuneResult.candidatesEvaluated} strategy candidates, including {tuneResult.adaptiveCandidatesEvaluated} ML guided settings. {tuneResult.searchMethod==='grid'?'Every combination was evaluated. Allocation, leverage, dates and costs stay as configured.':`Model cross-validation RMSE: ${fmt(tuneResult.modelCrossValidationRmse??0,3)}.`}</p></div></div>
          {tuneResult.gridAxes&&<details className="tune-model-details"><summary>Grid values searched</summary><div>{Object.entries(tuneResult.gridAxes).map(([name,values])=><span key={name}>{tuneLabels[name]??name}<b>{values.join(' / ')}</b></span>)}</div></details>}<div className="tune-case-picker"><label htmlFor="fine-tune-case">Select a candidate</label><select id="fine-tune-case" value={selectedTuneCase.id} onChange={event=>setSelectedTuneCaseId(event.target.value)}>{tuneCases.map(candidate=><option key={candidate.id} value={candidate.id}>Case {candidate.rank} · validation {fmt(candidate.periods.validation.metrics.winRate)}% win rate · {candidate.periods.validation.metrics.netPnl>=0?'+':''}${fmt(candidate.periods.validation.metrics.netPnl)} P&amp;L</option>)}</select><small>Cases are ranked by validation performance. Forward-test results are shown for comparison; choosing based on them can overfit that period.</small></div>
          <div className="fine-tune-heading tune-selected-heading"><div><h3>Selected case {selectedTuneCase.rank}</h3><p>Compare each case, then apply or save the selected settings using the setup name above.</p>{selectedTuneCase.reliable===false&&<p className="error">Not reliable: this case has too few trades or loses money in training or validation. No candidate passed those checks; widen the date range, use a lower timeframe or loosen the entry filters, then search again.</p>}</div><div className="tune-result-actions"><button type="button" className="secondary" onClick={()=>setSettings(restoreSettings(selectedTuneCase.bestSettings,range))}>Apply selected settings</button><button type="button" disabled={profileBusy||!profileName.trim()} onClick={()=>void saveProfile(selectedTuneCase.bestSettings)}>Save selected setup</button></div></div>
          {selectedTuneCase.periods.validation.metrics.netPnl<=0&&<p className="error">This candidate lost money in validation. It is a search result, not a profitable recommendation.</p>}<div className="tune-parameters"><strong>Selected candidate parameters</strong>{Object.entries(selectedTuneCase.bestParameters).map(([key,value])=><span key={key}>{tuneLabels[key]??key}<b>{typeof value==='number'?fmt(value,3):String(value)}</b></span>)}</div>
          <div className="tune-scorecards">{renderTuneMetrics('Training',selectedTuneCase.periods.train.metrics)}{renderTuneMetrics('Validation',selectedTuneCase.periods.validation.metrics)}{renderTuneMetrics('Forward test',selectedTuneCase.periods.forwardTest.metrics)}</div>
          {tuneResult.modelHyperparameters&&<details className="tune-model-details"><summary>Model hyperparameters selected by cross validation</summary><div>{Object.entries(tuneResult.modelHyperparameters).map(([key,value])=><span key={key}>{key.replace(/_/g,' ')} <b>{Array.isArray(value)?value.join(' / '):value}</b></span>)}</div></details>}
          <small className="settings-help">Ranking objective: {tuneResult.objective} Forward-test metrics are historical evidence, not a guarantee of future performance.</small>
        </>}
      </section>}

    </div>}
    {error&&view!=='paper'&&<p className="error" role="alert">{error}</p>}
    {view==='results'&&<div id="page-results" role="tabpanel" aria-labelledby="tab-results" hidden={view!=='results'}><ResultsWorkspace key={runId} result={result} busy={busy} stale={stale} profiles={profiles} strategy={settings.strategy} onStrategyChange={strategy=>setSettings({...settings,strategy})} onRunSetup={setup=>{const next=restoreSettings(setup.settings,range);setSettings(next);void run(undefined,next);}} onRun={()=>void run()} onConfigure={()=>onViewChange('strategy')} onExport={download} onOpenRun={id=>void openRun(id)} onApplySettings={()=>{if(result)setSettings(restoreSettings(result.settings,range));}} summary={[['Period (UTC)',`${settings.start_date} → ${settings.end_date}`],['Timeframe',settings.entry_timeframe],['Starting balance',`$${fmt(settings.capital)}`],['Leverage',`${settings.max_leverage}×`],['Strategy',STRATEGY_LABELS[settings.strategy]??settings.strategy],['Per trade',(settings.strategy==='ml_ensemble'?settings.ml:settings.bb_reversal).amount_unit==='percent'?`${(settings.strategy==='ml_ensemble'?settings.ml:settings.bb_reversal).amount_per_trade}% of balance`:`$${fmt((settings.strategy==='ml_ensemble'?settings.ml:settings.bb_reversal).amount_per_trade)}`]]}/></div>}
  </Suspense></section>;
}

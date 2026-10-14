import {useEffect,useState,type FormEvent} from 'react';
import {api} from './api';
import BBReversalSettings,{bbDefaults} from './BBReversalSettings';
import PaperTrading from './PaperTrading';
import ResultsWorkspace from './ResultsWorkspace';
import type {Page} from './Tabs';
import {fmt,type BacktestSettings,type BacktestResult} from './types';

function initial(range:{startDate:string;endDate:string}):BacktestSettings {
  return {bb_reversal:{...bbDefaults},atr_active:false,atr_period:14,atr_multiplier:2,ema_fast:20,ema_slow:50,rsi_period:20,rsi_threshold:50,rsi_active:true,bb_period:20,chartart_stop_pct:1,exit_condition:'none',stop_mode:'trailing',strategy:'bb_outer_reversal',direction_active:true,direction_timeframe:'1h',setup_active:true,setup_timeframe:'15m',entry_active:true,entry_timeframe:'5m',start_date:range.startDate,end_date:range.endDate,capital:2000,tick_size:.01,fee_bps:0,spread:0,slippage:0,funding_bps:0,max_leverage:1,session_start:0,session_end:24,session_timezone:'UTC'};
}
const settingsKey='silver.bb.settings.v1';
function restore(range:{startDate:string;endDate:string}){
  const defaults=initial(range);
  try{
    const saved=JSON.parse(localStorage.getItem(settingsKey)??'null');
    if(!saved||saved.strategy!=='bb_outer_reversal')return defaults;
    const values=Object.fromEntries(Object.entries(defaults).filter(([key,value])=>key!=='bb_reversal'&&typeof saved[key]===typeof value&&(typeof value!=='number'||Number.isFinite(saved[key]))).map(([key])=>[key,saved[key]]));
    const bb=Object.fromEntries(Object.entries(defaults.bb_reversal).filter(([key,value])=>typeof saved.bb_reversal?.[key]===typeof value&&(typeof value!=='number'||Number.isFinite(saved.bb_reversal[key]))).map(([key])=>[key,saved.bb_reversal[key]]));
    const restored={...defaults,...values,bb_reversal:{...defaults.bb_reversal,...bb}};
    if(!/^\d{4}-\d{2}-\d{2}$/.test(restored.start_date)||restored.start_date<range.startDate||restored.start_date>range.endDate)restored.start_date=range.startDate;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(restored.end_date)||restored.end_date<restored.start_date||restored.end_date>range.endDate)restored.end_date=range.endDate;
    return restored;
  }catch{return defaults;}
}
export default function BacktestPanel({range,view,onViewChange}:{range:{startDate:string;endDate:string};view:Page;onViewChange:(page:Page)=>void}) {
  const [settings,setSettings]=useState(()=>restore(range));
  useEffect(()=>{try{localStorage.setItem(settingsKey,JSON.stringify(settings));}catch{/* Storage restrictions must not block trading controls. */}},[settings]);
  const [result,setResult]=useState<BacktestResult|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [section,setSection]=useState('execution');
  const [runId,setRunId]=useState(0);
  async function run(e?:FormEvent){
    e?.preventDefault();setBusy(true);setError('');onViewChange('results');
    try{setResult(await api<BacktestResult>('/api/backtest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(settings)}));setRunId(value=>value+1);}
    catch(e){setError(String(e));}finally{setBusy(false);}
  }
  const stale=!!result&&Object.keys(settings).some(k=>JSON.stringify(settings[k as keyof BacktestSettings])!==JSON.stringify(result.settings[k as keyof BacktestSettings]));
  function download(){if(!result)return;const url=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='bb-reversal-backtest.json';link.click();URL.revokeObjectURL(url);}
  const chapters=[['execution','Execution & allocation'],['filters','Entry filters'],['stops','Stops & trailing'],['trend','Trend adjustment'],['range','Backtest range']];
  return <section className="backtest">
    <PaperTrading settings={settings} onChange={setSettings} onConfigure={()=>onViewChange('strategy')} visible={view==='paper'}/>
    <div id="page-strategy" role="tabpanel" aria-labelledby="tab-strategy" hidden={view!=='strategy'}>
      <div className="workspace-heading"><div><span className="eyebrow">BOT CONFIGURATION</span><h1>Build your trading setup</h1><p>Configure once, then test or trade virtually. Your draft settings are saved in this browser.</p></div><div className="workspace-actions"><button className="secondary" disabled={busy} onClick={()=>setSettings(initial(range))}>Restore defaults</button><button className="secondary" onClick={()=>onViewChange('paper')}>Open terminal</button></div></div>
      <div className="settings-layout"><aside className="settings-navigation"><div className="configuration-profile"><span className="strategy-icon">BB</span><h2>Outer Band Reversal</h2><p>Trailing stop loss</p><span className="paper-badge">BOTH DIRECTIONS</span></div>
        <nav aria-label="Settings sections">{chapters.map(([key,label],i)=><button key={key} className={section===key?'current':''} onClick={()=>{setSection(key);document.getElementById(`settings-${key}`)?.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});}}><span>0{i+1}</span>{label}</button>)}</nav>
        <div className="configuration-summary"><span className="eyebrow">YOUR CONFIGURATION</span><dl><div><dt>Timeframe</dt><dd>{settings.entry_timeframe.toUpperCase()}</dd></div><div><dt>Leverage</dt><dd>{settings.max_leverage}x</dd></div><div><dt>Trade amount</dt><dd>{settings.bb_reversal.amount_unit==='percent'?`${settings.bb_reversal.amount_per_trade}%`:`$${fmt(settings.bb_reversal.amount_per_trade)}`}</dd></div><div><dt>SMA adjustment</dt><dd>{settings.bb_reversal.use_sma_trend_adjustment?'On':'Off'}</dd></div></dl></div>
      </aside><form className="configuration-form" onSubmit={run}><fieldset disabled={busy}>
        <BBReversalSettings settings={settings} onChange={setSettings}/>
        <section className="settings-section" id="settings-range"><div className="section-heading"><h3>Backtest range & account</h3><span className="paper-badge">SINGLE PERIOD</span></div><div className="settings-grid"><label>Starting balance ($)<input type="number" required min={1} max={1e9} step="any" value={settings.capital} onChange={e=>setSettings({...settings,capital:Number(e.target.value)})}/></label>
          {(['start_date','end_date'] as const).map((key,i)=><label key={key}>{['Start date (UTC)','End date (UTC, inclusive)'][i]}<input type="date" required min={key==='end_date'?settings.start_date:range.startDate} max={range.endDate} value={settings[key]} onChange={e=>setSettings({...settings,[key]:e.target.value})}/></label>)}
        </div><p className="settings-help">Available: {range.startDate} to {range.endDate}. One account balance runs through the full range. Live and replay dates are configured separately in the terminal.</p></section>
        <div className="configuration-runbar"><div><strong>Ready to test your setup?</strong><small>Changes apply to the next run or new bot session.</small></div><button type="submit" disabled={busy}>{busy?'Running backtest...':'Run full backtest'}</button></div>
      </fieldset><details className="execution-notes"><summary>Execution assumptions</summary><p>Signals use completed candles and fill at close. Stops include adverse gaps; trailing stops never loosen. Position notional is allocated amount times leverage. A depleted balance blocks new trades. Costs, session filters and liquidation are not modeled.</p></details></form></div>
    </div>
    {error&&view!=='paper'&&<p className="error" role="alert">{error}</p>}
    <div id="page-results" role="tabpanel" aria-labelledby="tab-results" hidden={view!=='results'}><ResultsWorkspace key={runId} result={result} busy={busy} stale={stale} onRun={()=>void run()} onConfigure={()=>onViewChange('strategy')} onExport={download}/></div>
  </section>;
}

import {lazy,Suspense,useEffect,useState,type ReactNode} from 'react';
import {PageHeader} from '../shared/ui/ui';
import {htxCostDefaults} from '../features/strategy/executionCostDefaults';
import {adxSupertrendDefaults,bbDefaults,mlDefaults,mlDirectionalDefaults,rlDefaults,STRATEGY_LABELS} from '../features/strategy/strategyDefaults';
import {fmt,type BacktestResult,type BacktestSettings} from '../shared/types/types';
import type {Page} from './Tabs';
import {api} from '../shared/api/api';

const ForecastPage=lazy(()=>import('../features/research/ForecastPage'));
const AccountPage=lazy(()=>import('../features/account/AccountPage'));
const PaperTrading=lazy(()=>import('../features/trading/PaperTrading'));
const LiveTrading=lazy(()=>import('../features/trading/LiveTrading'));
const LiveExecution=lazy(()=>import('../features/trading/LiveExecution'));
const AdxSupertrendSettings=lazy(()=>import('../features/strategy/AdxSupertrendSettings'));
const ResultsWorkspace=lazy(()=>import('../features/research/ResultsWorkspace'));

/** JSON with sorted keys, so key order never matters. */
function canonical(value:unknown):string{
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().filter(key=>(value as Record<string,unknown>)[key]!==undefined).map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}';
  return JSON.stringify(value)??'null';
}
/** The inputs that change an ADX + Supertrend run. Legacy fields the server normalizes are ignored. */
function runKey(value:BacktestSettings){
  const strategy={...adxSupertrendDefaults,...value.adx_supertrend,forecast_owner:undefined};
  return canonical({strategy:value.strategy,timeframe:value.entry_timeframe,start:value.start_date,end:value.end_date,capital:value.capital,
    leverage:value.max_leverage,tick:value.tick_size,fee:value.fee_bps,slippage:value.slippage,spread:value.spread,funding:value.funding_bps,adx_supertrend:strategy});
}

function initial(range: {
  startDate: string;
  endDate: string;
}): BacktestSettings {
  return {
    market: "xag",
    rl: { ...rlDefaults },
    bb_reversal: { ...bbDefaults },
    adx_supertrend: { ...adxSupertrendDefaults },
    ml_directional: { ...mlDirectionalDefaults },
    ml: {
      ...mlDefaults,
      models: { ...mlDefaults.models },
      feature_groups: [...mlDefaults.feature_groups],
    },
    atr_active: false,
    atr_period: 14,
    atr_multiplier: 2,
    ema_fast: 20,
    ema_slow: 50,
    rsi_period: 20,
    rsi_threshold: 50,
    rsi_active: true,
    bb_period: 20,
    chartart_stop_pct: 1,
    exit_condition: "none",
    stop_mode: "trailing",
    strategy: "adx_supertrend",
    direction_active: true,
    direction_timeframe: "1h",
    setup_active: true,
    setup_timeframe: "15m",
    entry_active: true,
    entry_timeframe: "5m",
    start_date: range.startDate,
    end_date: range.endDate,
    capital: 2000,
    tick_size: 0.01,
    ...htxCostDefaults,
    max_leverage: 1,
    session_start: 0,
    session_end: 24,
    session_timezone: "UTC",
  };
}

export default function BacktestPanel({range,view,onViewChange,accountMode,onAccountModeChange}:{range:{startDate:string;endDate:string};view:Page;onViewChange:(page:Page)=>void;accountMode:'live'|'paper';onAccountModeChange:(mode:'live'|'paper')=>void}) {
  const [settings,setSettings]=useState(()=>initial(range));
  const [message,setMessage]=useState('');
  const [stopping,setStopping]=useState(false);
  const [result,setResult]=useState<BacktestResult|null>(null);
  const [busy,setBusy]=useState(false);
  const [runError,setRunError]=useState('');
  const [runId,setRunId]=useState(0);
  async function runBacktest(override?:BacktestSettings){
    const request=override??settings;
    setBusy(true);setRunError('');onViewChange('results');
    try{setResult(await api<BacktestResult>('/api/backtest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)}));setRunId(value=>value+1);}
    catch(error){setRunError(String(error));}finally{setBusy(false);}
  }
  async function openRun(id:number){
    setBusy(true);setRunError('');onViewChange('results');
    try{setResult(await api<BacktestResult>('/api/backtests/'+id));setRunId(value=>value+1);}
    catch(error){setRunError(String(error));}finally{setBusy(false);}
  }
  function exportResult(){
    if(!result)return;
    const url=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download='adx-supertrend-backtest.json';link.click();URL.revokeObjectURL(url);
  }
  const stale=!!result&&runKey(settings)!==runKey(result.settings);
  async function stopAutomation(){
    setStopping(true);setMessage('');
    try{
      const reply=await api<{message?:string}>(accountMode==='live'?'/api/exchange/auto/stop':'/api/paper/pause',{method:'POST'});
      setMessage(reply.message??'Paper session paused.');
    }catch(error){setMessage(String(error));}finally{setStopping(false);}
  }
  // Keep every visited page mounted and only hide the inactive ones, so
  // switching tabs preserves chart viewports, forms and in-progress work.
  const current=view==='paper'?`paper-${accountMode}`:view;
  const [visited,setVisited]=useState<string[]>([current]);
  useEffect(()=>{setVisited(old=>old.includes(current)?old:[...old,current]);},[current]);
  const seen=visited.includes(current)?visited:[...visited,current];
  const keep=(key:string,node:ReactNode)=>seen.includes(key)&&<div key={key} className="kept-page" style={key===current?undefined:{display:'none'}} aria-hidden={key===current?undefined:true}>{node}</div>;
  return <section className="backtest"><Suspense fallback={<div className="workspace-loading" role="status">Loading workspace...</div>}>
    {keep('account',<AccountPage settings={settings} onBack={()=>onViewChange('paper')} accountMode={accountMode} onAccountModeChange={onAccountModeChange}/>)}
    {keep('forecast',<ForecastPage range={range}/>)}
    {keep('paper-live',<LiveTrading settings={settings} controls={<LiveExecution view="terminal" settings={settings} onSettingsChange={setSettings} onConfigure={()=>onViewChange('strategy')} onManageAccount={()=>onViewChange('account')}/>}/>)}
    {keep('paper-paper',<PaperTrading settings={settings} onChange={setSettings} onConfigure={()=>onViewChange('strategy')} visible={current==='paper-paper'} profiles={[]} onApplySetup={()=>{}}/>)}
    {keep('strategy',<div id="page-strategy" role="tabpanel" aria-labelledby="tab-strategy" className="setup-page">
      {settings.strategy==='adx_supertrend'
        ?<AdxSupertrendSettings settings={settings} onChange={setSettings} onRun={()=>void runBacktest()} busy={busy} range={range}/>
        :<button type="button" onClick={()=>setSettings({...settings,strategy:'adx_supertrend'})}>Use ADX + Supertrend</button>}
    </div>)}
    {keep('results',<div id="page-results" role="tabpanel" aria-labelledby="tab-results">
      {runError&&<p className="error" role="alert">{runError}</p>}
      <ResultsWorkspace key={runId} result={result} busy={busy} stale={stale} profiles={[]} strategy={settings.strategy}
        onStrategyChange={strategy=>{if(strategy==='adx_supertrend')setSettings({...settings,strategy});}}
        onRunSetup={()=>void runBacktest()} onRun={()=>void runBacktest()} onConfigure={()=>onViewChange('strategy')}
        onExport={exportResult} onOpenRun={id=>void openRun(id)}
        onApplySettings={()=>{if(result)setSettings({...settings,...result.settings,adx_supertrend:{...adxSupertrendDefaults,...result.settings.adx_supertrend}});}}
        summary={[
          ['Market','XAG / USDT · OKX'],
          ['Period (UTC)',settings.start_date+' → '+settings.end_date],
          ['Timeframe',settings.entry_timeframe],
          ['Starting balance','$'+fmt(settings.capital)],
          ['Leverage',settings.max_leverage+'×'],
          ['Strategy',STRATEGY_LABELS[settings.strategy]??settings.strategy],
          ['Per trade',settings.adx_supertrend.amount_unit==='percent'?settings.adx_supertrend.amount_per_trade+'% of balance':'$'+fmt(settings.adx_supertrend.amount_per_trade)],
        ]}/>
    </div>)}
    {view!=='account'&&view!=='forecast'&&view!=='paper'&&view!=='strategy'&&view!=='results'&&<div id={`page-${view}`} role="tabpanel" aria-labelledby={`tab-${view}`} className="setup-page">
        <PageHeader eyebrow="STRATEGY WORKSPACE" title="No strategy configured" description="All trading strategies have been removed. This workspace is ready for a new implementation."/>
        <p>Strategy settings, backtests and automated trading are unavailable until a new strategy is added.</p>
        <p>Market history, account connections and saved research remain available.</p>
        <button type="button" className="secondary" disabled={stopping} onClick={()=>void stopAutomation()}>{stopping?'Stopping...':accountMode==='live'?'Stop existing live automation':'Pause existing paper session'}</button>
        {message&&<p role="status">{message}</p>}
        <button type="button" className="secondary" onClick={()=>onViewChange('account')}>Account settings</button>
      </div>}
  </Suspense></section>;
}

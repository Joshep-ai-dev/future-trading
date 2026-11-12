import {lazy,Suspense,useState} from 'react';
import {PageHeader} from '../shared/ui/ui';
import {htxCostDefaults} from '../features/strategy/executionCostDefaults';
import {bbDefaults,mlDefaults,mlDirectionalDefaults,rlDefaults} from '../features/strategy/strategyDefaults';
import type {BacktestSettings} from '../shared/types/types';
import type {Page} from './Tabs';
import {api} from '../shared/api/api';

const ForecastPage=lazy(()=>import('../features/research/ForecastPage'));
const AccountPage=lazy(()=>import('../features/account/AccountPage'));

function initial(range: {
  startDate: string;
  endDate: string;
}): BacktestSettings {
  return {
    market: "xag",
    rl: { ...rlDefaults },
    bb_reversal: { ...bbDefaults },
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
    strategy: "none",
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
  const [settings]=useState(()=>initial(range));
  const [message,setMessage]=useState('');
  const [stopping,setStopping]=useState(false);
  async function stopAutomation(){
    setStopping(true);setMessage('');
    try{
      const reply=await api<{message?:string}>(accountMode==='live'?'/api/exchange/auto/stop':'/api/paper/pause',{method:'POST'});
      setMessage(reply.message??'Paper session paused.');
    }catch(error){setMessage(String(error));}finally{setStopping(false);}
  }
  return <section className="backtest"><Suspense fallback={<div className="workspace-loading" role="status">Loading workspace...</div>}>
    {view==='account'?<AccountPage settings={settings} onBack={()=>onViewChange('paper')} accountMode={accountMode} onAccountModeChange={onAccountModeChange}/>
      :view==='forecast'?<ForecastPage range={range}/>
      :<div id={`page-${view}`} role="tabpanel" aria-labelledby={`tab-${view}`} className="setup-page">
        <PageHeader eyebrow="STRATEGY WORKSPACE" title="No strategy configured" description="All trading strategies have been removed. This workspace is ready for a new implementation."/>
        <p>Strategy settings, backtests and automated trading are unavailable until a new strategy is added.</p>
        <p>Market history, account connections and saved research remain available.</p>
        <button type="button" className="secondary" disabled={stopping} onClick={()=>void stopAutomation()}>{stopping?'Stopping...':accountMode==='live'?'Stop existing live automation':'Pause existing paper session'}</button>
        {message&&<p role="status">{message}</p>}
        <button type="button" className="secondary" onClick={()=>onViewChange('account')}>Account settings</button>
      </div>}
  </Suspense></section>;
}

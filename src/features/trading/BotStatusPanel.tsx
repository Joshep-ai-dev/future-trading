import type {StrategyCheck,StrategyState} from '../../shared/api/exchangeTypes';
import {fmt} from '../../shared/types/types';

const statusLabel=(state:StrategyState|null|undefined,running:boolean)=>!running?'Stopped':!state||state.status==='warming_up'?'Warming up':state.status==='position_open'?'In position':'Scanning';
const statusTone=(state:StrategyState|null|undefined,running:boolean)=>!running?'idle':state?.status==='position_open'?'active':state?.status==='scanning'?'scan':'idle';
const checkText=(check:StrategyCheck)=>check.value==null?check.label:`${check.label} ${fmt(check.value,3)}${check.threshold==null?'':` / ${fmt(check.threshold,3)}`}`;

function SideReadiness({side,value,checks,signal}:{side:'long'|'short';value:number;checks:StrategyCheck[];signal:boolean}){
  return <div className={`bot-side bot-side--${side}`}>
    <div className="bot-side-head"><span>{side==='long'?'Buy (long) entry':'Sell (short) entry'}</span>{signal&&<em>Signal</em>}<strong>{value}%</strong></div>
    <div className="bot-side-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-label={`${side} entry readiness`}><i style={{width:`${value}%`}}/></div>
    <ul className="bot-checks">{checks.map(check=><li key={check.label} className={check.passed?'passed':''} title={check.passed?'Condition met':'Waiting for this condition'}><span aria-hidden="true">{check.passed?'✓':'·'}</span>{checkText(check)}</li>)}</ul>
  </div>;
}

/** Strategy readiness card shared by the paper and live terminals. */
export default function BotStatusPanel({state,running,timeLabel,emptyHint}:{state:StrategyState|null|undefined;running:boolean;timeLabel?:string;emptyHint?:string}){
  const close=state?.closeState;
  return <section className="terminal-panel bot-status" aria-label="Bot status">
    <header><h2>Bot status</h2><span className={`bot-status-pill is-${statusTone(state,running)}`}><i aria-hidden="true"/>{statusLabel(state,running)}</span></header>
    {state&&state.longChecks.length?<>
      <p className="bot-status-meta">Last closed candle{timeLabel?` ${timeLabel}`:''}{state.close!=null?` · close ${fmt(state.close,3)}`:''}</p>
      <SideReadiness side="long" value={state.longReadiness} checks={state.longChecks} signal={state.signal==='long'}/>
      <SideReadiness side="short" value={state.shortReadiness} checks={state.shortChecks} signal={state.signal==='short'}/>
      {close&&<div className="bot-status-position"><span className={`side-badge ${close.direction}`}>{close.direction.toUpperCase()}</span><dl><div><dt>Entry</dt><dd>{fmt(close.entryPrice,3)}</dd></div><div><dt>Stop</dt><dd>{fmt(close.stop,3)}</dd></div><div><dt>To stop</dt><dd>{fmt(close.stopDistance,3)}</dd></div><div><dt>Exit mode</dt><dd>{close.trailingActive?'Trailing':'Initial stop'}</dd></div></dl></div>}
      <p className="bot-status-note">Readiness is the share of entry conditions met on the last closed candle, not a win probability.</p>
    </>:<p className="bot-status-empty">{emptyHint??'Start the bot to see live entry readiness.'}</p>}
  </section>;
}

/** Compact readiness badge laid over the price chart. */
export function BotChartBadge({state,running}:{state:StrategyState|null|undefined;running:boolean}){
  if(!running&&!state)return null;
  return <div className="bot-chart-badge" aria-label="Bot status on chart">
    <span className={`bot-status-pill is-${statusTone(state,running)}`}><i aria-hidden="true"/>{statusLabel(state,running)}</span>
    {state&&state.longChecks.length>0&&<><span className="badge-long">Buy {state.longReadiness}%</span><span className="badge-short">Sell {state.shortReadiness}%</span></>}
    {state?.signal&&<span className={`badge-signal ${state.signal}`}>{state.signal==='long'?'Buy signal':'Sell signal'}</span>}
  </div>;
}

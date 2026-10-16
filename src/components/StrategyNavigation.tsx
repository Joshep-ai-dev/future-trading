import type {BacktestSettings} from '../types';
import {fmt} from '../types';
import {StatusBadge} from './ui';

const sections=[
  ['execution','Execution & allocation'],['filters','Entry filters'],['costs','Fees & funding'],
  ['stops','Stops & trailing'],['rsi-exit','RSI + price exit'],['trend','Trend adjustment'],['range','Backtest range'],
] as const;

export default function StrategyNavigation({settings,active,onChange}:{settings:BacktestSettings;active:string;onChange:(section:string)=>void}){
  function select(section:string){
    onChange(section);
    document.getElementById(`settings-${section}`)?.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});
  }
  return <aside className="settings-navigation" aria-label="Strategy configuration">
    <div className="configuration-profile"><span className="strategy-icon">BB</span><h2>Outer Band Reversal</h2><p>Bollinger bands & trailing stops</p><StatusBadge>Strategy configuration</StatusBadge></div>
    <nav aria-label="Settings sections">{sections.map(([key,label],index)=><button key={key} type="button" className={active===key?'current':''} aria-current={active===key?'location':undefined} onClick={()=>select(key)}><span>{String(index+1).padStart(2,'0')}</span>{label}</button>)}</nav>
    <div className="configuration-summary"><span className="ui-eyebrow">CURRENT SETUP</span><dl>
      <div><dt>Timeframe</dt><dd>{settings.entry_timeframe.toUpperCase()}</dd></div>
      <div><dt>Leverage</dt><dd>{settings.max_leverage}x</dd></div>
      <div><dt>Trade amount</dt><dd>{settings.bb_reversal.amount_unit==='percent'?`${settings.bb_reversal.amount_per_trade}%`:`$${fmt(settings.bb_reversal.amount_per_trade)}`}</dd></div>
      <div><dt>Trend adjustment</dt><dd>{settings.bb_reversal.use_sma_trend_adjustment?'Enabled':'Disabled'}</dd></div>
    </dl></div>
  </aside>;
}

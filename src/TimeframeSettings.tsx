import type {BacktestSettings} from './types';
type Stage = 'direction'|'setup'|'entry';
const stages: {key:Stage;label:string;options:string[];description:string}[] = [
  {key:'direction',label:'Direction',options:['15m','30m','1h','4h'],description:'EMA 20 + EMA 50'},
  {key:'setup',label:'Setup',options:['5m','15m','30m','1h'],description:'EMA 20 + EMA 50 + RSI 20'},
  {key:'entry',label:'Entry',options:['1m','3m','5m','15m'],description:'EMA 20 + EMA 50 + RSI 20'},
];
export function effectiveTimeframe(s:BacktestSettings) {
  if(s.strategy==='sweep')return '5m';
  return s.entry_active?s.entry_timeframe:s.setup_active?s.setup_timeframe:s.direction_active?s.direction_timeframe:null;
}
export default function TimeframeSettings({settings,onChange}:{settings:BacktestSettings;onChange:(s:BacktestSettings)=>void}) {
  const tf=effectiveTimeframe(settings);
  return <><div className="timeframe-stages">{stages.map(({key,label,options,description})=>{
    const activeKey=`${key}_active` as const, timeframeKey=`${key}_timeframe` as const;
    return <article key={key} className={`timeframe-stage ${settings[activeKey]?'':'stage-disabled'}`}>
      <div className="stage-heading"><h3>{label}</h3><label className="stage-switch"><input type="checkbox" role="switch" aria-label={`${label} active`} checked={settings[activeKey]} onChange={e=>onChange({...settings,[activeKey]:e.target.checked})}/><span>{settings[activeKey]?'Active':'Disabled'}</span></label></div>
      <label>{label} timeframe<select aria-label={`${label} timeframe`} disabled={!settings[activeKey]} value={settings[timeframeKey]} onChange={e=>onChange({...settings,[timeframeKey]:e.target.value})}>{options.map(t=><option key={t} value={t}>{t.toUpperCase()}</option>)}</select></label>
      <p>{description}</p><small>{key==='direction'?'Long: EMA20 > EMA50 · Short: EMA20 < EMA50':key==='setup'?'EMA direction and RSI above/below 50 must agree.':'Fresh EMA + RSI alignment. Start with 5M; 1M is also available.'}</small>
    </article>;
  })}</div>
    {tf?<p className="execution-summary">Execution: <b>{tf.toUpperCase()}</b> · {settings.entry_active?'Entry':settings.setup_active?'Setup (Entry disabled)':'Direction only'} supplies the signal. All active stages must agree. Disabled stages are ignored.</p>:<p role="alert" className="notice">Activate at least one timeframe to run the strategy.</p>}
    <p>Entry/Setup signal: EMA20 &gt; EMA50 and RSI20 &gt; 50 for long; EMA20 &lt; EMA50 and RSI20 &lt; 50 for short. A signal occurs only when that execution-timeframe condition first becomes true. Other active stages must already confirm on that candle’s close; later confirmation alone does not trigger an entry. With Direction only, EMA alignment supplies the signal.</p>
  </>;
}

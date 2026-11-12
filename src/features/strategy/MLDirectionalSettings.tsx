import {useState} from 'react';
import {api} from '../../shared/api/api';
import {fmt, type BacktestSettings, type MLDirectionalConfig} from '../../shared/types/types';
import {Field, SettingsCard, TIMEFRAME_CHOICES} from './BBReversalSettings';
import {mlDirectionalDefaults} from './strategyDefaults';

type NumKey=Exclude<keyof MLDirectionalConfig,'trade_mode'>;
/** [min, max, step]; mirrors the validation in server/strategies/ml/directional.py. */
const limits:Record<NumKey,[number,number,number]>={
  take_profit_atr:[.1,50,.1],stop_atr:[.1,50,.1],max_hold_bars:[1,2000,1],atr_length:[1,500,1],
  train_days:[7,3650,1],trade_days:[1,365,1],calibration_fraction:[0,.5,.01],
  min_probability:[0,1,.01],trades_per_day:[0,20,.5],min_ev_r:[-10,10,.01],min_gap:[-1,1,.01],vol_low_pct:[0,100,1],vol_high_pct:[0,100,1],
  risk_per_trade_pct:[.01,10,.05],max_drawdown_pct:[0,99,1],
  trees:[10,5000,1],learning_rate:[.001,1,.001],max_depth:[1,16,1],min_leaf:[5,100000,1],seed:[0,2147483647,1],
};
const ADVANCED:NumKey[]=['min_ev_r','min_gap','vol_low_pct','vol_high_pct','max_drawdown_pct','atr_length','train_days','trade_days','calibration_fraction','trees','learning_rate','max_depth','min_leaf','seed'];

type TrainBlock={start:number;end:number;trainRows:number;aucLong:number|null;aucShort:number|null};
type TrainResult={blocks:TrainBlock[];skipped:{start:number;end:number;reason:string}[];trained:number;reused:number;meanAuc:number|null;seconds:number};
const day=(t:number)=>new Date(t*1000).toISOString().slice(5,10);
const auc=(v:number|null)=>v==null?'—':fmt(v,2);

/** Settings for the walk-forward ML Directional strategy (backtest and paper only). */
export default function MLDirectionalSettings({settings,onChange}:{settings:BacktestSettings;onChange:(s:BacktestSettings)=>void}){
  const config=settings.ml_directional;
  const [training,setTraining]=useState(false),[trained,setTrained]=useState<TrainResult|null>(null),[error,setError]=useState('');
  const set=(patch:Partial<MLDirectionalConfig>)=>onChange({...settings,ml_directional:{...config,...patch}});
  const num=(key:NumKey,label:string,hint?:string,unit?:string)=>{
    const [min,max,step]=limits[key];
    return <Field key={key} label={label} hint={hint} unit={unit}><input aria-label={label} type="number" required min={min} max={max} step={step>=1?1:'any'} value={config[key]} onChange={event=>set({[key]:Number(event.target.value)})}/></Field>;
  };
  const changedAdvanced=ADVANCED.filter(key=>config[key]!==mlDirectionalDefaults[key]).length;

  async function train(){
    setTraining(true);setError('');setTrained(null);
    try{
      setTrained(await api<TrainResult>('/api/ml-directional/train',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(settings)}));
    }catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{setTraining(false);}
  }
  const quality=trained?.meanAuc==null?'':trained.meanAuc>=.6?'Useful skill':trained.meanAuc>=.55?'Weak skill':'Close to guessing';

  return <>
    <SettingsCard step={1} title="Train the model" description={`Trains long and short models for every 30-day block from ${settings.start_date} to ${settings.end_date} (set in Backtest period). Each block learns only from the ${config.train_days} days before it. Run backtest reuses these models.`}
      actions={<button type="button" className="setup-run" disabled={training} onClick={()=>void train()}>{training?'Training…':trained?'Train again':'Train model'}</button>}>
      {error&&<p className="error" role="alert">{error}</p>}
      {trained&&<div className="model-report">
        <p className="model-note"><strong>{quality}</strong> · mean AUC {auc(trained.meanAuc)} (0.50 = guessing) · {trained.trained} block(s) trained, {trained.reused} reused · {trained.seconds}s{trained.skipped.length?` · ${trained.skipped.length} block(s) skipped: ${trained.skipped[0].reason}. Start the period at least ${config.train_days} days after the first data.`:''}</p>
        {trained.blocks.length>0&&<table><thead><tr><th>Block</th><th>Trained on</th><th>AUC long</th><th>AUC short</th></tr></thead>
          <tbody>{trained.blocks.map(b=><tr key={b.start}><td>{day(b.start)} → {day(b.end)}</td><td>{b.trainRows.toLocaleString()} candles</td><td>{auc(b.aucLong)}</td><td>{auc(b.aucShort)}</td></tr>)}</tbody></table>}
      </div>}
    </SettingsCard>

    <SettingsCard step={2} id="settings-execution" title="Trade setup" description={`${config.trades_per_day?`Takes about ${config.trades_per_day} trade(s) per day: a candle qualifies when its model score is the best of the last ${Math.round(24/(config.trades_per_day*3))} h, with at most ${Math.ceil(config.trades_per_day)} entr${Math.ceil(config.trades_per_day)===1?'y':'ies'} per UTC day.`:`Enter when the model gives at least a ${Math.round(config.min_probability*100)}% chance of reaching take-profit before stop-loss.`} Win rate is driven mostly by take-profit vs stop-loss; break-even before costs: ${(100/(1+config.take_profit_atr/config.stop_atr)).toFixed(0)}%.`}>
      <div className="setup-field setup-field--wide"><span className="setup-label">Timeframe</span><div className="chip-group" role="radiogroup" aria-label="Execution timeframe">{TIMEFRAME_CHOICES.map(tf=><button key={tf} type="button" role="radio" aria-checked={settings.entry_timeframe===tf} onClick={()=>onChange({...settings,entry_timeframe:tf})}>{tf}</button>)}</div></div>
      <div className="setup-grid">
        {num('take_profit_atr','Take-profit',undefined,'× ATR')}
        {num('stop_atr','Stop-loss',undefined,'× ATR')}
        {num('max_hold_bars','Maximum hold','Closes at market after this.','bars')}
        {num('trades_per_day','Trades per day','0 = off: use minimum win chance.','/day')}
        {!config.trades_per_day&&num('min_probability','Minimum win chance','Per candle, not the overall win rate.')}
        {num('risk_per_trade_pct','Risk per trade','Lost if the stop is hit.','%')}
        <Field label="Leverage" unit="×" hint="Caps position size."><input aria-label="Leverage" type="number" required min={1} max={100} step={.5} value={settings.max_leverage} onChange={event=>onChange({...settings,max_leverage:Number(event.target.value)})}/></Field>
        <Field label="Direction"><select aria-label="Direction" value={config.trade_mode} onChange={event=>set({trade_mode:event.target.value as MLDirectionalConfig['trade_mode']})}>{(['Both','Long Only','Short Only'] as const).map(mode=><option key={mode}>{mode}</option>)}</select></Field>
      </div>
      <details className="setup-more"><summary>Advanced settings{changedAdvanced?` · ${changedAdvanced} changed`:''}</summary>
        <div className="setup-grid">
          {!config.trades_per_day&&num('min_ev_r','Minimum expected value','After costs.','R')}
          {!config.trades_per_day&&num('min_gap','Lead over other side','Long minus short chance.')}
          {num('vol_low_pct','Skip volatility below','Training percentile.','pct')}
          {num('vol_high_pct','Skip volatility above','Training percentile.','pct')}
          {num('max_drawdown_pct','Stop at drawdown','0 = off.','%')}
          {num('atr_length','ATR length',undefined,'bars')}
          {num('train_days','Training window',undefined,'days')}
          {num('trade_days','Retrain every',undefined,'days')}
          {num('calibration_fraction','Calibration share')}
          {num('trees','Trees')}{num('learning_rate','Learning rate')}{num('max_depth','Maximum depth')}
          {num('min_leaf','Minimum leaf size')}{num('seed','Random seed')}
        </div>
        <button type="button" className="text-button" onClick={()=>set(Object.fromEntries(ADVANCED.map(key=>[key,mlDirectionalDefaults[key]])) as Partial<MLDirectionalConfig>)}>Reset advanced to defaults</button>
      </details>
    </SettingsCard>
  </>;
}

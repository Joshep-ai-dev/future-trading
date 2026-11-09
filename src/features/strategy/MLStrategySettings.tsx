import {type BacktestSettings,type MLConfig} from '../../shared/types/types';
import {Field,SettingsCard,TIMEFRAME_CHOICES} from './BBReversalSettings';
import {mlDefaults} from './strategyDefaults';

type NumberKey={[K in keyof MLConfig]:MLConfig[K] extends number?K:never}[keyof MLConfig];

export default function MLStrategySettings({settings,onChange}:{settings:BacktestSettings;onChange:(s:BacktestSettings)=>void}){
  const config=settings.ml;
  const setMl=(patch:Partial<MLConfig>)=>onChange({...settings,ml:{...config,...patch}});
  const essential=Object.entries(config.models).filter(([,weight])=>weight>0).length===1
    &&(config.models.extra_trees??0)>0&&config.capacity==='light'&&config.exit_mode==='forecast'
    &&!config.quality_filter&&!config.trailing&&!config.let_profit_run&&!config.reverse_on_signal
    &&config.regimes.length===mlDefaults.regimes.length&&mlDefaults.regimes.every(name=>config.regimes.includes(name))
    &&config.feature_groups.length===mlDefaults.feature_groups.length&&mlDefaults.feature_groups.every(name=>config.feature_groups.includes(name));
  const num=(key:NumberKey,label:string,min:number,max:number,step:number|'any',hint?:string,unit?:string)=>
    <Field key={key} label={label} hint={hint} unit={unit}><input type="number" required min={min} max={max} step={step} value={config[key]} onChange={event=>setMl({[key]:Number(event.target.value)} as Partial<MLConfig>)} onBlur={event=>{const value=Number(event.target.value);if(!Number.isFinite(value)||value<min||value>max)setMl({[key]:Math.min(max,Math.max(min,Number.isFinite(value)?value:min))} as Partial<MLConfig>);}}/></Field>;

  // Old saved setups retain their execution settings until explicitly converted.
  if(!essential)return <div className="setup-option"><div><strong>Saved advanced setup</strong><p>This setup uses options that have been removed from the editor. Switch to the adaptive forecast model to edit it. Position size and direction are kept.</p></div><button type="button" className="secondary" onClick={()=>setMl({...mlDefaults,models:{...mlDefaults.models},feature_groups:[...mlDefaults.feature_groups],regimes:[...mlDefaults.regimes],amount_per_trade:config.amount_per_trade,amount_unit:config.amount_unit,trade_mode:config.trade_mode})}>Use adaptive forecast</button></div>;

  return <>
    <p className="setup-note">Candles and indicators / Adaptive trading</p>
    <SettingsCard step={1} id="settings-execution" title="Position" description="Choose timeframe, size and direction.">
      <div className="setup-field setup-field--wide"><span className="setup-label">Timeframe</span><div className="chip-group" role="radiogroup" aria-label="Execution timeframe">{TIMEFRAME_CHOICES.map(tf=><button key={tf} type="button" role="radio" aria-checked={settings.entry_timeframe===tf} onClick={()=>onChange({...settings,entry_timeframe:tf})}>{tf}</button>)}</div></div>
      <div className="setup-grid">
        <Field label="Amount per trade" hint={config.amount_unit==='percent'?'Share of balance before leverage.':'Fixed dollars, capped at available balance.'}>
          <input aria-label="Amount per trade" type="number" required min={.01} max={config.amount_unit==='percent'?100:settings.capital} step="any" value={config.amount_per_trade} onChange={event=>setMl({amount_per_trade:Number(event.target.value)})}/>
          <span className="unit-switch" role="group" aria-label="Amount unit">{(['percent','price'] as const).map(unit=><button key={unit} type="button" aria-pressed={config.amount_unit===unit} onClick={()=>setMl({amount_unit:unit,amount_per_trade:Math.min(config.amount_per_trade,unit==='percent'?100:settings.capital)})}>{unit==='percent'?'%':'$'}</button>)}</span>
        </Field>
        <Field label="Leverage" unit="x"><input aria-label="Leverage" type="number" required min={1} max={100} step={.5} value={settings.max_leverage} onChange={event=>onChange({...settings,max_leverage:Number(event.target.value)})}/></Field>
        <Field label="Direction"><select value={config.trade_mode} onChange={event=>setMl({trade_mode:event.target.value as MLConfig['trade_mode']})}><option value="Both">Long and short</option><option value="Long Only">Long only</option><option value="Short Only">Short only</option></select></Field>
      </div>
    </SettingsCard>
    <SettingsCard step={2} id="settings-signals" title="Trading decisions" description="The model predicts high, low and trend. Entries must beat historical forecast baselines, exceed measured uncertainty and have positive past trade expectancy. Tree agreement is not trade-win probability.">
      <div className="setup-grid">
        {num('quality_threshold','Minimum historical trade win frequency',0,.95,'any','Measured from matured, non-overlapping proposals, separately from tree agreement.')}
        {num('risk_per_trade_pct','Maximum planned risk per trade',.01,2,'any','Sizing includes stop distance and estimated costs; price gaps may exceed the budget.','%')}
        {num('max_drawdown_pct','Drawdown halt',.1,80,'any',undefined,'%')}
        {num('daily_loss_pct','UTC daily loss halt',.1,20,'any','A loss halt stops this replay or paper session.','%')}
        {num('min_atr','Minimum ATR',0,100,'any','Open new trades only when ATR is strictly greater than this value.','USDT')}
      </div>
      <p className="setup-note">New entries require ATR greater than {config.min_atr}. Targets and protective stops follow forecasts. Stops only tighten. A changed trend can close the position. Entries fill at the next open. Holding time is bounded; a daily loss or drawdown limit halts trading.</p>
    </SettingsCard>
    <SettingsCard step={3} id="settings-exits" title="Forecast" description="How far ahead the model learns to predict. Forecast horizon and maximum holding time are separate. Zero holding limit uses the forecast horizon.">
      <div className="setup-grid">
        {num('horizon','Forecast horizon',1,500,1,undefined,'bars')}
        {num('forecast_max_hold_bars','Maximum holding time',0,500,1,'Zero uses the forecast horizon.','bars')}
        <Field label="Forecast-based exit adjustments"><input type="checkbox" checked={config.forecast_adaptive_exits} onChange={event=>setMl({forecast_adaptive_exits:event.target.checked})}/></Field>
      </div>
    </SettingsCard>
    <SettingsCard step={4} id="settings-training" title="Training" description="Train on past candles, then evaluate on unseen candles.">
      <div className="setup-grid">
        {num('train_bars','Training window',500,200000,1,undefined,'bars')}
        {num('retrain_every','Retrain every',50,50000,1,undefined,'bars')}
      </div>
    </SettingsCard>
  </>;
}

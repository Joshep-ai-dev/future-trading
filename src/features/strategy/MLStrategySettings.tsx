import {fmt,type BacktestSettings,type MLConfig} from '../../shared/types/types';
import {Field,SettingsCard,TIMEFRAME_CHOICES} from './BBReversalSettings';
import {useStrategyCatalog} from './useStrategyCatalog';
import {REGIME_NAMES} from './strategyDefaults';

type NumberKey={[K in keyof MLConfig]:MLConfig[K] extends number?K:never}[keyof MLConfig];

/** Guided settings for the ML Ensemble strategy. */
export default function MLStrategySettings({settings,onChange}:{settings:BacktestSettings;onChange:(s:BacktestSettings)=>void}){
  const config=settings.ml,{catalog,error}=useStrategyCatalog();
  const setMl=(patch:Partial<MLConfig>)=>onChange({...settings,ml:{...config,...patch}});
  const num=(key:NumberKey,label:string,min:number,max:number,step:number|'any',hint?:string,unit?:string)=>
    <Field key={key} label={label} hint={hint} unit={unit}><input type="number" required min={min} max={max} step={step} value={config[key]} onChange={event=>setMl({[key]:Number(event.target.value)} as Partial<MLConfig>)}/></Field>;
  const toggleGroup=(key:string)=>setMl({feature_groups:config.feature_groups.includes(key)?config.feature_groups.filter(item=>item!==key):[...config.feature_groups,key]});
  // Let profits run has no take-profit, so trailing stays on unless the Supertrend stop locks in gains.
  const trailingLocked=config.let_profit_run&&!config.supertrend_stop;
  const trailingOn=config.trailing||trailingLocked;
  const activeModels=Object.values(config.models).filter(weight=>weight>0).length;
  const activeGpuModels=(catalog?.models??[]).filter(model=>model.device==='cuda'&&(config.models[model.key]??0)>0).length;

  return <>

    <SettingsCard step={1} id="settings-execution" title="Position size" description="How much the bot puts into each trade and which candles the models learn from.">
      <div className="setup-field setup-field--wide"><span className="setup-label">Timeframe</span><div className="chip-group" role="radiogroup" aria-label="Execution timeframe">{TIMEFRAME_CHOICES.map(tf=><button key={tf} type="button" role="radio" aria-checked={settings.entry_timeframe===tf} onClick={()=>onChange({...settings,entry_timeframe:tf})}>{tf}</button>)}</div><small>Short timeframes have small moves relative to trading costs; 15m or higher usually suits ML signals better.</small></div>
      <div className="setup-grid">
        <Field label="Amount per trade" hint={config.amount_unit==='percent'?'Share of your current balance, before leverage.':'Fixed dollars, capped at your available balance.'}>
          <input aria-label="Amount per trade" type="number" required min={.01} max={config.amount_unit==='percent'?100:settings.capital} step="any" value={config.amount_per_trade} onChange={event=>setMl({amount_per_trade:Number(event.target.value)})}/>
          <span className="unit-switch" role="group" aria-label="Amount unit">{(['percent','price'] as const).map(unit=><button key={unit} type="button" aria-pressed={config.amount_unit===unit} onClick={()=>setMl({amount_unit:unit})}>{unit==='percent'?'%':'$'}</button>)}</span>
        </Field>
        <Field label="Leverage" unit="×" hint={`Position size = amount × ${settings.max_leverage}.`}><input aria-label="Leverage" type="number" required min={1} max={100} step={.5} value={settings.max_leverage} onChange={event=>onChange({...settings,max_leverage:Number(event.target.value)})}/></Field>
        <Field label="Direction"><select value={config.trade_mode} onChange={event=>setMl({trade_mode:event.target.value as MLConfig['trade_mode']})}><option value="Both">Long and short</option><option value="Long Only">Long only</option><option value="Short Only">Short only</option></select></Field>
      </div>
    </SettingsCard>

    <SettingsCard step={2} id="settings-features" title="Indicators" description={`The models learn from these indicator groups (${config.feature_groups.length} selected). All are computed from closed candles only.`}>
      {error&&<p className="error">{error}</p>}
      <div className="feature-picker">{(catalog?.featureGroups??[]).map(group=><button key={group.key} type="button" aria-pressed={config.feature_groups.includes(group.key)} onClick={()=>toggleGroup(group.key)}><strong>{group.label}</strong><small>{group.description}</small></button>)}</div>
    </SettingsCard>

    <SettingsCard step={3} id="settings-models" title="Models" description={`${activeModels} model${activeModels===1?'':'s'} in the ensemble. Each model votes with its weight; probabilities are averaged.`}>
      {catalog&&<div className={`compute-status ${catalog.compute.gpuAvailable?'is-gpu':'is-cpu'}`} role="status">
        <i aria-hidden="true"/>
        <div><strong>{catalog.compute.gpuAvailable?`GPU ready · ${catalog.compute.device}`:'CPU mode'}</strong><small>{catalog.compute.gpuAvailable?`${activeGpuModels?`${activeGpuModels} selected model${activeGpuModels===1?'':'s'} will use CUDA`:'No selected model currently uses CUDA'} · CUDA ${catalog.compute.cudaVersion} · PyTorch ${catalog.compute.torchVersion}`:'Install a CUDA-enabled PyTorch build to accelerate XGBoost, 1D-CNN and LSTM.'}</small></div>
        {catalog.compute.gpuAvailable&&<div className="device-picker" role="radiogroup" aria-label="Compute device">{([['auto','Auto','Fastest per model'],['gpu','GPU','CUDA wherever supported'],['cpu','CPU','No GPU']] as const).map(([key,label,hint])=><button key={key} type="button" role="radio" aria-checked={config.device===key} title={hint} onClick={()=>setMl({device:key})}>{label}</button>)}</div>}
      </div>}
      {catalog?.compute.gpuAvailable&&<p className="setup-note">{config.device==='auto'?'Auto: neural networks (CNN, LSTM) train on the GPU; small tree models stay on the CPU because they are faster there. Measured fastest on this machine.':config.device==='gpu'?'GPU: XGBoost, learned exits, the quality filter, CNN and LSTM use CUDA. LightGBM and scikit-learn models have no GPU support and stay on the CPU. On windows of a few thousand candles this is slower than Auto.':'CPU: every model trains on the processor.'}</p>}
      <div className="model-picker">{(catalog?.models??[]).map(model=>{
        const weight=config.models[model.key]??0,enabled=weight>0;
        return <div key={model.key} className={`model-row ${enabled?'is-on':''} ${model.available?'':'is-unavailable'}`}>
          <label className="setup-toggle"><input type="checkbox" role="switch" aria-label={`Use ${model.label}`} checked={enabled} disabled={!model.available} onChange={event=>setMl({models:{...config.models,[model.key]:event.target.checked?1:0}})}/><i aria-hidden="true"/></label>
          <div className="model-copy"><strong>{model.label}<em>{model.family}</em><em className={`model-device is-${model.device}`}>{model.device==='cuda'?'GPU':'CPU'}</em></strong><small>{model.available?model.description:`Install "${model.requires}" to enable.`}</small></div>
          <label className="model-weight"><span>Weight</span><input type="range" min={0} max={1} step={.05} value={weight} disabled={!model.available} aria-label={`${model.label} weight`} onChange={event=>setMl({models:{...config.models,[model.key]:Number(event.target.value)}})}/><b>{weight.toFixed(2)}</b></label>
        </div>;
      })}</div>
    </SettingsCard>

    <SettingsCard step={4} id="settings-signals" title="Entries" description="The models must be confident in one direction, clearly more than the other, and the trade must be worth its cost.">
      <div className="setup-grid">
        {num('entry_threshold','Entry probability',.34,.99,'any','Model probability needed to enter.')}
        {num('min_edge','Edge over opposite side',0,.99,'any','Long minus short probability.')}
        {num('min_reward_cost','Reward ÷ cost',0,50,'any','Skip trades whose target is too small for costs.','×')}
        {num('horizon','Horizon',1,500,1,'Candles a trade may stay open; longer = bigger moves.','bars')}
        {num('min_atr','Minimum ATR',0,100,'any','No new trades when the market moves less than this.','USDT')}
        {num('min_target','Minimum move',0,100,'any','Enter only if the expected move is at least this; trailing starts here.','USDT')}
      </div>
      <p className="setup-note">Expected size: about {fmt(settings.capital*(config.amount_unit==='percent'?config.amount_per_trade/100:Math.min(1,config.amount_per_trade/settings.capital))*settings.max_leverage/58,1)} oz per trade at this amount and leverage, so every 0.10 USDT move ≈ ${fmt(settings.capital*(config.amount_unit==='percent'?config.amount_per_trade/100:Math.min(1,config.amount_per_trade/settings.capital))*settings.max_leverage/58*.1,2)}. Raise leverage or the horizon for larger P&amp;L per trade.</p>
      <div className="setup-option"><div><strong>Fee-aware training</strong><p>A move only counts as a win in training if it still reaches the target after fees, spread and slippage (the cost settings of the backtest). The models then stop learning to chase moves too small to pay the fees.</p></div><label className="setup-toggle"><input type="checkbox" role="switch" aria-label="Fee-aware training" checked={config.cost_aware_labels!==false} onChange={event=>setMl({cost_aware_labels:event.target.checked})}/><i aria-hidden="true"/><span>{config.cost_aware_labels!==false?'On':'Off'}</span></label></div>
      <div className="setup-option"><div><strong>Trade-quality filter</strong><p>A second model learns when the direction call is usually right and skips the rest. Tested on unseen data it removed many losing trades.</p></div><label className="setup-toggle"><input type="checkbox" role="switch" aria-label="Trade-quality filter" checked={config.quality_filter} onChange={event=>setMl({quality_filter:event.target.checked})}/><i aria-hidden="true"/><span>{config.quality_filter?'On':'Off'}</span></label></div>
      {config.quality_filter&&<div className="setup-grid setup-grid--nested">{num('quality_threshold','Minimum win chance',0,.99,'any','Predicted chance that the trade wins.')}</div>}
      {!config.supertrend_stop&&<div className="setup-option"><div><strong>Reverse on opposite signal</strong><p>Close and flip the position when the models confidently call the other direction.</p></div><label className="setup-toggle"><input type="checkbox" role="switch" aria-label="Reverse on opposite signal" checked={config.reverse_on_signal} onChange={event=>setMl({reverse_on_signal:event.target.checked})}/><i aria-hidden="true"/><span>{config.reverse_on_signal?'On':'Off'}</span></label></div>}
    </SettingsCard>

    <SettingsCard step={5} id="settings-exits" title="Exits" description={config.supertrend_stop?'One exit: the Supertrend. Trades open only in its direction, the stop starts on its line and follows it, and a flip closes the trade. No take-profit, trailing, time limit or reversal.':config.exit_mode==='learned'?'The models learn how far price usually moves for and against each trade, and set take-profit, stop and trailing from that for every entry.':'Every trade uses the same ATR multiples for take-profit and stop.'}>
      <div className="setup-option"><div><strong>Supertrend stop loss</strong><p>The only exit when on. Turn off to use the learned or fixed take-profit, stop and trailing instead.</p></div><label className="setup-toggle"><input type="checkbox" role="switch" aria-label="Supertrend stop loss" checked={!!config.supertrend_stop} onChange={event=>setMl({supertrend_stop:event.target.checked})}/><i aria-hidden="true"/><span>{config.supertrend_stop?'On':'Off'}</span></label></div>
      {config.supertrend_stop&&<div className="setup-grid setup-grid--nested">{num('supertrend_length','Supertrend ATR length',2,500,1,'Candles in the ATR (TradingView default 10).')}{num('supertrend_multiplier','Supertrend multiplier',.1,20,'any','Line distance in ATRs. Smaller = tighter stop (default 3).')}</div>}
      {config.supertrend_stop?<div className="setup-grid setup-grid--nested">
        {num('take_profit_atr','Training target',.1,20,'any','Move that counts as a win when the models learn (after fees).','× ATR')}
        {num('stop_atr','Training stop',.1,20,'any','Move that counts as a loss when the models learn.','× ATR')}
        {num('atr_length','ATR length',2,500,1,undefined,'bars')}
      </div>:<>
      <div className="exit-mode" role="radiogroup" aria-label="Exit mode">{(['learned','fixed'] as const).map(mode=><button key={mode} type="button" role="radio" aria-checked={config.exit_mode===mode} onClick={()=>setMl({exit_mode:mode})}><strong>{mode==='learned'?'Learned by the models':'Fixed ATR multiples'}</strong><small>{mode==='learned'?'Quantile models predict the favourable and adverse move per trade.':'Simple and predictable; tune them with the grid search.'}</small></button>)}</div>
      {config.exit_mode==='learned'?<div className="setup-grid">
        {num('tp_quantile','Target quantile',.05,.95,'any','Lower = closer, more often reached.')}
        {num('sl_quantile','Stop quantile',.05,.95,'any','Higher = wider, outside normal noise.')}
        {num('min_reward_risk','Min reward ÷ risk',0,10,'any','Learned target ÷ learned stop needed to enter.','×')}
      </div>:null}
      <div className="setup-grid setup-grid--nested">
        {num('take_profit_atr',config.exit_mode==='learned'?'Win definition: target':'Take profit',.1,20,'any',config.exit_mode==='learned'?'Defines a “win” the direction models learn.':'Distance in ATR.','× ATR')}
        {num('stop_atr',config.exit_mode==='learned'?'Win definition: stop':'Stop loss',.1,20,'any',config.exit_mode==='learned'?'Also the fallback where no exit model exists.':'Distance in ATR.','× ATR')}
        {num('atr_length','ATR length',2,500,1,undefined,'bars')}
      </div>
      <div className="setup-option"><div><strong>Let profits run</strong><p>No fixed take-profit and no time exit: the trade stays open until the stop or the trailing stop closes it. Trailing starts at +{config.min_target} USDT.</p></div><label className="setup-toggle"><input type="checkbox" role="switch" aria-label="Let profits run" checked={config.let_profit_run} onChange={event=>setMl({let_profit_run:event.target.checked,trailing:event.target.checked?true:config.trailing})}/><i aria-hidden="true"/><span>{config.let_profit_run?'On':'Off'}</span></label></div>
      <div className="setup-option"><div><strong>Trailing stop</strong><p>{config.exit_mode==='learned'?'Starts after a share of the learned target and follows price by the learned noise level.':'Starts after a share of the target and follows price by the stop distance.'}</p>{trailingLocked&&<p className="setup-note">Locked on while “Let profits run” is on: with no take-profit it is the only profit exit. Turn on the Supertrend stop, or turn off “Let profits run”, to switch it off.</p>}</div><label className="setup-toggle"><input type="checkbox" role="switch" aria-label="Trailing stop" checked={trailingOn} disabled={trailingLocked} onChange={event=>setMl({trailing:event.target.checked})}/><i aria-hidden="true"/><span>{trailingOn?'On':'Off'}</span></label></div>
      {trailingOn&&<div className="setup-grid setup-grid--nested">
        {num('trail_start','Start trailing at',.1,2,'any','Share of the target reached.','× target')}
        {num('trail_noise','Trailing distance',.2,5,'any','Multiple of the stop distance.','× stop')}
      </div>}
      </>}
    </SettingsCard>

    <SettingsCard step={6} id="settings-regimes" title="Market regimes" description="The models learn four market states from trend, volatility, efficiency and ADX. Trade only in the states you choose; the Model tab shows results per state.">
      <div className="feature-picker regime-picker">{REGIME_NAMES.map(name=><button key={name} type="button" aria-pressed={config.regimes.includes(name)} onClick={()=>setMl({regimes:config.regimes.includes(name)?config.regimes.filter(item=>item!==name):[...config.regimes,name]})}><strong>{name}</strong><small>{{'Trend up':'Steady rise, efficient moves','Trend down':'Steady fall, efficient moves','Range':'Sideways, mean-reverting','Volatile':'Large, noisy swings'}[name]}</small></button>)}</div>
      {config.regimes.length===0&&<p className="error">Choose at least one regime.</p>}
    </SettingsCard>

    <SettingsCard step={7} id="settings-training" title="Walk-forward training" description="Models retrain on past data only and are tested on the next block they have never seen. The backtest reports only these unseen blocks.">
      <div className="setup-grid">
        {num('train_bars','Training window',500,200000,1,'Past candles used for each model.','bars')}
        {num('retrain_every','Retrain every',50,50000,1,'Size of each unseen test block.','bars')}
        {num('recency_half_life','Recent data weight',0,200000,1,'Weight halves every N candles back; 0 = all equal.','half-life')}
        <Field label="Model capacity" hint="How large each model may grow."><select value={config.capacity} onChange={event=>setMl({capacity:event.target.value as MLConfig['capacity']})}><option value="light">Light</option><option value="standard">Standard</option><option value="rich">Rich</option></select></Field>
      </div>
      <p className="setup-note">Trained blocks are cached, so re-running the same settings or extending the date range only trains new blocks. The first run with new settings can take up to a minute.</p>
    </SettingsCard>
  </>;
}

import type {BacktestSettings,RLConfig} from '../../shared/types/types';
import {Field,SettingsCard,TIMEFRAME_CHOICES} from './BBReversalSettings';

export default function RLStrategySettings({settings,onChange}:{settings:BacktestSettings;onChange:(settings:BacktestSettings)=>void}){
  const config=settings.rl;
  const setRl=(patch:Partial<RLConfig>)=>onChange({...settings,rl:{...config,...patch}});
  const number=(key:Exclude<keyof RLConfig,'amount_unit'>,label:string,min:number,max:number,step:number|'any'=1,hint?:string)=>
    <Field label={label} hint={hint}><input type="number" required min={min} max={max} step={step} value={config[key]} onChange={event=>setRl({[key]:Number(event.target.value)})}/></Field>;
  return <>
    <SettingsCard step={1} id="settings-execution" title="RL PPO position" description="Learns whether to be flat, long or short. Decisions use closed candles and fill at the next open. Backtest and paper trading only.">
      <div className="chip-group" role="radiogroup" aria-label="Execution timeframe">{TIMEFRAME_CHOICES.map(tf=><button key={tf} type="button" role="radio" aria-checked={settings.entry_timeframe===tf} onClick={()=>onChange({...settings,entry_timeframe:tf})}>{tf}</button>)}</div>
      <div className="setup-grid">
        {number('amount_per_trade','Amount per trade',.01,config.amount_unit==='percent'?100:settings.capital,'any')}
        <Field label="Amount unit"><select value={config.amount_unit} onChange={event=>{const unit=event.target.value as RLConfig['amount_unit'];setRl({amount_unit:unit,amount_per_trade:Math.min(config.amount_per_trade,unit==='percent'?100:settings.capital)});}}><option value="percent">% of balance</option><option value="price">USDT</option></select></Field>
        <Field label="Leverage"><input type="number" required min={1} max={100} step={.5} value={settings.max_leverage} onChange={event=>onChange({...settings,max_leverage:Number(event.target.value)})}/></Field>
      </div>
    </SettingsCard>
    <SettingsCard step={2} id="settings-risk" title="Entry and risk limits" description="The policy controls exits. These protective limits also apply during training.">
      <div className="setup-grid">
        {number('min_atr','Minimum ATR',0,100,'any','New entries require ATR strictly above this value. Default 0.03.')}
        {number('stop_atr','Protective stop (ATR)',.1,20,'any')}
        {number('max_drawdown_pct','Halt at drawdown (%)',.1,80,'any','Closes exposure and halts the replay when reached.')}
      </div>
    </SettingsCard>
    <SettingsCard step={3} id="settings-training" title="PPO training" description="Trains only on earlier candles, selects checkpoints on past validation, then checks the selected policy once on a separate past confirmation period. Only accepted policies are used. Reward uses equity after costs, drawdown and position-change penalties. A losing policy stays flat.">
      <div className="setup-grid">
        {number('train_bars','Training window',500,200000)}
        {number('retrain_every','Retrain every (bars)',50,50000)}
        {number('lookback','Observed candles',1,100,1,'Ordered recent closed candles, including scaled OHLC, volume when available, and indicators. No unfinished candle.')}
        {number('turnover_penalty','Position-change penalty',0,.01,'any','Learning penalty per balance unit traded; actual account profit is unchanged.')}
        {number('learning_rate','Learning rate',.000001,.01,'any')}
        {number('seed','Training seed',0,2147483647)}
        {number('drawdown_penalty','Drawdown penalty',0,10,'any')}
        {number('timesteps','Training steps',256,1000000,256,'More steps take longer and do not guarantee better results.')}
      </div>
    </SettingsCard>
  </>;
}

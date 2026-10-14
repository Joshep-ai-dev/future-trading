import type {BacktestSettings} from './types';

export const bbDefaults: BacktestSettings['bb_reversal'] = {
  hedge_mode:false,rsi_exit_enabled:false,rsi_exit_length:14,rsi_exit_move:.3,rsi_exit_short:15,rsi_exit_long:85,
  trade_mode:'Both',bb_length:20,bb_mult:3,min_bb_width_pct:.8,atr_length:14,min_atr:.03,
  adx_length:14,adx_threshold:20,pullback_bars:3,initial_sl:.5,trail_trigger:.6,
  trail_distance:.3,trail_multiplier:2,sma_length:30,sma_slope_bars:3,
  counter_profit_pct:75,counter_sl_pct:75,quantity:1,use_sma_trend_adjustment:true,amount_per_trade:100,amount_unit:'percent',
};
const fields: [Exclude<keyof typeof bbDefaults,'trade_mode'|'hedge_mode'|'rsi_exit_enabled'|'use_sma_trend_adjustment'|'amount_unit'|'amount_per_trade'>,string,number,number,number][] = [
  ['bb_length','BB length',1,1000,1],['bb_mult','BB multiplier',.1,100,.1],
  ['min_bb_width_pct','Minimum BB width (%)',0,100,.1],['atr_length','ATR length',1,500,1],
  ['min_atr','Minimum ATR',0,100,.01],['adx_length','ADX length',1,500,1],
  ['adx_threshold','ADX threshold (strictly above)',0,100,.5],['pullback_bars','Rebound window (bars)',1,100,1],
  ['rsi_exit_length','Exit RSI length',1,500,1],['rsi_exit_move','Upward price move (strictly above)',0,100,.01],
  ['rsi_exit_short','Short RSI (strictly below)',0,100,.5],['rsi_exit_long','Long RSI (strictly above)',0,100,.5],
  ['initial_sl','Initial stop (price units)',.01,100,.01],['trail_trigger','Trail activation (price units)',.01,100,.01],
  ['trail_distance','Trail distance (price units)',.01,100,.01],['trail_multiplier','Trailing multiplier',1,100,.1],
  ['sma_length','Trend SMA length',1,1000,1],['sma_slope_bars','SMA slope lookback',1,500,1],
  ['counter_profit_pct','Countertrend profit distances (%)',1,100,1],['counter_sl_pct','Countertrend stop (%)',1,100,1],
];
export default function BBReversalSettings({settings,onChange}:{settings:BacktestSettings;onChange:(s:BacktestSettings)=>void}) {
  const config=settings.bb_reversal;
  const renderFields=(keys:string[])=>fields.filter(([key])=>keys.includes(key)).map(([key,label,min,max,step])=><label key={key}>{label}<input type="number" required min={min} max={max} step={step} value={config[key]} onChange={e=>onChange({...settings,bb_reversal:{...config,[key]:Number(e.target.value)}})}/></label>);
  return <div className="exit-settings"><h3>BB Outer Band Reversal + Trailing SL</h3>
    <p>BB Outer Band Reversal + Trailing SL. Both directions with ATR and ADX confirmation. Changes apply to your next backtest or new virtual session.</p>
    <div className="settings-section" id="settings-execution"><h3>Execution & allocation</h3>
    <div className="settings-grid"><label>Execution timeframe<select value={settings.entry_timeframe} onChange={e=>onChange({...settings,entry_timeframe:e.target.value as BacktestSettings['entry_timeframe']})}>{['1m','3m','5m','10m','15m','30m','1h','4h','1d'].map(tf=><option key={tf}>{tf}</option>)}</select></label>
    <label>Leverage (x)<input aria-label="Leverage" type="number" required min={1} max={100} step={.5} value={settings.max_leverage} onChange={e=>onChange({...settings,max_leverage:Number(e.target.value)})}/></label>
    <label>Amount unit<select aria-label="Amount unit" value={config.amount_unit} onChange={e=>onChange({...settings,bb_reversal:{...config,amount_unit:e.target.value as 'price'|'percent'}})}><option value="price">$</option><option value="percent">%</option></select></label>
    <label>Amount per trade ({config.amount_unit==='percent'?'% of balance':'$'})<input aria-label="Amount per trade" type="number" required min={.01} max={config.amount_unit==='percent'?100:settings.capital} step="any" value={config.amount_per_trade} onChange={e=>onChange({...settings,bb_reversal:{...config,amount_per_trade:Number(e.target.value)}})}/></label>
    </div><p className="settings-help">Amount is allocated before leverage and capped at available balance. A depleted balance stops new trades.</p></div>
    <div className="settings-section"><div className="section-heading"><h3>Opposite signals</h3><label className="stage-switch"><input type="checkbox" role="switch" aria-label="Keep long and short positions open together" checked={config.hedge_mode??false} onChange={e=>onChange({...settings,bb_reversal:{...config,hedge_mode:e.target.checked}})}/>Keep long and short open together</label></div><p className="settings-help">{config.hedge_mode?'Hedge mode: one position per side, with independent stops and exits. New trades use remaining available funds. Use less than 100% per trade to leave room for the opposite side.':'Off: an opposite signal closes the current position and opens the opposite trade.'}</p></div>
    <div className="settings-section" id="settings-filters"><h3>Entry filters</h3><div className="settings-grid">{renderFields(['bb_length','bb_mult','min_bb_width_pct','pullback_bars','atr_length','min_atr','adx_length','adx_threshold'])}</div></div>
    <div className="settings-section" id="settings-stops"><h3>Stop loss & trailing</h3><div className="settings-grid">{renderFields(['initial_sl','trail_trigger','trail_distance','trail_multiplier'])}</div><p className="settings-help">The multiplier scales both trailing activation and trailing distance. Price distances are per unit, not total account loss.</p></div>
    <div className="settings-section" id="settings-rsi-exit"><div className="section-heading"><h3>RSI + price exit</h3><label className="stage-switch"><input type="checkbox" role="switch" aria-label="Enable RSI and price exit" checked={config.rsi_exit_enabled??false} onChange={e=>onChange({...settings,bb_reversal:{...config,rsi_exit_enabled:e.target.checked}})}/>Enable optional exit</label></div>
      {config.rsi_exit_enabled?<><div className="settings-grid">{renderFields(['rsi_exit_length','rsi_exit_move','rsi_exit_short','rsi_exit_long'])}</div><p className="settings-help">Both sides: close price − entry price &gt; {config.rsi_exit_move}. Short: RSI &lt; {config.rsi_exit_short}. Long: RSI &gt; {config.rsi_exit_long}. Checked at the execution candle close. This upward price move is against a short position. Existing stop protection remains active.</p></>:<p className="settings-help">Off. Enable to close using your price-difference and RSI conditions.</p>}
    </div>
    <div className="settings-section" id="settings-trend"><div className="section-heading"><h3>SMA trend adjustment</h3><label className="stage-switch"><input type="checkbox" role="switch" aria-label="Use SMA Trend Adjustment" checked={config.use_sma_trend_adjustment} onChange={e=>onChange({...settings,bb_reversal:{...config,use_sma_trend_adjustment:e.target.checked}})}/>Use SMA Trend Adjustment</label></div>
      {config.use_sma_trend_adjustment?<><div className="settings-grid">{renderFields(['sma_length','sma_slope_bars','counter_profit_pct','counter_sl_pct'])}</div><p className="settings-help">Countertrend trades use the selected reduced stop and trailing distances.</p></>:<p>Normal stop and trailing distances apply to every trade. The SMA line is hidden.</p>}
    </div>
  </div>;
}

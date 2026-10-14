import type {BacktestSettings} from './types';

export const bbDefaults: BacktestSettings['bb_reversal'] = {
  trade_mode:'Both',bb_length:20,bb_mult:3,min_bb_width_pct:.8,atr_length:14,min_atr:.03,
  adx_length:14,adx_threshold:20,pullback_bars:3,initial_sl:.5,trail_trigger:.6,
  trail_distance:.3,trail_multiplier:2,sma_length:30,sma_slope_bars:3,
  counter_profit_pct:75,counter_sl_pct:75,quantity:1,
};
const fields: [Exclude<keyof typeof bbDefaults,'trade_mode'>,string,number,number,number][] = [
  ['bb_length','BB length',1,1000,1],['bb_mult','BB multiplier',.1,100,.1],
  ['min_bb_width_pct','Minimum BB width (%)',0,100,.1],['atr_length','ATR length',1,500,1],
  ['min_atr','Minimum ATR',0,100,.01],['adx_length','ADX length',1,500,1],
  ['adx_threshold','ADX threshold (strictly above)',0,100,.5],['pullback_bars','Rebound window (bars)',1,100,1],
  ['initial_sl','Initial stop (price units)',.01,100,.01],['trail_trigger','Trail activation (price units)',.01,100,.01],
  ['trail_distance','Trail distance (price units)',.01,100,.01],['trail_multiplier','Trailing multiplier',1,100,.1],
  ['sma_length','Trend SMA length',1,1000,1],['sma_slope_bars','SMA slope lookback',1,500,1],
  ['counter_profit_pct','Countertrend profit distances (%)',1,100,1],['counter_sl_pct','Countertrend stop (%)',1,100,1],
  ['quantity','Fixed quantity (units)',.0001,1e6,.0001],
];
export default function BBReversalSettings({settings,onChange}:{settings:BacktestSettings;onChange:(s:BacktestSettings)=>void}) {
  const config=settings.bb_reversal;
  return <div className="exit-settings"><h3>BB Outer Band Reversal + Trailing SL</h3>
    <p>A band touch arms one rebound. Entries alternate long and short, with ATR, BB width and ADX filters. SMA slope reduces countertrend stop and trailing distances.</p>
    <div className="settings-grid"><label>Execution timeframe<select value={settings.entry_timeframe} onChange={e=>onChange({...settings,entry_timeframe:e.target.value as BacktestSettings['entry_timeframe']})}>{['1m','3m','5m','15m'].map(tf=><option key={tf}>{tf}</option>)}</select></label>
    <label>Trading direction<select value={config.trade_mode} onChange={e=>onChange({...settings,bb_reversal:{...config,trade_mode:e.target.value as typeof config.trade_mode}})}>{['Both','Long Only','Short Only'].map(mode=><option key={mode}>{mode}</option>)}</select></label>
    {fields.map(([key,label,min,max,step])=><label key={key}>{label}<input type="number" required min={min} max={max} step={step} value={config[key]} onChange={e=>onChange({...settings,bb_reversal:{...config,[key]:Number(e.target.value)}})}/></label>)}</div>
    <p>Uses completed candles, close-price entries, fixed quantity and continuous calendar trading, matching the Pine script. Trailing multiplier scales both activation and distance. Fees, spread, slippage, funding, leverage caps and session filters are not applied. Each research/validation period starts flat and closes remaining positions at its last candle. Long Only or Short Only can fill only once per period because filled directions must alternate.</p>
  </div>;
}

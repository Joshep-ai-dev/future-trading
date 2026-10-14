import type {BacktestSettings} from './types';

export const bbDefaults: BacktestSettings['bb_reversal'] = {
  trade_mode:'Both',bb_length:20,bb_mult:3,min_bb_width_pct:.8,atr_length:14,min_atr:.03,
  adx_length:14,adx_threshold:20,pullback_bars:3,initial_sl:.5,trail_trigger:.6,
  trail_distance:.3,trail_multiplier:2,sma_length:30,sma_slope_bars:3,
  counter_profit_pct:75,counter_sl_pct:75,quantity:1,use_sma_trend_adjustment:true,amount_per_trade:100,amount_unit:'percent',
};
const fields: [Exclude<keyof typeof bbDefaults,'trade_mode'|'use_sma_trend_adjustment'|'amount_unit'|'amount_per_trade'>,string,number,number,number][] = [
  ['bb_length','BB length',1,1000,1],['bb_mult','BB multiplier',.1,100,.1],
  ['min_bb_width_pct','Minimum BB width (%)',0,100,.1],['atr_length','ATR length',1,500,1],
  ['min_atr','Minimum ATR',0,100,.01],['adx_length','ADX length',1,500,1],
  ['adx_threshold','ADX threshold (strictly above)',0,100,.5],['pullback_bars','Rebound window (bars)',1,100,1],
  ['initial_sl','Initial stop (price units)',.01,100,.01],['trail_trigger','Trail activation (price units)',.01,100,.01],
  ['trail_distance','Trail distance (price units)',.01,100,.01],['trail_multiplier','Trailing multiplier',1,100,.1],
  ['sma_length','Trend SMA length',1,1000,1],['sma_slope_bars','SMA slope lookback',1,500,1],
  ['counter_profit_pct','Countertrend profit distances (%)',1,100,1],['counter_sl_pct','Countertrend stop (%)',1,100,1],
];
export default function BBReversalSettings({settings,onChange}:{settings:BacktestSettings;onChange:(s:BacktestSettings)=>void}) {
  const config=settings.bb_reversal;
  return <div className="exit-settings"><h3>BB Outer Band Reversal + Trailing SL</h3>
    <p>A band touch arms one rebound. Entries alternate long and short, with ATR, BB width and ADX filters. {config.use_sma_trend_adjustment?'SMA slope reduces countertrend stop and trailing distances.':'Normal stop and trailing distances apply to every trade.'}</p>
    <label className="stage-switch"><input type="checkbox" role="switch" aria-label="Use SMA Trend Adjustment" checked={config.use_sma_trend_adjustment} onChange={e=>onChange({...settings,bb_reversal:{...config,use_sma_trend_adjustment:e.target.checked}})}/>Use SMA Trend Adjustment</label>
    <div className="settings-grid"><label>Execution timeframe<select value={settings.entry_timeframe} onChange={e=>onChange({...settings,entry_timeframe:e.target.value as BacktestSettings['entry_timeframe']})}>{['1m','3m','5m','10m','15m','30m','1h','4h','1d'].map(tf=><option key={tf}>{tf}</option>)}</select></label>
    <label>Leverage (x)<input aria-label="Leverage" type="number" required min={1} max={100} step={.5} value={settings.max_leverage} onChange={e=>onChange({...settings,max_leverage:Number(e.target.value)})}/></label>
    <label>Amount unit<select aria-label="Amount unit" value={config.amount_unit} onChange={e=>onChange({...settings,bb_reversal:{...config,amount_unit:e.target.value as 'price'|'percent'}})}><option value="price">$</option><option value="percent">%</option></select></label>
    <label>Amount per trade ({config.amount_unit==='percent'?'% of balance':'$'})<input aria-label="Amount per trade" type="number" required min={.01} max={config.amount_unit==='percent'?100:settings.capital} step="any" value={config.amount_per_trade} onChange={e=>onChange({...settings,bb_reversal:{...config,amount_per_trade:Number(e.target.value)}})}/></label>
    {fields.filter(([key])=>config.use_sma_trend_adjustment||!['sma_length','sma_slope_bars','counter_profit_pct','counter_sl_pct'].includes(key)).map(([key,label,min,max,step])=><label key={key}>{label}<input type="number" required min={min} max={max} step={step} value={config[key]} onChange={e=>onChange({...settings,bb_reversal:{...config,[key]:Number(e.target.value)}})}/></label>)}</div>
    <p>Amount per trade is the account money allocated before leverage. Choose $ for a fixed amount or % of current balance. Dollar allocations are capped at the available balance after losses. No new trades open when balance is zero or negative.</p>
    <p>Trades both directions using completed candles and close-price entries. Position notional equals current account balance × leverage; quantity is recalculated at each entry. Trailing multiplier scales both activation and distance. Fees, spread, slippage, funding and session filters are not applied. Margin liquidation is not modeled. Each research/validation period starts flat and closes remaining positions at its last candle.</p>
  </div>;
}

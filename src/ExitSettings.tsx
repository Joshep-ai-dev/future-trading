import type {BacktestSettings} from './types';
import {effectiveTimeframe} from './TimeframeSettings';
export const exitOptions = {none:'Stop / target only',ema:'EMA20 / EMA50 reversal',rsi:'RSI20 crosses against the trade through 50',either:'EMA reversal OR RSI cross'};
export const stopOptions = {fixed:'Fixed initial stop',breakeven:'Breakeven after +1R',trailing:'Trail completed candle lows / highs',breakeven_trailing:'Breakeven + trailing'};
export const exitReasonLabel=(reason:string)=>({stop:'Stop loss',target:'2R target',ema_exit:'EMA reversal',rsi_exit:'RSI cross',ema_rsi_exit:'EMA + RSI reversal',session_end:'Session end',period_end:'Period end',data_gap:'Data gap'}[reason]??reason.replaceAll('_',' '));
export default function ExitSettings({settings,onChange}:{settings:BacktestSettings;onChange:(s:BacktestSettings)=>void}) {
  const tf=effectiveTimeframe(settings)?.toUpperCase()??'—';
  return <div className="exit-settings"><div className="section-heading"><h3>Close conditions & stop loss</h3><small>Available for both strategies · execution timeframe {tf}</small></div>
    <div className="settings-grid"><label>Close position when<select aria-label="Close condition" value={settings.exit_condition} onChange={e=>onChange({...settings,exit_condition:e.target.value as BacktestSettings['exit_condition']})}>{Object.entries(exitOptions).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
    <label>Stop management<select aria-label="Stop management" value={settings.stop_mode} onChange={e=>onChange({...settings,stop_mode:e.target.value as BacktestSettings['stop_mode']})}>{Object.entries(stopOptions).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label></div>
    <p>Long exit: EMA20 crosses below EMA50, or RSI20 crosses below 50. Short exit: the reverse. Selected conditions are checked on completed {tf} candles; the close order fills at the next open. Existing stops, the 2R target, and session exits remain active.</p>
    <p>Breakeven moves the stop to entry after price reaches +1R. Trailing uses one tick below the last completed candle’s low for longs, or above its high for shorts. Combined mode takes the tighter stop. Stops never loosen, and changes start on the next candle. R always uses the original entry-to-stop distance. Breakeven is before fees, slippage and funding.</p>
  </div>;
}

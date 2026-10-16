import {NumberField} from '../../shared/ui/ui';
import {useState} from 'react';
import {api} from '../../shared/api/api';
import {htxCostDefaults} from './executionCostDefaults';
import type {BacktestSettings} from '../../shared/types/types';

import {bbDefaults} from './strategyDefaults';

const fields: [Exclude<keyof typeof bbDefaults,'trade_mode'|'rsi_exit_enabled'|'use_sma_trend_adjustment'|'amount_unit'|'amount_per_trade'>,string,number,number,number][] = [
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
  const [costBusy,setCostBusy]=useState(false),[costMessage,setCostMessage]=useState('');
  async function applyHtx(){
    setCostBusy(true);setCostMessage('');
    try{
      const data=await api<{fee_bps:number;funding_bps:number;spread:number;actualFundingPct:number;intervalHours:number;feeNote:string}>('/api/costs/htx');
      onChange({...settings,fee_bps:data.fee_bps,funding_bps:data.funding_bps,spread:data.spread});
      setCostMessage(`HTX XAG-USDT snapshot applied: funding ${data.actualFundingPct.toFixed(6)}% / ${data.intervalHours}h, converted to the simulation's 8h equivalent. ${data.feeNote} Slippage preserved. Current funding is not historical funding.`);
    }catch(error){setCostMessage(String(error));}finally{setCostBusy(false);}
  }
  const renderFields=(keys:string[])=>fields.filter(([key])=>keys.includes(key)).map(([key,label,min,max])=><NumberField key={key} label={label} min={min} max={max} value={config[key]} onValueChange={value=>onChange({...settings,bb_reversal:{...config,[key]:value}})}/>);

  return <div className="exit-settings"><h3>BB Outer Band Reversal + Trailing SL</h3>

    <div className="settings-section" id="settings-execution"><h3>Execution & allocation</h3>
    <div className="settings-grid"><label>Execution timeframe<select value={settings.entry_timeframe} onChange={e=>onChange({...settings,entry_timeframe:e.target.value as BacktestSettings['entry_timeframe']})}>{['1m','3m','5m','10m','15m','30m','1h','4h','1d'].map(tf=><option key={tf}>{tf}</option>)}</select></label>
    <label>Leverage (x)<input aria-label="Leverage" type="number" required min={1} max={100} step={.5} value={settings.max_leverage} onChange={e=>onChange({...settings,max_leverage:Number(e.target.value)})}/></label>
    <label>Amount unit<select aria-label="Amount unit" value={config.amount_unit} onChange={e=>onChange({...settings,bb_reversal:{...config,amount_unit:e.target.value as 'price'|'percent'}})}><option value="price">$</option><option value="percent">%</option></select></label>
    <label>Amount per trade ({config.amount_unit==='percent'?'% of balance':'$'})<input aria-label="Amount per trade" type="number" required min={.01} max={config.amount_unit==='percent'?100:settings.capital} step="any" value={config.amount_per_trade} onChange={e=>onChange({...settings,bb_reversal:{...config,amount_per_trade:Number(e.target.value)}})}/></label>
    </div><p className="settings-help">Amount is allocated before leverage and capped at available balance. A depleted balance stops new trades.</p></div>
    <div className="settings-section" id="settings-filters"><h3>Entry filters</h3><div className="settings-grid">{renderFields(['bb_length','bb_mult','min_bb_width_pct','pullback_bars','atr_length','min_atr','adx_length','adx_threshold'])}</div></div>
    <section className="settings-section" id="settings-costs"><h3>Costs & funding</h3><button type="button" className="secondary" onClick={()=>{onChange({...settings,...htxCostDefaults});setCostMessage('HTX simulation defaults applied: fee 0.06% per side; slippage 0.01; spread 0.02; funding +0.01% per 8h. Funding, spread and slippage are editable assumptions.');}}>Use HTX defaults</button><button type="button" className="secondary" disabled={costBusy} onClick={()=>void applyHtx()}>{costBusy?'Fetching HTX?':'Refresh HTX funding & spread'}</button>{costMessage&&<p role="status">{costMessage}</p>}<div className="settings-grid">{([['fee_bps','Fee per side (bps)',0,100],['slippage','Slippage per fill (price units)',0,10],['spread','Full bid/ask spread (price units)',0,10],['funding_bps','Signed funding / swap rate per 8h (bps)',-100,100]] as const).map(([key,label,min,max])=><label key={key}>{label}<input type="number" required min={min} max={max} step="any" value={settings[key]} onChange={e=>onChange({...settings,[key]:Number(e.target.value)})}/></label>)}</div><p className="settings-help">Defaults: fee 6 bps is a public taker estimate; slippage 0.01 and spread 0.02 are XAG price assumptions; funding 1 bp per 8h is a scenario, not a fixed HTX rate. Your account tier may differ. 1 bp = 0.01%. Slippage plus half the spread worsens each fill. Positive perpetual funding: longs pay, shorts receive; negative reverses this. Funding is prorated over time at entry notional, not historical exchange settlement rates. Funding and swap refer to the same perpetual charge here.</p></section>
    <div className="settings-section" id="settings-stops"><h3>Stop loss & trailing</h3><div className="settings-grid">{renderFields(['initial_sl','trail_trigger','trail_distance','trail_multiplier'])}</div><p className="settings-help">The multiplier scales both trailing activation and trailing distance. Price distances are per unit, not total account loss.</p></div>
    <div className="settings-section" id="settings-rsi-exit"><div className="section-heading"><h3>RSI + price exit</h3><label className="stage-switch"><input type="checkbox" role="switch" aria-label="Enable RSI and price exit" checked={config.rsi_exit_enabled??false} onChange={e=>onChange({...settings,bb_reversal:{...config,rsi_exit_enabled:e.target.checked}})}/>Enable optional exit</label></div>
      {config.rsi_exit_enabled?<><div className="settings-grid">{renderFields(['rsi_exit_length','rsi_exit_move','rsi_exit_short','rsi_exit_long'])}</div><p className="settings-help">Both sides: close price − entry price &gt; {config.rsi_exit_move}. Short: RSI &lt; {config.rsi_exit_short}. Long: RSI &gt; {config.rsi_exit_long}. Checked at the execution candle close. This upward price move is against a short position. Existing stop protection remains active.</p></>:<p className="settings-help">Off. Enable to close using your price-difference and RSI conditions.</p>}
    </div>
    <div className="settings-section" id="settings-trend"><div className="section-heading"><h3>SMA trend adjustment</h3><label className="stage-switch"><input type="checkbox" role="switch" aria-label="Use SMA Trend Adjustment" checked={config.use_sma_trend_adjustment} onChange={e=>onChange({...settings,bb_reversal:{...config,use_sma_trend_adjustment:e.target.checked}})}/>Use SMA Trend Adjustment</label></div>
      {config.use_sma_trend_adjustment?<><div className="settings-grid">{renderFields(['sma_length','sma_slope_bars','counter_profit_pct','counter_sl_pct'])}</div><p className="settings-help">Countertrend trades use the selected reduced stop and trailing distances.</p></>:<p>Normal stop and trailing distances apply to every trade. The SMA line is hidden.</p>}
    </div>
  </div>;
}

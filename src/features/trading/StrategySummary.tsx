import type {BacktestSettings} from '../../shared/types/types';
import {adxSupertrendDefaults,stScalperDefaults} from '../strategy/strategyDefaults';

type Rule=[label:string,value:string];

/** Plain-language rules of the active SuperTrend Scalper setup. */
function scalperRules(settings:BacktestSettings):Rule[]{
  const c={...stScalperDefaults,...settings.st_scalper};
  const filters=[c.use_trend_filter&&`${c.htf_timeframe} EMA ${c.htf_ema_length} + EMA ${c.ema_fast_length}`,c.use_adx_filter&&`ADX > ${c.adx_threshold}`,c.use_rsi_filter&&'RSI band',
    c.use_volatility_filter&&'ATR percentile',c.use_regime_filter&&'regime',c.use_session_filter&&c.sessions.join('/'),c.use_news_filter&&'news',c.use_volume_filter&&'volume'].filter(Boolean).join(' · ');
  return [
    ['Entry',`SuperTrend ${c.st_length}/${c.st_multiplier} flip, next-candle open`],
    ['Exit',c.use_atr_exits?`SL ${c.stop_atr} · TP ${c.target_atr} ATR · BE ${c.breakeven_atr} · trail ${c.trail_atr} · ${c.max_hold_bars} candles`:'Opposite flip (stop and reverse)'],
    ['Filters',filters||'None'],
    ['Risk',`${c.risk_pct}% of equity per trade`],
  ];
}

/** Plain-language rules of the active ADX + Supertrend setup. */
function adxSupertrendRules(settings:BacktestSettings):Rule[]{
  const c={...adxSupertrendDefaults,...settings.adx_supertrend};
  const filters=[c.htf_filter&&`${c.htf_timeframe} trend`,c.atr_filter&&`ATR ≥ ${c.atr_min}`,c.rsi_filter&&`RSI ${c.rsi_overbought}/${c.rsi_oversold}`,c.forecast_filter&&`forecast ≥ ${Math.round(c.forecast_min_probability*100)}%`].filter(Boolean).join(' · ');
  return [
    ['Entry',`ADX ≥ ${c.adx_threshold} and rising, Supertrend ${c.st_length}/${c.st_multiplier} direction`],
    ['Exit','Supertrend trailing stop or opposite flip'],
    ['Filters',filters||'None'],
    ['Direction',c.trade_mode],
  ];
}

function describe(settings:BacktestSettings):{title:string;rules?:Rule[];summary?:string}{
  switch(settings.strategy){
    case 'none':return {title:'No strategy configured',summary:'Market viewing only'};
    case 'st_scalper':return {title:'SuperTrend Scalper rules',rules:scalperRules(settings)};
    case 'adx_supertrend':return {title:'ADX + Supertrend rules',rules:adxSupertrendRules(settings)};
    case 'ml_directional':{
      const ml=settings.ml_directional;
      return {title:'ML Directional',summary:`TP ${ml.take_profit_atr} / SL ${ml.stop_atr} × ATR · ${ml.max_hold_bars}-bar hold · ${ml.trade_mode}`};
    }
    default:return {title:'BB Outer Band Reversal',summary:'Trailing SL / Both directions'};
  }
}

/** Strategy card under the bot controls (paper and live): name, rules and a link to edit them. */
export default function StrategySummary({settings,note,onConfigure}:{settings:BacktestSettings;note?:string;onConfigure?:()=>void}){
  const {title,rules,summary}=describe(settings);
  return <div className="strategy-card">
    <header><strong>{title}</strong>{onConfigure&&<button type="button" className="text-button" onClick={onConfigure}>Edit ↗</button>}</header>
    {rules?<dl className="strategy-rules">{rules.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>:<small>{summary}</small>}
    {note&&<small>{note}</small>}
  </div>;
}

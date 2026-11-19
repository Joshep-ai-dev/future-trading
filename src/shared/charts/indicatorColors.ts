import type {IndicatorConfig,IndicatorKind} from './indicatorConfig';
import {adxColor} from './adxDisplay';

// RSI and ATR use one plot color like TradingView; ADX uses its weak / trend / strong zone colors.
export function indicatorColor(kind:IndicatorKind,value:number|null,config:IndicatorConfig):string {
  if(kind==='atr')return config.atrColor;
  if(kind==='rsi')return config.rsiColor;
  return adxColor(value,config);
}

/** Hex color plus alpha, e.g. alpha('#00ff00', .65). */
export function alpha(hex:string,opacity:number){return `${hex}${Math.round(opacity*255).toString(16).padStart(2,'0')}`;}

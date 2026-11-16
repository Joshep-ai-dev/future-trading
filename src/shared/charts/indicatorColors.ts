import type {IndicatorConfig,IndicatorKind} from './IndicatorSettings';
import {adxColor} from './adxDisplay';

// RSI and ATR use one plot color like TradingView; ADX uses its weak / trend / strong zone colors.
export function indicatorColor(kind:IndicatorKind,value:number|null,config:IndicatorConfig):string {
  if(kind==='atr')return config.atrColor;
  if(kind==='rsi')return config.rsiColor;
  return adxColor(value,config);
}

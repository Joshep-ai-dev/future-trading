import type {IndicatorConfig,IndicatorKind} from './IndicatorSettings';

// Color raw values; thresholds only affect chart display, never bot execution.
export function indicatorColor(kind:IndicatorKind,value:number|null,config:IndicatorConfig):string {
  if(value===null||!Number.isFinite(value))return '#90a4ae';
  if(kind==='atr')return value>config.atrThreshold?'#26a69a':'#90a4ae';
  if(kind==='rsi')return value>config.rsiUpper?'#ff8191':value<config.rsiLower?'#43d9a5':'#bd93f9';
  return value>25?'#26a69a':value>=20?'#ffb74d':'#90a4ae';
}

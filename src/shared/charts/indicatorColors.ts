import type {IndicatorConfig,IndicatorKind} from './IndicatorSettings';
import {TV,TV_STUDY_COLORS} from './tvTheme';
import {strengthColor} from './adxDisplay';

// Color raw values; thresholds only affect chart display, never bot execution.
export function indicatorColor(kind:IndicatorKind,value:number|null,config:IndicatorConfig):string {
  if(value===null||!Number.isFinite(value))return kind==='adx'?TV.muted:TV_STUDY_COLORS[kind];
  if(kind==='atr')return value>config.atrThreshold?TV.up:TV_STUDY_COLORS.atr;
  if(kind==='rsi')return value>config.rsiUpper?TV.down:value<config.rsiLower?TV.up:TV_STUDY_COLORS.rsi;
  return strengthColor(value);
}

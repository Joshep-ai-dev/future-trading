import {defaultBollinger,type BollingerConfig} from './bollingerBands';

/** Studies drawn in their own pane under the price chart. */
export type IndicatorKind='atr'|'adx'|'rsi';
/** Studies drawn over the price series. */
export type OverlayKind='zigzag'|'supertrend'|'bollinger'|'triplema';
/** Settings dialogs: chart indicators plus the strategy's Trend SMA line. */
export type SettingsKind=IndicatorKind|OverlayKind|'trendsma';

export type MaSmoothing='RMA'|'SMA'|'EMA'|'WMA';
export type MaType='SMA'|'EMA';

/**
 * Every study instance stores this whole flat object, so keys are prefixed per indicator.
 * Adding an indicator: add its fields here and in `defaultIndicators`, then describe them
 * in `INDICATOR_SCHEMAS` (indicatorSchema.ts) - the settings dialog, validation and reset follow.
 */
export type IndicatorConfig={
  // Zig Zag
  zigzagDeviation:number;zigzagColor:string;zigzagWidth:number;
  // Trend SMA (strategy line, 'ma' study)
  trendSmaLength:number;trendSmaColor:string;trendSmaWidth:number;
  // Bollinger Bands
  bbLength:number;bbMaType:BollingerConfig['maType'];bbSource:BollingerConfig['source'];bbMultiplier:number;bbOffset:number;
  bbBasisColor:string;bbUpperColor:string;bbLowerColor:string;bbWidth:number;
  // Supertrend
  supertrendLength:number;supertrendMultiplier:number;stUpColor:string;stDownColor:string;stWidth:number;
  // Triple MA
  maType:MaType;maFast:number;maMid:number;maSlow:number;maFastColor:string;maMidColor:string;maSlowColor:string;maWidth:number;
  // RSI
  rsiLength:number;rsiUpper:number;rsiLower:number;rsiColor:string;rsiWidth:number;
  // ADX
  diLength:number;adxLength:number;showDi:boolean;showStatus:boolean;showAdxLevels:boolean;adxTrendLevel:number;adxStrongLevel:number;
  adxWeakColor:string;adxTrendColor:string;adxStrongColor:string;diPlusColor:string;diMinusColor:string;
  adxBullBgColor:string;adxBearBgColor:string;adxWidth:number;
  // ATR
  atrLength:number;atrSmoothing:MaSmoothing;atrThreshold:number;atrColor:string;atrWidth:number;
};

/** TradingView built-in defaults (inputs and plot colors). */
export const defaultIndicators:Readonly<IndicatorConfig>={
  zigzagDeviation:5,zigzagColor:'#2962ff',zigzagWidth:2,
  trendSmaLength:30,trendSmaColor:'#ff9800',trendSmaWidth:1,
  bbLength:defaultBollinger.length,bbMaType:defaultBollinger.maType,bbSource:defaultBollinger.source,
  bbMultiplier:defaultBollinger.multiplier,bbOffset:defaultBollinger.offset,
  bbBasisColor:'#2962ff',bbUpperColor:'#f23645',bbLowerColor:'#089981',bbWidth:1,
  supertrendLength:10,supertrendMultiplier:3,stUpColor:'#4caf50',stDownColor:'#f23645',stWidth:1,
  maType:'SMA',maFast:20,maMid:50,maSlow:100,maFastColor:'#00ff00',maMidColor:'#ff0000',maSlowColor:'#ffff00',maWidth:2,
  rsiLength:14,rsiUpper:70,rsiLower:30,rsiColor:'#7e57c2',rsiWidth:1,
  diLength:14,adxLength:14,showDi:false,showStatus:true,showAdxLevels:true,adxTrendLevel:25,adxStrongLevel:50,
  adxWeakColor:'#787b86',adxTrendColor:'#ff9800',adxStrongColor:'#4caf50',diPlusColor:'#00e676',diMinusColor:'#f23645',
  adxBullBgColor:'#4caf50',adxBearBgColor:'#f23645',adxWidth:2,
  atrLength:14,atrSmoothing:'RMA',atrThreshold:0.03,atrColor:'#b71c1c',atrWidth:1,
};

import type {ReactNode} from 'react';
import {TIMEFRAMES} from './chartTimeframe';

export default function TradingChartHeader({timeframe,onTimeframeChange,mode,caption,actions}:{timeframe:string;onTimeframeChange?:(timeframe:string)=>void;mode:string;caption:string;actions?:ReactNode}){
  return <div className="panel-heading trading-chart-heading"><div className="chart-title"><strong>XAGUSDT</strong><label className="chart-timeframe-label"><span className="sr-only">Chart timeframe</span><select aria-label="Chart timeframe" className="chart-timeframe-select" value={timeframe} disabled={!onTimeframeChange} onChange={event=>onTimeframeChange?.(event.target.value)}>{Object.keys(TIMEFRAMES).map(value=><option key={value} value={value}>{value}</option>)}</select></label><span className="chart-mode">{mode}</span></div><div className="trading-chart-heading-meta">{actions}{caption&&<span className="chart-caption">{caption}</span>}</div></div>;
}

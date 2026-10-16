import type {ReactNode} from 'react';
import {TIMEFRAMES} from './chartTimeframe';

export default function TradingChartHeader({timeframe,onTimeframeChange,mode,caption,actions}:{timeframe:string;onTimeframeChange?:(timeframe:string)=>void;mode:string;caption:string;actions?:ReactNode}){
  return <div className="panel-heading trading-chart-heading tv-header">
    <div className="chart-title"><strong>XAGUSDT</strong>
      <div className="tv-timeframes" role="radiogroup" aria-label="Chart timeframe">{onTimeframeChange?Object.keys(TIMEFRAMES).map(value=><button key={value} type="button" role="radio" aria-checked={value===timeframe} onClick={()=>onTimeframeChange(value)}>{value}</button>):<button type="button" role="radio" aria-checked disabled>{timeframe}</button>}</div>
      <span className="chart-mode">{mode}</span>
    </div>
    <div className="trading-chart-heading-meta">{actions}{caption&&<span className="chart-caption">{caption}</span>}</div>
  </div>;
}

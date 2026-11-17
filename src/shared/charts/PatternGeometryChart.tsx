import {useId} from 'react';
import type {PatternCandle} from '../../features/trading/patternRange';
import {formatPatternTime} from '../../features/trading/patternRange';
import type {PatternAssessment} from '../../features/trading/patternStructure';
import type {SwingPoint} from '../../features/trading/zigzag';

export default function PatternGeometryChart({candles,pivots,provisional,boundaries=[],breakout=false}:{
  candles:readonly PatternCandle[];pivots:readonly SwingPoint[];provisional:SwingPoint|null;
  boundaries?:PatternAssessment['boundaries'];breakout?:boolean;
}){
  const clip=useId();
  if(!candles.length)return null;
  const step=candles.length>1?candles[1].time-candles[0].time:0;
  const low=Math.min(...candles.map(row=>row.low??row.close)),high=Math.max(...candles.map(row=>row.high??row.close)),span=high-low||1;
  const x=(index:number)=>30+index/Math.max(1,candles.length-1)*620,y=(value:number)=>190-(value-low)/span*155;
  const points=(rows:readonly {index:number;value:number}[])=>rows.map(row=>`${x(row.index)},${y(row.value)}`).join(' ');
  const last=candles.length-1,prior=pivots.at(-1);
  return <svg className="pattern-geometry-chart" viewBox="0 0 700 230" role="img" aria-label="Selected OHLC candles, confirmed ZigZag pivots, unfinished swing and fitted pattern boundaries">
    <defs><clipPath id={clip}><rect x="20" y="20" width="650" height="185"/></clipPath></defs>
    {[0,.5,1].map(fraction=><g key={fraction}><line x1="25" x2="655" y1={y(low+span*fraction)} y2={y(low+span*fraction)} stroke="currentColor" opacity=".12"/><text x="660" y={y(low+span*fraction)+3} fill="currentColor" fontSize="9">{(low+span*fraction).toFixed(3)}</text></g>)}
    <g clipPath={`url(#${clip})`}>
      {candles.map((row,index)=><line key={row.time} x1={x(index)} x2={x(index)} y1={y(row.high??row.close)} y2={y(row.low??row.close)} stroke="#aaa" opacity=".35"/>)}
      <polyline points={points(candles.map((row,index)=>({index,value:row.close})))} fill="none" stroke="#62b5ff" strokeWidth="1.5"/>
      <polyline points={points(pivots)} fill="none" stroke="#52c9a0" strokeWidth="2"/>
      {provisional&&prior&&<polyline points={points([prior,provisional])} fill="none" stroke="#b3b3b3" strokeWidth="1.5" strokeDasharray="4 4"/>}
      {boundaries.map(boundary=><g key={boundary.label}><line x1={x(boundary.from.index)} x2={x(boundary.to.index)} y1={y(boundary.from.value)} y2={y(boundary.to.value)} stroke="#e9b949" strokeWidth="1.5" strokeDasharray="6 4"/><text x={x(boundary.from.index)+4} y={y(boundary.from.value)-5} fill="#e9b949" fontSize="10">{boundary.label}</text></g>)}
      {pivots.map((pivot,index)=><g key={`${pivot.index}-${pivot.high}`}><circle cx={x(pivot.index)} cy={y(pivot.value)} r="3" fill={pivot.high?'#f07984':'#52c9a0'}/><text x={x(pivot.index)+3} y={y(pivot.value)+(pivot.high?-7:13)} fill="currentColor" fontSize="9">{pivot.high?'H':'L'}{index+1}</text><title>{pivot.high?'High':'Low'} {pivot.value.toFixed(4)} · pivot candle {formatPatternTime(candles[pivot.index].time)} UTC+9 · confirmed at close {formatPatternTime(candles[pivot.confirmedAt??pivot.index].time+step)} UTC+9</title></g>)}
      {provisional&&<circle cx={x(provisional.index)} cy={y(provisional.value)} r="4" fill="none" stroke="#bbb"><title>Unfinished swing: excluded from geometric rules</title></circle>}
      {breakout&&<circle cx={x(last)} cy={y(candles[last].close)} r="6" fill="none" stroke="#fff" strokeWidth="2"><title>Closing breakout {candles[last].close.toFixed(4)}</title></circle>}
    </g>
    <text x="25" y="222" fill="currentColor" fontSize="10">{formatPatternTime(candles[0].time)} UTC+9</text>
    <text x="650" y="222" textAnchor="end" fill="currentColor" fontSize="10">{formatPatternTime(candles[last].time)} UTC+9</text>
  </svg>;
}

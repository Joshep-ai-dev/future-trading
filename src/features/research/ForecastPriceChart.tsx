import {useState} from 'react';
import {fmt} from '../../shared/types/types';
export type PricePoint={time:number;close:number};
export type ForecastPoint={path?:PricePoint[];originTime:number;targetTime:number;originClose:number;predictedClose:number;predictedHigh:number;predictedLow:number};
const stamp=(value:number)=>new Date(value*1000).toISOString().replace('T',' ').slice(0,16);

export default function ForecastPriceChart({history,actual=[],forecast,predictions=[]}:{history:PricePoint[];actual?:PricePoint[];forecast?:ForecastPoint;predictions?:PricePoint[]}){
  const [windowSize,setWindowSize]=useState(100),[hover,setHover]=useState<PricePoint|null>(null);
  const past=history.slice(-windowSize),shownPredictions=predictions.filter(p=>!past.length||p.time>=past[0].time),series=[...past,...actual,...shownPredictions];
  if(forecast?.path)series.push(...forecast.path);
  if(forecast)series.push({time:forecast.targetTime,close:forecast.predictedClose},{time:forecast.targetTime,close:forecast.predictedHigh},{time:forecast.targetTime,close:forecast.predictedLow});
  if(!series.length)return <p className="forecast-empty">Price chart will appear after a prediction or test.</p>;
  const left=Math.min(...series.map(p=>p.time)),right=Math.max(...series.map(p=>p.time));
  const min=Math.min(...series.map(p=>p.close)),max=Math.max(...series.map(p=>p.close)),pad=Math.max((max-min)*.12,.01);
  const x=(time:number)=>70+(time-left)/Math.max(1,right-left)*860,y=(price:number)=>260-(price-min+pad)/(max-min+2*pad)*220;
  const line=(values:PricePoint[])=>values.map(p=>`${x(p.time)},${y(p.close)}`).join(' ');
  const future=forecast?x(forecast.originTime):null;
  return <figure className="forecast-chart forecast-price-chart"><figcaption><strong>Silver price | USDT</strong><div><span className="forecast-actual">Actual close</span><span className="forecast-predicted">Forecast</span></div><label>History <select value={windowSize} onChange={e=>setWindowSize(Number(e.target.value))}>{[25,50,100,1000,3000].map(n=><option key={n} value={n}>{n} points</option>)}</select></label></figcaption>
    <svg viewBox="0 0 980 310" role="img" aria-label="Actual silver prices and future forecast" onMouseMove={event=>{const rect=event.currentTarget.getBoundingClientRect();const time=left+((event.clientX-rect.left)/rect.width*980-70)/860*(right-left);setHover(series.reduce((best,p)=>Math.abs(p.time-time)<Math.abs(best.time-time)?p:best,series[0]));}} onMouseLeave={()=>setHover(null)}>
      {future!=null&&<rect x={future} y="25" width={Math.max(0,930-future)} height="240" fill="#799dff" opacity=".07"/>}
      {[0,1,2,3,4].map(i=>{const price=min-pad+(max-min+2*pad)*i/4;return <g key={i}><line x1="70" x2="930" y1={y(price)} y2={y(price)} stroke="#263449"/><text x="5" y={y(price)+4}>{fmt(price,3)}</text></g>;})}
      <polyline points={line(past)} stroke="#54d6aa" strokeWidth="2" fill="none"/>
      <polyline points={line(actual.length&&past.length?[past[past.length-1],...actual]:actual)} stroke="#54d6aa" strokeWidth="2" fill="none"/>
      <polyline points={line(shownPredictions)} stroke="#87aaff" strokeWidth="2" fill="none"/>
      {forecast&&<>{forecast.path?.length?<polyline points={line([{time:forecast.originTime,close:forecast.originClose},...forecast.path])} stroke="#87aaff" strokeWidth="2.5" fill="none"/>:<line x1={x(forecast.originTime)} x2={x(forecast.targetTime)} y1={y(forecast.originClose)} y2={y(forecast.predictedClose)} stroke="#87aaff" strokeWidth="2.5" strokeDasharray="7 5"/>}{[forecast.predictedHigh,forecast.predictedLow].map((price,index)=><line key={index} x1={x(forecast.originTime)} x2={x(forecast.targetTime)} y1={y(price)} y2={y(price)} stroke="#87aaff" opacity=".4" strokeDasharray="3 6"/>)}<circle cx={x(forecast.targetTime)} cy={y(forecast.predictedClose)} r="5" fill="#87aaff"/><text x={Math.min(800,x(forecast.originTime)+10)} y="20">FORECAST HORIZON</text></>}
      {hover&&<><line x1={x(hover.time)} x2={x(hover.time)} y1="25" y2="265" stroke="#71809b" strokeDasharray="4 4"/><circle cx={x(hover.time)} cy={y(hover.close)} r="4" fill="#fff"/></>}
      <text x="70" y="295">{stamp(left)}</text><text x="930" y="295" textAnchor="end">{stamp(right)} UTC</text>
    </svg><div className="forecast-chart-caption">{hover?`${stamp(hover.time)} UTC | ${fmt(hover.close,4)} USDT`:forecast?.path?.length?'Each blue point is a learned prediction for a future candle close. High/low guides are estimates, not confidence bounds.':forecast?'Dashed line connects the known start price to the predicted end price; it is not a predicted intrabar path. High/low guides are excursion estimates, not confidence bounds.':'Forecasts are aligned with their target close times. Hover to inspect prices.'}</div>
  </figure>;
}

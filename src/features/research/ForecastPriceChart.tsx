import {useState} from 'react';
import {priceAxis,timeAxis} from './forecastAxes';
import {fmt} from '../../shared/types/types';
export type PricePoint={time:number;close:number};
export type ForecastPoint={path?:PricePoint[];originTime:number;targetTime:number;originClose:number;predictedClose:number;predictedHigh:number;predictedLow:number};
const stamp=(value:number)=>new Date(value*1000).toISOString().replace('T',' ').slice(0,16);

export default function ForecastPriceChart({history,actual=[],forecast,predictions=[]}:{history:PricePoint[];actual?:PricePoint[];forecast?:ForecastPoint;predictions?:PricePoint[]}){
  const [windowSize,setWindowSize]=useState(100),[hoverTime,setHoverTime]=useState<number|null>(null),[showGuides,setShowGuides]=useState(false);
  const past=history.slice(-windowSize),shownPredictions=predictions.filter(p=>!past.length||p.time>=past[0].time),series=[...past,...actual,...shownPredictions];
  if(forecast?.path)series.push(...forecast.path);
  if(forecast){series.push({time:forecast.targetTime,close:forecast.predictedClose});if(showGuides)series.push({time:forecast.targetTime,close:forecast.predictedHigh},{time:forecast.targetTime,close:forecast.predictedLow});}
  if(!series.length)return <p className="forecast-empty">Price chart will appear after a prediction or test.</p>;
  const left=Math.min(...series.map(p=>p.time)),right=Math.max(...series.map(p=>p.time));
  const axis=priceAxis(Math.min(...series.map(p=>p.close)),Math.max(...series.map(p=>p.close)));
  const times=timeAxis(left,right);
  const priceLabel=(value:number)=>value.toLocaleString('en-US',{minimumFractionDigits:axis.decimals,maximumFractionDigits:axis.decimals});
  const x=(time:number)=>70+(time-left)/Math.max(1,right-left)*860,y=(price:number)=>260-(price-axis.low)/(axis.high-axis.low)*220;
  const line=(values:PricePoint[])=>values.map(p=>`${x(p.time)},${y(p.close)}`).join(' ');
  const future=forecast?x(forecast.originTime):null;
  const forecastPoints=[...shownPredictions,...(forecast?.path||[])];
  const nearest=hoverTime==null?null:[...past,...actual,...forecastPoints].reduce<PricePoint|null>((best,p)=>!best||Math.abs(p.time-hoverTime)<Math.abs(best.time-hoverTime)?p:best,null);
  const actualAt=nearest?[...past,...actual].find(p=>p.time===nearest.time):null;
  const forecastAt=nearest?forecastPoints.find(p=>p.time===nearest.time):null;
  const tooltip=nearest?`${stamp(nearest.time)} UTC | Actual: ${actualAt?fmt(actualAt.close,4):'pending'} | Prediction: ${forecastAt?fmt(forecastAt.close,4):'-'}${actualAt&&forecastAt?` | Error: ${fmt(forecastAt.close-actualAt.close,4)}`:''}`:null;
  return <figure className="forecast-chart forecast-price-chart"><figcaption><strong>Silver price | USDT</strong><div><span className="forecast-actual"><i className="forecast-line-key"/>Actual price</span><span className="forecast-predicted"><i className="forecast-line-key is-dashed"/>Prediction</span></div><label className="forecast-guides-toggle"><input type="checkbox" checked={showGuides} onChange={event=>setShowGuides(event.target.checked)}/> Range guides</label><label>History <select value={windowSize} onChange={e=>setWindowSize(Number(e.target.value))}>{[25,50,100,1000,3000].map(n=><option key={n} value={n}>{n} points</option>)}</select></label></figcaption>
    <svg viewBox="0 0 980 330" role="img" aria-label="Actual silver prices and future forecast" onMouseMove={event=>{const rect=event.currentTarget.getBoundingClientRect();const time=left+((event.clientX-rect.left)/rect.width*980-70)/860*(right-left);setHoverTime(time);}} onMouseLeave={()=>setHoverTime(null)}>
      {future!=null&&<rect x={future} y="25" width={Math.max(0,930-future)} height="240" fill="#799dff" opacity=".07"/>}
      {axis.ticks.map(price=><g key={price}><line x1="70" x2="930" y1={y(price)} y2={y(price)} stroke="#263449"/><text x="5" y={y(price)+4}>{priceLabel(price)}</text></g>)}
      {times.map(time=><g key={time}><line x1={x(time)} x2={x(time)} y1="40" y2="265" stroke="#263449" strokeDasharray="2 5"/><text x={x(time)} y="286" textAnchor="middle">{stamp(time).slice(11)}</text><text x={x(time)} y="302" textAnchor="middle">{stamp(time).slice(0,10)}</text></g>)}
      <polyline points={line(past)} stroke="#54d6aa" strokeWidth="2" fill="none"/>
      <polyline points={line(actual.length&&past.length?[past[past.length-1],...actual]:actual)} stroke="#54d6aa" strokeWidth="2" fill="none"/>
      {actual.length>0&&<circle cx={x(actual[actual.length-1].time)} cy={y(actual[actual.length-1].close)} r="4" fill="#54d6aa"/>}
      <polyline points={line(shownPredictions)} stroke="#87aaff" strokeWidth="2" strokeDasharray="7 5" fill="none"/>
      {forecastPoints.map((point,index)=><circle key={`${point.time}-${index}`} cx={x(point.time)} cy={y(point.close)} r="3" fill="#87aaff" stroke="#0b1420" strokeWidth="1"><title>{stamp(point.time)} UTC | Prediction {priceLabel(point.close)} USDT</title></circle>)}
      {forecast&&<>{forecast.path?.length?<polyline points={line([{time:forecast.originTime,close:forecast.originClose},...forecast.path])} stroke="#87aaff" strokeWidth="2.5" strokeDasharray="7 5" fill="none"/>:<line x1={x(forecast.originTime)} x2={x(forecast.targetTime)} y1={y(forecast.originClose)} y2={y(forecast.predictedClose)} stroke="#87aaff" strokeWidth="2.5" strokeDasharray="7 5"/>}{showGuides&&[forecast.predictedHigh,forecast.predictedLow].map((price,index)=><line key={index} x1={x(forecast.originTime)} x2={x(forecast.targetTime)} y1={y(price)} y2={y(price)} stroke="#87aaff" opacity=".4" strokeDasharray="3 6"/>)}<circle cx={x(forecast.targetTime)} cy={y(forecast.predictedClose)} r="5" fill="#87aaff"/><text x={Math.min(800,x(forecast.originTime)+10)} y="20">FORECAST HORIZON</text></>}
      {nearest&&<><line x1={x(nearest.time)} x2={x(nearest.time)} y1="25" y2="265" stroke="#71809b" strokeDasharray="4 4"/><circle cx={x(nearest.time)} cy={y(nearest.close)} r="4" fill="#fff"/></>}
      <text x="70" y="322">Price unit: {priceLabel(axis.unit)} USDT</text><text x="930" y="322" textAnchor="end">Date / time (UTC)</text>
    </svg><div className="forecast-chart-caption">{tooltip?tooltip:forecast?.path?.length?'Solid green: actual prices. Dashed blue: predictions issued ahead of the target. Hover for timestamp-aligned prices and error; range guides are estimates, not confidence bounds.':forecast?'Dashed line connects the known start price to the predicted end price; it is not a predicted intrabar path. High/low guides are excursion estimates, not confidence bounds.':'Forecasts are aligned with their target close times. Hover to inspect prices.'}</div>
  </figure>;
}

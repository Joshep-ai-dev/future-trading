import {useId,useRef,useState,type PointerEvent} from 'react';
import {fmt} from '../../shared/types/types';

/** Balance after each closed trade, starting from the initial capital. */
export function balanceSeries(capital:number,pnls:number[]){
  const values=[capital];
  for(const pnl of pnls)values.push(values[values.length-1]+pnl);
  return values;
}

/** Percentage below the running peak at each balance point (0 or negative). */
export function drawdownSeries(balances:number[]){
  let peak=-Infinity;
  return balances.map(value=>{peak=Math.max(peak,value);return peak>0?(value-peak)/peak*100:0;});
}

const W=300,H=100,PAD=6;
type Marker={index:number;label:string;tone:'good'|'bad'|'muted'};

/**
 * Responsive area chart with markers and a hover readout. Markers and the
 * readout are HTML laid over the SVG so they stay round when the SVG stretches.
 */
function AreaChart({values,color,fillFrom,baseline,markers,format,label,invert=false}:{values:number[];color:string;fillFrom:'top'|'bottom';baseline?:number;markers:Marker[];format:(value:number,index:number)=>string;label:string;invert?:boolean}){
  const id=useId(),box=useRef<HTMLDivElement>(null),[hover,setHover]=useState<number|null>(null);
  if(values.length<2)return null;
  const min=Math.min(...values,baseline??Infinity),max=Math.max(...values,baseline??-Infinity),span=max-min||1;
  const x=(index:number)=>index/(values.length-1)*W;
  const y=(value:number)=>invert?PAD+(max-value)/span*(H-2*PAD):H-PAD-(value-min)/span*(H-2*PAD);
  const line=values.map((value,index)=>`${index?'L':'M'}${x(index).toFixed(2)},${y(value).toFixed(2)}`).join('');
  const edge=fillFrom==='top'?0:H;
  const pct=(index:number,value:number)=>({left:`${x(index)/W*100}%`,top:`${y(value)/H*100}%`});
  function move(event:PointerEvent<HTMLDivElement>){
    const rect=box.current?.getBoundingClientRect();
    if(!rect)return;
    setHover(Math.max(0,Math.min(values.length-1,Math.round((event.clientX-rect.left)/rect.width*(values.length-1)))));
  }
  return <div className="area-chart" ref={box} onPointerMove={move} onPointerLeave={()=>setHover(null)} role="img" aria-label={label}>
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id={id} x1="0" y1={fillFrom==='top'?'1':'0'} x2="0" y2={fillFrom==='top'?'0':'1'}><stop offset="0" stopColor={color} stopOpacity=".32"/><stop offset="1" stopColor={color} stopOpacity="0"/></linearGradient></defs>
      {baseline!=null&&<line x1="0" x2={W} y1={y(baseline)} y2={y(baseline)} className="area-baseline" vectorEffect="non-scaling-stroke"/>}
      <path d={`${line}L${W},${edge}L0,${edge}Z`} fill={`url(#${id})`}/>
      <path d={line} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>
      {hover!=null&&<line x1={x(hover)} x2={x(hover)} y1="0" y2={H} className="area-crosshair" vectorEffect="non-scaling-stroke"/>}
    </svg>
    {markers.map(marker=><span key={`${marker.index}-${marker.label}`} className={`area-marker is-${marker.tone} ${x(marker.index)>W*.8?'is-right':x(marker.index)<W*.2?'is-left':''} ${y(values[marker.index])<H/2?'is-below':'is-above'}`} style={pct(marker.index,values[marker.index])}><i/>{marker.label&&<b>{marker.label}</b>}</span>)}
    {hover!=null&&<><span className="area-dot" style={{...pct(hover,values[hover]),background:color}}/><span className={`area-tip ${x(hover)>W*.6?'is-right':''} ${y(values[hover])<H/2?'is-low':''}`} style={{left:`${x(hover)/W*100}%`}}>{format(values[hover],hover)}</span></>}
  </div>;
}

/** Balance after each trade with start, peak and end markers. */
export function BalanceSparkline({values,positive}:{values:number[];positive:boolean}){
  if(values.length<2)return null;
  const peak=values.indexOf(Math.max(...values)),end=values.length-1;
  const markers:Marker[]=[{index:0,label:'',tone:'muted'},{index:end,label:'',tone:positive?'good':'bad'}];
  if(peak!==0&&peak!==end)markers.push({index:peak,label:`Peak $${fmt(values[peak],0)}`,tone:'good'});
  return <AreaChart values={values} color={positive?'var(--green)':'var(--red)'} fillFrom="bottom" baseline={values[0]} markers={markers}
    label="Balance after each trade" format={(value,index)=>`${index?`Trade ${index}`:'Start'} · $${fmt(value)}`}/>;
}

/** Underwater chart: distance below the previous balance peak, worst point marked. */
export function DrawdownChart({values}:{values:number[]}){
  if(values.length<2)return null;
  const worst=values.indexOf(Math.min(...values));
  return <AreaChart values={values} color="var(--red)" fillFrom="top" baseline={0} invert={false}
    markers={worst>0?[{index:worst,label:`${fmt(values[worst],1)}%`,tone:'bad'}]:[]}
    label="Drawdown from the previous balance peak" format={(value,index)=>`${index?`Trade ${index}`:'Start'} · ${fmt(value,2)}%`}/>;
}

/** Win/loss donut with the win rate in the middle. */
export function WinDonut({wins,losses}:{wins:number;losses:number}){
  const total=wins+losses,radius=40,circumference=2*Math.PI*radius,share=total?wins/total:0,gap=total&&wins&&losses?2:0;
  return <svg className="win-donut" viewBox="0 0 100 100" role="img" aria-label={`${wins} wins and ${losses} losses`}>
    <circle cx="50" cy="50" r={radius} fill="none" stroke="var(--surface-raised)" strokeWidth="10"/>
    {losses>0&&<circle cx="50" cy="50" r={radius} fill="none" stroke="var(--red)" strokeWidth="10" strokeLinecap="round" strokeDasharray={`${Math.max(0,(1-share)*circumference-gap)} ${circumference}`} transform={`rotate(${share*360-90+gap/circumference*180} 50 50)`}/>}
    {wins>0&&<circle cx="50" cy="50" r={radius} fill="none" stroke="var(--green)" strokeWidth="10" strokeLinecap="round" strokeDasharray={`${Math.max(0,share*circumference-gap)} ${circumference}`} transform={`rotate(${-90+gap/circumference*180} 50 50)`}/>}
    <text x="50" y="50" textAnchor="middle" className="win-donut-value">{total?Math.round(share*100):0}%</text>
    <text x="50" y="64" textAnchor="middle" className="win-donut-label">win rate</text>
  </svg>;
}

/** Average win against average loss as two proportional bars. */
export function PayoffBars({avgWin,avgLoss}:{avgWin:number;avgLoss:number}){
  const loss=Math.abs(avgLoss),largest=Math.max(avgWin,loss,1e-9);
  return <div className="payoff-bars" aria-label="Average win compared with average loss">
    <div><span>Avg win</span><i><b className="is-good" style={{width:`${avgWin/largest*100}%`}}/></i><em className="positive">+${fmt(avgWin)}</em></div>
    <div><span>Avg loss</span><i><b className="is-bad" style={{width:`${loss/largest*100}%`}}/></i><em className="negative">-${fmt(loss)}</em></div>
  </div>;
}

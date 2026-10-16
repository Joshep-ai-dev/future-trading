import {useId} from 'react';

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

const W=300,H=64;
function path(values:number[],min:number,max:number){
  const span=max-min||1,step=values.length>1?W/(values.length-1):W;
  return values.map((value,index)=>`${index?'L':'M'}${(index*step).toFixed(1)},${(H-2-(value-min)/span*(H-4)).toFixed(1)}`).join('');
}

/** Area sparkline of the balance with a dashed start-capital baseline. */
export function BalanceSparkline({values,positive}:{values:number[];positive:boolean}){
  const id=useId();
  if(values.length<2)return null;
  const min=Math.min(...values),max=Math.max(...values),line=path(values,min,max);
  const base=H-2-(values[0]-min)/((max-min)||1)*(H-4);
  const color=positive?'var(--green)':'var(--red)';
  return <svg className="mini-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Balance after each trade">
    <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity=".28"/><stop offset="1" stopColor={color} stopOpacity="0"/></linearGradient></defs>
    <line x1="0" x2={W} y1={base} y2={base} stroke="var(--border-strong)" strokeDasharray="3 4" vectorEffect="non-scaling-stroke"/>
    <path d={`${line}L${W},${H}L0,${H}Z`} fill={`url(#${id})`}/>
    <path d={line} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round"/>
  </svg>;
}

/** Red "underwater" area showing distance below the previous balance peak. */
export function DrawdownChart({values}:{values:number[]}){
  const id=useId();
  if(values.length<2)return null;
  const min=Math.min(...values,-0.0001),step=W/(values.length-1);
  const line=values.map((value,index)=>`${index?'L':'M'}${(index*step).toFixed(1)},${(value/min*(H-4)+1).toFixed(1)}`).join('');
  return <svg className="mini-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Drawdown from the previous balance peak">
    <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--red)" stopOpacity=".05"/><stop offset="1" stopColor="var(--red)" stopOpacity=".35"/></linearGradient></defs>
    <line x1="0" x2={W} y1="1" y2="1" stroke="var(--border-strong)" vectorEffect="non-scaling-stroke"/>
    <path d={`${line}L${W},1L0,1Z`} fill={`url(#${id})`}/>
    <path d={line} fill="none" stroke="var(--red)" strokeWidth="1.4" vectorEffect="non-scaling-stroke" strokeLinejoin="round"/>
  </svg>;
}

/** Win/loss donut with the win rate in the middle. */
export function WinDonut({wins,losses}:{wins:number;losses:number}){
  const total=wins+losses,radius=40,circumference=2*Math.PI*radius,share=total?wins/total:0;
  return <svg className="win-donut" viewBox="0 0 100 100" role="img" aria-label={`${wins} wins and ${losses} losses`}>
    <circle cx="50" cy="50" r={radius} fill="none" stroke={total?'var(--red)':'var(--border-strong)'} strokeWidth="11" opacity={total?.85:1}/>
    {total>0&&<circle cx="50" cy="50" r={radius} fill="none" stroke="var(--green)" strokeWidth="11" strokeDasharray={`${share*circumference} ${circumference}`} transform="rotate(-90 50 50)"/>}
    <text x="50" y="49" textAnchor="middle" className="win-donut-value">{total?Math.round(share*100):0}%</text>
    <text x="50" y="63" textAnchor="middle" className="win-donut-label">win rate</text>
  </svg>;
}

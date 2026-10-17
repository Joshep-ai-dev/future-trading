import {useCallback,useEffect,useState} from 'react';
import {api} from '../../shared/api/api';
import {fmt} from '../../shared/types/types';

type Match={start:number;end:number;distance:number;correlation:number;futureClosePct:number;futureHighPct:number;futureLowPct:number;path:number[];future:number[]};
type Band=Record<string,number[]>;
type PatternResult={window:number;horizon:number;end:number;stepSeconds:number;current:number;query:number[];matches:Match[];
  projection:{close:Band;high:Band;low:Band};
  summary:{probabilityUp:number;expectedClose:number;expectedHigh:number;highP90:number;expectedLow:number;lowP10:number;averageCorrelation:number;candidates:number}};

const TIMEFRAMES=['5m','15m','30m','1h','4h'] as const;
const when=(t:number)=>new Date(t*1000).toISOString().slice(0,16).replace('T',' ');
const pct=(value:number)=>`${value>=0?'+':''}${fmt(value,2)}%`;
const W=900,H=320,PAD={left:8,right:74,top:14,bottom:22};

function PatternChart({result,highlight}:{result:PatternResult;highlight:number|null}){
  const {window,horizon,query,matches,projection,current}=result;
  const total=window+horizon;
  const values=[...query,...projection.high.p90,...projection.low.p10,...matches.flatMap(m=>[...m.path,...m.future])];
  const min=Math.min(...values),max=Math.max(...values),span=max-min||1;
  const x=(step:number)=>PAD.left+step/(total-1)*(W-PAD.left-PAD.right);
  const y=(price:number)=>PAD.top+(max-price)/span*(H-PAD.top-PAD.bottom);
  const line=(points:number[],offset=0)=>points.map((value,index)=>`${index?'L':'M'}${x(index+offset).toFixed(1)},${y(value).toFixed(1)}`).join('');
  const area=(upper:number[],lower:number[])=>`${line([current,...upper],window-1)}${[...[current,...lower]].reverse().map((value,index)=>`L${x(window-1+lower.length-index).toFixed(1)},${y(value).toFixed(1)}`).join('')}Z`;
  const tag=(price:number,label:string,tone:string)=><g className={`pattern-tag is-${tone}`}><line x1={x(total-1)} x2={W-PAD.right+4} y1={y(price)} y2={y(price)}/><rect x={W-PAD.right+4} y={y(price)-9} width={PAD.right-6} height={18} rx={3}/><text x={W-PAD.right+8} y={y(price)+4}>{label} {fmt(price,3)}</text></g>;
  return <svg className="pattern-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Current pattern, similar past patterns and projected range">
    <rect className="pattern-future-zone" x={x(window-1)} y={PAD.top} width={x(total-1)-x(window-1)} height={H-PAD.top-PAD.bottom}/>
    <text className="pattern-axis" x={x(window-1)+6} y={H-6}>Now → next {horizon} candles</text>
    <text className="pattern-axis" x={PAD.left} y={H-6}>{window} candles ago</text>
    <path className="pattern-band-outer" d={area(projection.high.p90,projection.low.p10)}/>
    <path className="pattern-band-inner" d={area(projection.close.p90,projection.close.p10)}/>
    {matches.map((match,index)=><g key={match.start} className={`pattern-match ${match.futureClosePct>=0?'is-up':'is-down'} ${highlight===index?'is-active':''} ${highlight!=null&&highlight!==index?'is-dim':''}`}>
      <path d={line(match.path)}/><path d={line([match.path.at(-1)!,...match.future],window-1)}/>
    </g>)}
    <path className="pattern-median" d={line([current,...projection.close.p50],window-1)}/>
    <path className="pattern-high" d={line([current,...projection.high.p50],window-1)}/>
    <path className="pattern-low" d={line([current,...projection.low.p50],window-1)}/>
    <path className="pattern-query" d={line(query)}/>
    <circle className="pattern-now" cx={x(window-1)} cy={y(current)} r={4}/>
    {tag(result.summary.highP90,'H90','up')}{tag(result.summary.expectedHigh,'H50','up-soft')}{tag(result.summary.expectedLow,'L50','down-soft')}{tag(result.summary.lowP10,'L10','down')}
  </svg>;
}

/** Find past windows shaped like the latest candles and project the next high and low. */
export default function PatternPanel({defaultTimeframe='15m'}:{defaultTimeframe?:string}){
  const [timeframe,setTimeframe]=useState<string>(TIMEFRAMES.includes(defaultTimeframe as typeof TIMEFRAMES[number])?defaultTimeframe:'15m');
  const [window,setWindow]=useState(48),[horizon,setHorizon]=useState(24),[topK,setTopK]=useState(20);
  const [result,setResult]=useState<PatternResult|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [highlight,setHighlight]=useState<number|null>(null);
  const analyze=useCallback(async()=>{
    setBusy(true);setError('');
    try{setResult(await api<PatternResult>('/api/patterns',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({timeframe,window,horizon,top_k:topK})}));}
    catch(reason){setError(String(reason));}finally{setBusy(false);}
  },[timeframe,window,horizon,topK]);
  useEffect(()=>{void analyze();},[]);// eslint-disable-line react-hooks/exhaustive-deps
  const summary=result?.summary;
  const minutes=result?Math.round(result.horizon*result.stepSeconds/60):0;
  return <div className="pattern-panel">
    <form className="pattern-controls" onSubmit={event=>{event.preventDefault();void analyze();}}>
      <label>Timeframe<select value={timeframe} onChange={event=>setTimeframe(event.target.value)}>{TIMEFRAMES.map(tf=><option key={tf}>{tf}</option>)}</select></label>
      <label>Pattern length<input type="number" min={8} max={500} value={window} onChange={event=>setWindow(Number(event.target.value))}/></label>
      <label>Look ahead<input type="number" min={1} max={500} value={horizon} onChange={event=>setHorizon(Number(event.target.value))}/></label>
      <label>Matches<input type="number" min={1} max={200} value={topK} onChange={event=>setTopK(Number(event.target.value))}/></label>
      <button type="submit" className="secondary" disabled={busy}>{busy?'Searching…':'Find similar patterns'}</button>
    </form>
    {error&&<p className="exchange-inline-error">{error}</p>}
    {result&&summary&&<>
      <div className="pattern-summary">
        <div><span>Chance of closing higher</span><strong className={summary.probabilityUp>=.5?'positive':'negative'}>{fmt(summary.probabilityUp*100,0)}%</strong><small>in {result.horizon} candles (~{minutes>=120?`${fmt(minutes/60,1)} h`:`${minutes} min`})</small></div>
        <div><span>Expected high</span><strong className="positive">{fmt(summary.expectedHigh,3)}</strong><small>90% case {fmt(summary.highP90,3)} ({pct((summary.highP90/result.current-1)*100)})</small></div>
        <div><span>Expected low</span><strong className="negative">{fmt(summary.expectedLow,3)}</strong><small>10% case {fmt(summary.lowP10,3)} ({pct((summary.lowP10/result.current-1)*100)})</small></div>
        <div><span>Expected close</span><strong>{fmt(summary.expectedClose,3)}</strong><small>now {fmt(result.current,3)}</small></div>
        <div><span>Pattern similarity</span><strong>{fmt(summary.averageCorrelation,2)}</strong><small>avg correlation · {summary.candidates.toLocaleString()} windows scanned</small></div>
      </div>
      <div className="pattern-body">
        <div className="pattern-chart-wrap">
          <PatternChart result={result} highlight={highlight}/>
          <div className="pattern-legend"><span><i className="is-query"/>Current pattern</span><span><i className="is-up"/>Match that rose</span><span><i className="is-down"/>Match that fell</span><span><i className="is-band"/>10–90% high/low range</span><span><i className="is-median"/>Median close</span></div>
        </div>
        <div className="pattern-table" onMouseLeave={()=>setHighlight(null)}>
          <table><thead><tr><th>#</th><th>Matched window (UTC)</th><th>Similarity</th><th>Then high</th><th>Then low</th><th>Then close</th></tr></thead><tbody>
            {result.matches.map((match,index)=><tr key={match.start} className={highlight===index?'selected-row':''} onMouseEnter={()=>setHighlight(index)}>
              <td>{index+1}</td><td>{when(match.start)} → {when(match.end).slice(11)}</td><td>{fmt(match.correlation,2)}</td>
              <td className="positive">{pct(match.futureHighPct)}</td><td className="negative">{pct(match.futureLowPct)}</td>
              <td className={match.futureClosePct>=0?'positive':'negative'}>{pct(match.futureClosePct)}</td></tr>)}
          </tbody></table>
        </div>
      </div>
      <p className="pattern-note">Shapes are compared after removing price level and volatility. Only past windows whose full future was already known are used. Similar history is not a forecast guarantee.</p>
    </>}
  </div>;
}

import {useEffect,useId,useMemo,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {IChartApi} from 'lightweight-charts';
import {patternCatalog} from '../../features/trading/patternCatalog';
import {recognizePatterns,type GeometricMatch} from '../../features/trading/patternRecognition';
import {selectPatternRange,formatPatternTime,type PatternCandle} from '../../features/trading/patternRange';
import PatternGeometryChart from './PatternGeometryChart';
import {TIMEFRAMES} from './chartTimeframe';
import '../../features/trading/patternLibrary.css';
import './patternRange.css';

type Ref<T>={current:T|null};
type Props={active:boolean;onFinish:()=>void;chartRef:Ref<IChartApi>;containerRef:Ref<HTMLDivElement>;getCandles:()=>PatternCandle[];timeframe:string;symbol:string;clock:()=>number};
function Overlay({match}:{match:GeometricMatch}){
  const line=(values:number[])=>values.map((value,index)=>`${10+index/(values.length-1)*380},${140-value*125}`).join(' ');
  return <svg viewBox="0 0 400 155" role="img" aria-label={`Selected curve compared with ${match.pattern.name}`}><polyline points={line(match.reference)} fill="none" stroke="#e9b949" strokeWidth="2" strokeDasharray="6 4"/><polyline points={line(match.curve)} fill="none" stroke="#62b5ff" strokeWidth="2"/></svg>;
}

export default function PatternRangeAnalyzer({active,onFinish,chartRef,containerRef,getCandles,timeframe,symbol,clock}:Props){
  const [bounds,setBounds]=useState({left:0,top:0,width:0,height:0});
  const [band,setBand]=useState<[number,number]|null>(null),[error,setError]=useState('');
  const [selection,setSelection]=useState<PatternCandle[]|null>(null);
  const [reversalAtr,setReversalAtr]=useState(1.5);
  const snapshot=useRef<PatternCandle[]>([]),anchor=useRef<number|null>(null),dragStart=useRef<number|null>(null);
  const dialog=useRef<HTMLDialogElement>(null),title=useId();
  const seconds=TIMEFRAMES[timeframe as keyof typeof TIMEFRAMES]??300;
  const analysis=useMemo(()=>selection?recognizePatterns(selection,patternCatalog,{reversalAtr}):null,[selection,reversalAtr]);
  const identified=analysis?.matches??[],rejected=analysis?.rejected.slice(0,3)??[];
  const featured=identified.find(item=>item.assessment.status==='confirmed')??identified[0];
  function resultCard(match:GeometricMatch){
    const assessment=match.assessment;
    return <article key={match.pattern.id} className="reference-detail">
      <h3>{match.pattern.name}</h3>
      <strong>{assessment.status==='confirmed'?'Closing breakout passed structural rules':assessment.status==='forming'?'Structure forming — awaiting closing breakout':'Rejected geometry candidate'}</strong>
      <small className={`pattern-direction is-${assessment.status==='rejected'||assessment.status==='unverified'?'undetermined':assessment.direction}`}>{assessment.status==='rejected'||assessment.status==='unverified'?'No direction assigned to an unverified candidate':assessment.direction==='undetermined'?'Direction undecided until a closing breakout':`${assessment.direction==='bullish'?'Bullish':'Bearish'} ${assessment.status==='confirmed'?'breakout':'setup (not confirmed)'}`}</small>
      <strong>{Math.round(match.score)}/100 pattern quality</strong>
      {assessment.level!==null&&<small>Breakout boundary {assessment.level.toFixed(4)}</small>}
      <dl className="pattern-quality-components"><div><dt>Geometry · 30%</dt><dd>{Math.round(assessment.components.geometry)}</dd></div><div><dt>Trendlines · 25%</dt><dd>{Math.round(assessment.components.trendlines)}</dd></div><div><dt>Symmetry · 15%</dt><dd>{Math.round(assessment.components.symmetry)}</dd></div><div><dt>Structure · 20%</dt><dd>{Math.round(assessment.components.structure)}</dd></div><div><dt>Template · 10%</dt><dd>{Math.round(match.templateFit)}</dd></div></dl>
      <PatternGeometryChart candles={selection??[]} pivots={assessment.pivots} provisional={assessment.provisional} boundaries={assessment.boundaries} breakout={assessment.status==='confirmed'}/>
      <details><summary>Secondary template comparison</summary><Overlay match={match}/><small>Blue: selected closes. Dashed gold: aligned reference sketch. This comparison does not decide whether a structure exists.</small></details>
      <details open={assessment.status==='rejected'||assessment.status==='unverified'}><summary>Structural checks ({assessment.checks.filter(check=>check.passed).length}/{assessment.checks.length})</summary><ul className="pattern-structure-checks">{assessment.checks.map(check=><li key={check.label} className={check.passed?'passed':'failed'}><b>{check.passed?'Pass':'Fail'}: {check.label}</b><span>{check.detail}</span></li>)}</ul></details>
    </article>;
  }
  useEffect(()=>{
    setSelection(null);anchor.current=null;setBand(null);setError('');
  },[timeframe,symbol]);
  useEffect(()=>{
    if(!active)return;
    snapshot.current=getCandles().map(row=>({...row}));anchor.current=null;setBand(null);setError('');
    const host=containerRef.current;if(!host)return;
    const measure=()=>setBounds({left:host.offsetLeft,top:host.offsetTop,width:chartRef.current?.timeScale().width()??host.clientWidth,height:chartRef.current?.panes()[0]?.getHeight()??host.clientHeight});
    measure();const observer=new ResizeObserver(measure);observer.observe(host);
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();onFinish();}};
    document.addEventListener('keydown',escape);
    return()=>{observer.disconnect();document.removeEventListener('keydown',escape);};
  },[active,timeframe,symbol]);
  useEffect(()=>{
    if(!selection)return;
    const element=dialog.current,previous=document.activeElement as HTMLElement|null;
    element?.showModal();return()=>{element?.close();previous?.focus();};
  },[selection]);
  function timeAt(x:number):number|null{
    const scale=chartRef.current?.timeScale();if(!scale)return null;
    const time=scale.coordinateToTime(x);if(typeof time==='number')return time;
    const logical=scale.coordinateToLogical(x);if(logical===null||!snapshot.current.length)return null;
    return snapshot.current[Math.max(0,Math.min(snapshot.current.length-1,Math.round(Number(logical))))].time;
  }
  function analyze(first:number,last:number){
    try{const rows=selectPatternRange(snapshot.current,first,last,seconds,clock());setSelection(rows);onFinish();}
    catch(reason){setError(reason instanceof Error?reason.message:String(reason));anchor.current=null;setBand(null);}
  }
  return <>
    {active&&<>
      <div className="pattern-selection-help" role="status">{error||'Drag across the price chart, or click the first and last candles. Include the preceding trend and at least 20 completed candles.'}<button type="button" onClick={()=>{
        const range=chartRef.current?.timeScale().getVisibleRange();if(range&&typeof range.from==='number'&&typeof range.to==='number')analyze(range.from,range.to);
      }}>Analyze visible area</button><button type="button" onClick={onFinish}>Cancel (Esc)</button></div>
      <div className="pattern-selection-layer" style={{left:bounds.left,top:bounds.top,width:bounds.width,height:bounds.height}} aria-label="Select candle range for pattern analysis"
        onPointerDown={event=>{
          if(event.button!==0)return;event.preventDefault();event.stopPropagation();event.currentTarget.setPointerCapture(event.pointerId);
          const x=Math.max(0,Math.min(bounds.width,event.clientX-event.currentTarget.getBoundingClientRect().left));
          dragStart.current=x;if(anchor.current===null)anchor.current=x;setBand([anchor.current,x]);
        }}
        onPointerMove={event=>{if(anchor.current!==null){const x=Math.max(0,Math.min(bounds.width,event.clientX-event.currentTarget.getBoundingClientRect().left));setBand([anchor.current,x]);}}}
        onPointerCancel={()=>{anchor.current=null;dragStart.current=null;setBand(null);}}
        onPointerUp={event=>{
          if(event.button!==0||anchor.current===null||dragStart.current===null)return;
          const x=Math.max(0,Math.min(bounds.width,event.clientX-event.currentTarget.getBoundingClientRect().left));
          if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
          if(Math.abs(x-anchor.current)>4){const first=timeAt(anchor.current),last=timeAt(x);if(first!==null&&last!==null)analyze(first,last);}
          dragStart.current=null;
        }}>
        {band&&<div className="pattern-selected-band" style={{left:Math.min(...band),width:Math.max(2,Math.abs(band[1]-band[0]))}}/>}
      </div>
    </>}
    {selection&&createPortal(<dialog ref={dialog} className="pattern-analysis-dialog" aria-labelledby={title} onCancel={event=>{event.preventDefault();setSelection(null);}} onClick={event=>{if(event.target===event.currentTarget){const rect=event.currentTarget.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)setSelection(null);}}}>
      <header><div><h2 id={title}>Pattern analysis · {symbol} · {timeframe}</h2><p>{selection.length} completed candles · {formatPatternTime(selection[0].time)} to {formatPatternTime(selection.at(-1)!.time+seconds)} UTC+9</p></div><button type="button" autoFocus onClick={()=>setSelection(null)}>Close</button></header>
      <p className="pattern-pipeline">Selected OHLC → ATR ZigZag swings → Geometric rules → Quality ranking</p>
      <div className="pattern-analysis-controls"><label>Swing reversal threshold<select value={reversalAtr} onChange={event=>setReversalAtr(Number(event.target.value))}>{[.75,1,1.5,2,3,4].map(value=><option key={value} value={value}>{value} × ATR(14)</option>)}</select></label><span>Higher thresholds ignore smaller swings. The unfinished leg is never used to validate geometry.</span></div>
      <p>Blue: completed closes. Green: confirmed ZigZag legs. Grey dashed: unfinished leg. Gold: fitted support, resistance or neckline. A white ring marks a verified closing breakout.</p>
      <div className="pattern-analysis-verdict" role="status"><strong>{identified.some(item=>item.assessment.status==='confirmed')?'Closing breakout verified by the displayed rules':identified.length?'Structure forming — no closing breakout confirmed':'No valid pattern in this selection.'}</strong><p>Identification requires at least 20 candles, confirmed ATR swings and every geometric rule to pass. Template resemblance contributes only 10% of the ranking after validation. Unsupported families remain reference-only.</p></div>
      {analysis&&<><p>{analysis.zigzag.pivots.length} confirmed pivots · {analysis.supported} geometric formations checked · {analysis.unsupported} other reference entries have no detector. Quality ranks geometry; it is not a win probability.</p><PatternGeometryChart candles={selection} pivots={analysis.zigzag.pivots} provisional={analysis.zigzag.provisional} boundaries={featured?.assessment.boundaries} breakout={featured?.assessment.status==='confirmed'}/></>}
      {identified.length>0&&<div className="pattern-analysis-results">{identified.slice(0,5).map(resultCard)}</div>}
      {rejected.length>0&&<details><summary>Rejected candidates — inspect failed rules ({rejected.length})</summary><div className="pattern-analysis-results">{rejected.map(resultCard)}</div></details>}
      <button type="button" onClick={()=>setSelection(null)}>Close analysis</button>
    </dialog>,document.body)}
  </>;
}

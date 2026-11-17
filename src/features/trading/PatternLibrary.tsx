import {useEffect,useMemo,useState} from 'react';
import {api} from '../../shared/api/api';
import {fmt} from '../../shared/types/types';
import {patternCatalog,type PatternReference} from './patternCatalog';
import {formatPatternTime} from './patternRange';
import {rankReferencePatterns,resemblanceLabel,type ReferenceMatch} from './patternSimilarity';
import {aggregateMinutes} from '../../shared/charts/aggregateTimeframe';
import {mergeHistory} from '../../shared/charts/candleHistory';
import {TIMEFRAMES} from '../../shared/charts/chartTimeframe';
import './patternLibrary.css';

function Shape({values,label,tone='Either'}:{values:number[];label:string;tone?:string}){
  const low=Math.min(...values),span=Math.max(...values)-low||1;
  const points=values.map((value,index)=>`${12+index/Math.max(1,values.length-1)*276},${108-(value-low)/span*92}`).join(' ');
  return <svg className={`reference-shape bias-${tone.toLowerCase()}`} viewBox="0 0 300 124" role="img" aria-label={label}>
    {[30,62,94].map(y=><line key={y} x1={8} x2={292} y1={y} y2={y} className="reference-grid"/>)}
    <polyline points={points} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round"/>
  </svg>;
}

function ReferenceCard({pattern,remove}:{pattern:PatternReference;remove:()=>void}){
  return <article className="reference-detail"><header><div><h4>{pattern.name}</h4><small>{pattern.group} · {pattern.bias} context</small></div><button type="button" className="text-button" aria-label={`Remove ${pattern.name} from comparison`} onClick={remove}>Remove</button></header>
    <Shape values={pattern.shape} label={`${pattern.name}: illustrative shape`} tone={pattern.bias}/>
    <dl><dt>Inspect</dt><dd>{pattern.check}</dd><dt>Watch for</dt><dd>{pattern.watch}</dd></dl>
  </article>;
}

function MatchOverlay({match}:{match:ReferenceMatch}){
  const points=(values:number[])=>values.map((value,index)=>`${12+index/(values.length-1)*276},${108-value*92}`).join(' ');
  return <svg className="reference-shape" viewBox="0 0 300 124" role="img" aria-label={`Current price curve overlaid on ${match.pattern.name}`}>
    <polyline points={points(match.reference)} fill="none" stroke="#e9b949" strokeWidth={2} strokeDasharray="5 4"/>
    <polyline points={points(match.curve)} fill="none" stroke="#62b5ff" strokeWidth={2}/>
  </svg>;
}

export default function PatternLibrary({defaultTimeframe='5m'}:{defaultTimeframe?:string}){
  const [search,setSearch]=useState(''),[group,setGroup]=useState('All'),[bias,setBias]=useState('All');
  const [selected,setSelected]=useState<string[]>([]);
  const [timeframe,setTimeframe]=useState(['5m','15m','30m','1h','4h'].includes(defaultTimeframe)?defaultTimeframe:'5m');
  const [length,setLength]=useState(48),[refresh,setRefresh]=useState(0);
  const [autoRefresh,setAutoRefresh]=useState(true),[feedNote,setFeedNote]=useState('');
  const [market,setMarket]=useState<{time:number;close:number}[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{
    const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    setMarket([]);setFeedNote('');
    async function load(){
      setBusy(true);setError('');
      try{
        const [history,live]=await Promise.allSettled([
          api<{candles:{time:number;close:number}[]}>('/api/candles',{method:'POST',signal:abort.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({timeframe,limit:length})}),
          api<{candles:{time:number;open:number;high:number;low:number;close:number}[];checkedAt:number}>('/api/market/live-candles',{signal:abort.signal}),
        ]);
        if(abort.signal.aborted)return;
        if(history.status==='rejected')throw history.reason;
        const duration=TIMEFRAMES[timeframe as keyof typeof TIMEFRAMES];
        const recent=live.status==='fulfilled'?aggregateMinutes(live.value.candles,duration,live.value.checkedAt):[];
        const completed=mergeHistory(history.value.candles,recent).filter(row=>row.time+duration<=Date.now()/1000).slice(-length);
        setMarket(completed);
        setFeedNote(live.status==='rejected'?'Live feed unavailable; showing stored candles.':'');
      }catch(reason){if(!abort.signal.aborted){setError(String(reason));setMarket([]);}}
      finally{if(!abort.signal.aborted){setBusy(false);if(autoRefresh)timer=setTimeout(()=>void load(),15000);}}
    }
    void load();
    return()=>{abort.abort();if(timer)clearTimeout(timer);};
  },[timeframe,length,refresh,autoRefresh]);
  const duration=TIMEFRAMES[timeframe as keyof typeof TIMEFRAMES];
  const continuous=market.every((row,index)=>!index||row.time-market[index-1].time===duration);
  const matches=useMemo(()=>continuous?rankReferencePatterns(market.map(row=>row.close),patternCatalog,{mode:'end'}):[],[market,continuous]);
  const filtered=useMemo(()=>patternCatalog.filter(pattern=>(group==='All'||pattern.group===group)&&(bias==='All'||pattern.bias===bias)&&pattern.name.toLowerCase().includes(search.trim().toLowerCase())),[search,group,bias]);
  function toggle(id:string){setSelected(previous=>previous.includes(id)?previous.filter(value=>value!==id):previous.length<3?[...previous,id]:previous);}
  return <div className="pattern-library">
    <header className="reference-heading"><div><h3>Chart pattern library</h3><p>Browse 45 reference entries. Select up to three to compare with each other and the market snapshot.</p></div></header>
    <div className="reference-controls">
      <label>Search patterns<input type="search" value={search} placeholder="Try triangle, flag, bottom…" onChange={event=>setSearch(event.target.value)}/></label>
      <label>Family<select value={group} onChange={event=>setGroup(event.target.value)}>{['All','Reversal','Continuation','Bilateral','Overview'].map(value=><option key={value}>{value}</option>)}</select></label>
      <label>Context<select value={bias} onChange={event=>setBias(event.target.value)}>{['All','Bullish','Bearish','Either'].map(value=><option key={value}>{value}</option>)}</select></label>
      <button type="button" className="secondary" onClick={()=>{setSearch('');setGroup('All');setBias('All');}}>Reset filters</button>
    </div>
    <section className="reference-comparison" aria-label="Pattern comparison">
      <div className="reference-market reference-detail"><h4>Market snapshot · {timeframe}</h4>
        <div className="reference-controls"><label>Timeframe<select value={timeframe} onChange={event=>setTimeframe(event.target.value)}>{['5m','15m','30m','1h','4h'].map(value=><option key={value}>{value}</option>)}</select></label>
          <label>Candles<select value={length} onChange={event=>setLength(Number(event.target.value))}>{[24,48,96,192].map(value=><option key={value}>{value}</option>)}</select></label><button type="button" className="secondary" disabled={busy} onClick={()=>setRefresh(value=>value+1)}>{busy?'Loading…':'Refresh'}</button><label><input type="checkbox" checked={autoRefresh} onChange={event=>setAutoRefresh(event.target.checked)}/>Auto refresh (15s)</label></div>
        {error?<p role="alert">{error}</p>:market.length>1?<><Shape values={market.map(row=>row.close)} label={`${timeframe} market close prices, scaled to the comparison frame`}/><p>{market.length} completed candles · Last close {fmt(market.at(-1)!.close,3)}</p><small>{formatPatternTime(market[0].time)} to {formatPatternTime(market.at(-1)!.time)} UTC+9 (candle open times)</small></>:<p role="status">{busy?'Loading market candles…':'Not enough candles for comparison.'}</p>}
      </div>
      {selected.map(id=>{const pattern=patternCatalog.find(item=>item.id===id)!;return <ReferenceCard key={id} pattern={pattern} remove={()=>toggle(id)}/>;})}
    </section>
    <section className="reference-matches" aria-label="Closest patterns to current price curve">
      <h3>Closest patterns to the current curve</h3>
      <p className="pattern-note">Blue: actual completed closes. Dashed gold: reference shape aligned to swing timing. Score: 0 is what a typical random walk reaches on that sketch, 100 an exact match. Confidence: share of random walks whose best match in the catalog is weaker. Neither is a win probability or breakout confirmation. A pattern may fill only the most recent part of the window; "Forming" means everything except the breakout leg matches.</p>
      {feedNote&&<p role="status">{feedNote}</p>}
      {!!market.length&&Date.now()/1000-market.at(-1)!.time-duration>duration*2&&<p role="status">Candle data is delayed. These matches describe the displayed snapshot.</p>}
      {matches.length>0?<><button type="button" className="secondary" onClick={()=>setSelected(matches.slice(0,3).map(match=>match.pattern.id))}>Compare top 3</button><div className="reference-comparison">{matches.slice(0,5).map((match,index)=><article key={match.pattern.id} className="reference-detail"><h4>#{index+1} {match.pattern.name}</h4><strong>{fmt(match.score,0)}/100 vs chance · {resemblanceLabel(match)}</strong><small>{match.stage==='forming'?'Reference without breakout leg':'Reference including breakout leg'} · last {match.length} of {market.length} candles · fit {fmt(match.fit,0)} · confidence {fmt(match.confidence,0)}%</small><MatchOverlay match={match}/><p>{match.pattern.check}</p><button type="button" className="secondary" onClick={()=>setSelected([match.pattern.id])}>Compare this pattern</button></article>)}</div></>:<p role="status">{busy?'Matching completed candles…':error?'Load market candles to find similar patterns.':!continuous?'Missing candles interrupt this window. Choose a shorter window or refresh history.':'No usable curve to match: at least 8 candles with price variation are required.'}</p>}
    </section>
    <p className="pattern-note">Original schematics show typical geometry. Each reference chart is scaled independently. Confirm swing structure and the actual breakout on your price chart. Some patterns can serve more than one role; context labels are browsing aids. Identical reference drawings share one ranking entry.</p>
    <div className="reference-count" role="status">{filtered.length} of {patternCatalog.length} entries · {selected.length}/3 selected{selected.length===3?' · Remove one to compare another':''}<button type="button" className="text-button" onClick={()=>setSelected([])}>Clear comparison</button></div>
    <div className="reference-catalog" aria-label="Browse pattern references">{filtered.map(pattern=>{
      const checked=selected.includes(pattern.id);
      return <button key={pattern.id} type="button" className={`reference-tile ${checked?'is-selected':''}`} aria-pressed={checked} disabled={!checked&&selected.length===3} onClick={()=>toggle(pattern.id)}>
        <span>{pattern.name}</span><Shape values={pattern.shape} label={`${pattern.name} schematic`} tone={pattern.bias}/><small>{pattern.group} · {pattern.bias}</small><b>{checked?'Selected':'Compare +'}</b>
      </button>;
    })}</div>
    {!filtered.length&&<p>No patterns match these filters. Try a different name or reset the filters.</p>}
  </div>;
}

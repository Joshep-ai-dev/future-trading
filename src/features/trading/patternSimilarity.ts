import type {PatternReference} from './patternCatalog';

/** complete: the curve includes the breakout leg; forming: it matches everything before the breakout. */
export type MatchStage='complete'|'forming';
/** full: the pattern must span the whole window; end: it may occupy only the most recent part of it. */
export type MatchMode='full'|'end';
export type ReferenceMatch={
  pattern:PatternReference;
  /** Skill versus chance: 100*(1-RMSE/median random-walk RMSE) for the same sketch and search, floored at 0. */
  score:number;
  /** Geometric fit of the aligned curves, 100*(1-2*RMSE) on the 0-1 scale. */
  fit:number;
  /** Share of random walks whose best match in the whole catalog scores lower (0-100). */
  confidence:number;
  stage:MatchStage;
  /** Index of the first matched price and the number of matched prices. */
  start:number;length:number;
  curve:number[];reference:number[];
};

const SAMPLES=64,BAND=8,STEP_PENALTY=.002;
const NULL_WALKS=100,NULL_LENGTHS=[8,16,32,64,128];
const SPANS:Record<MatchMode,readonly number[]>={full:[1],end:[1,.8,.65,.5]};
// These sketches do not end in a breakout leg, so dropping their last swing is not a "forming" variant.
const NO_FORMING=new Set(['overview','pole','parabolic','channel']);

/** Linear interpolation when upsampling; area-weighted bin averages when downsampling, so no candle is skipped. */
function resample(values:readonly number[],samples:number):number[]{
  const n=values.length;
  if(n===samples)return values.slice();
  if(n<samples)return Array.from({length:samples},(_,i)=>{
    const position=i*(n-1)/(samples-1),left=Math.floor(position),fraction=position-left;
    return values[left]+fraction*(values[Math.min(left+1,n-1)]-values[left]);
  });
  const width=n/samples;
  return Array.from({length:samples},(_,i)=>{
    const from=i*width,to=from+width;let sum=0;
    for(let k=Math.floor(from);k<Math.min(n,Math.ceil(to));k++)sum+=values[k]*(Math.min(to,k+1)-Math.max(from,k));
    return sum/width;
  });
}

/** Compare geometry independently of the instrument's price level or units. */
export function normalizeCurve(values:readonly number[],samples=SAMPLES):number[]{
  if(values.length<2)return [];
  let min=Infinity,max=-Infinity,magnitude=1;
  for(const value of values){
    if(!Number.isFinite(value))return [];
    min=Math.min(min,value);max=Math.max(max,value);magnitude=Math.max(magnitude,Math.abs(value));
  }
  if(max-min<=magnitude*1e-10)return [];
  const curve=resample(values,samples);
  const low=Math.min(...curve),range=Math.max(...curve)-low;
  return range>0?curve.map(value=>(value-low)/range):[];
}

// Flat DTW buffers reused across calls; the band keeps each call to ~1,100 cells.
const width=SAMPLES+1,cells=width*width;
const cost=new Float64Array(cells),error=new Float64Array(cells),steps=new Uint16Array(cells),parent=new Uint8Array(cells);

/** Banded dynamic time warping allows modest differences in swing timing.
 * Returns the RMSE along the warping path (step penalties excluded) and, on request, the reference
 * averaged onto each curve sample for plotting.
 */
function warp(curve:readonly number[],reference:readonly number[],align:boolean):{rmse:number;aligned:number[]}{
  const n=curve.length;
  cost.fill(Infinity,0,width*width);cost[0]=0;error[0]=0;steps[0]=0;
  for(let i=1;i<=n;i++)for(let j=Math.max(1,i-BAND);j<=Math.min(n,i+BAND);j++){
    const diagonal=(i-1)*width+j-1,up=(i-1)*width+j,left=i*width+j-1;
    let best=cost[diagonal],from=diagonal,step=0;
    if(cost[up]+STEP_PENALTY<best){best=cost[up]+STEP_PENALTY;from=up;step=1;}
    if(cost[left]+STEP_PENALTY<best){best=cost[left]+STEP_PENALTY;from=left;step=2;}
    const local=(curve[i-1]-reference[j-1])**2,cell=i*width+j;
    cost[cell]=best+local;error[cell]=error[from]+local;steps[cell]=steps[from]+1;parent[cell]=step;
  }
  const end=n*width+n,rmse=Math.sqrt(error[end]/steps[end]);
  if(!align)return {rmse,aligned:[]};
  const sums=new Float64Array(n),counts=new Uint16Array(n);
  let i=n,j=n;
  while(i>0&&j>0){
    sums[i-1]+=reference[j-1];counts[i-1]++;
    const step=parent[i*width+j];if(step===0){i--;j--;}else if(step===1)i--;else j--;
  }
  return {rmse,aligned:Array.from(sums,(sum,index)=>sum/counts[index])};
}

type Template={pattern:PatternReference;stage:MatchStage;reference:number[];key:string};
const templateCache=new WeakMap<readonly PatternReference[],Template[]>();

/** One complete and, where meaningful, one forming template per distinct drawing.
 * Specific names win over broad family entries with identical drawings.
 */
function templatesFor(catalog:readonly PatternReference[]):Template[]{
  const cached=templateCache.get(catalog);if(cached)return cached;
  const seen=new Set<string>(),templates:Template[]=[];
  for(const pattern of [...catalog].sort((a,b)=>Number(a.bias==='Either')-Number(b.bias==='Either'))){
    if(pattern.group==='Overview')continue;
    const reference=normalizeCurve(pattern.shape);
    if(!reference.length)continue;
    const key=reference.map(value=>value.toFixed(5)).join(',');
    if(seen.has(key))continue;
    seen.add(key);
    templates.push({pattern,stage:'complete',reference,key});
    const forming=pattern.shape.length>=6&&!NO_FORMING.has(pattern.family)?normalizeCurve(pattern.shape.slice(0,-1)):[];
    if(forming.length)templates.push({pattern,stage:'forming',reference:forming,key:`${key}|forming`});
  }
  templateCache.set(catalog,templates);
  return templates;
}

/** Normalized curves for every candidate span; spans end at the latest price. */
function spanCurves(prices:readonly number[],mode:MatchMode):{start:number;length:number;curve:number[]}[]{
  const out:{start:number;length:number;curve:number[]}[]=[];
  for(const fraction of SPANS[mode]){
    const length=Math.round(prices.length*fraction);
    if(length<8||out.some(span=>span.length===length))continue;
    const start=prices.length-length,curve=normalizeCurve(prices.slice(start));
    if(curve.length)out.push({start,length,curve});
  }
  return out;
}

function bestSpan(spans:ReturnType<typeof spanCurves>,reference:readonly number[]){
  let best={index:-1,rmse:Infinity};
  spans.forEach((span,index)=>{const {rmse}=warp(span.curve,reference,false);if(rmse<best.rmse)best={index,rmse};});
  return best;
}

/** Deterministic Gaussian random walks (mulberry32 + Box-Muller) so scores are reproducible. */
function randomWalks(length:number):number[][]{
  let seed=0x5eed1234+length;
  const uniform=()=>{seed=(seed+0x6d2b79f5)|0;let t=Math.imul(seed^(seed>>>15),1|seed);t=(t+Math.imul(t^(t>>>7),61|t))^t;return ((t^(t>>>14))>>>0)/4294967296;};
  return Array.from({length:NULL_WALKS},()=>{
    let price=0;
    return Array.from({length},()=>price+=Math.sqrt(-2*Math.log(1-uniform()))*Math.cos(2*Math.PI*uniform()));
  });
}

type Calibration={medians:Map<string,number>;bestScores:Float64Array};
const calibrations=new WeakMap<Template[],Map<string,Calibration>>();

/** Fit random walks with the same templates, mode and span search as real data.
 * medians: typical random-walk RMSE per template (the skill-score baseline).
 * bestScores: each walk's best score across the whole catalog, which accounts for trying every sketch.
 */
function calibrate(templates:Template[],mode:MatchMode,length:number):Calibration{
  const bucket=NULL_LENGTHS.reduce((best,value)=>Math.abs(Math.log(value/length))<Math.abs(Math.log(best/length))?value:best);
  let byKey=calibrations.get(templates);
  if(!byKey){byKey=new Map();calibrations.set(templates,byKey);}
  const key=`${mode}|${bucket}`,cached=byKey.get(key);
  if(cached)return cached;
  const walks=randomWalks(bucket).map(walk=>spanCurves(walk,mode)).filter(spans=>spans.length);
  const errors=templates.map(template=>walks.map(spans=>bestSpan(spans,template.reference).rmse));
  const medians=new Map(templates.map((template,index)=>[template.key,[...errors[index]].sort((a,b)=>a-b)[Math.floor(walks.length/2)]]));
  const bestScores=Float64Array.from(walks,(_,walk)=>Math.max(0,...templates.map((template,index)=>skill(errors[index][walk],medians.get(template.key)!)))).sort();
  const calibration={medians,bestScores};
  byKey.set(key,calibration);
  return calibration;
}

const skill=(rmse:number,median:number)=>Math.max(0,Math.min(100,100*(1-rmse/median)));

/** Percentage of random walks whose best catalog score is below this score (ties count half). */
function confidenceOf(score:number,bestScores:Float64Array):number{
  let below=0,ties=0;
  for(const value of bestScores){if(value<score-1e-9)below++;else if(Math.abs(value-score)<=1e-9)ties++;}
  return 100*(below+ties/2)/bestScores.length;
}

/** Rank schematic patterns by shape resemblance to the given closes.
 * Fit alone favours simple sketches (a plain trend fits a flagpole well), so the score is a skill score against
 * random walks fitted to the same sketch with the same span search: 0 is what a typical random walk achieves and
 * 100 is an exact match. Confidence then asks how often a random walk's best match in the whole catalog is worse.
 * Scores measure geometric resemblance, never a trading probability.
 */
export function rankReferencePatterns(prices:readonly number[],catalog:readonly PatternReference[],{mode='full'}:{mode?:MatchMode}={}):ReferenceMatch[]{
  if(prices.length<8||prices.some(value=>!(value>0)||!Number.isFinite(value)))return [];
  const spans=spanCurves(prices,mode);
  if(!spans.length)return [];
  const templates=templatesFor(catalog);
  const {medians,bestScores}=calibrate(templates,mode,prices.length);
  const best=new Map<string,ReferenceMatch>();
  for(const template of templates){
    const {index,rmse}=bestSpan(spans,template.reference);
    if(index<0)continue;
    const score=skill(rmse,medians.get(template.key)!);
    const previous=best.get(template.pattern.id);
    if(previous&&previous.score>=score)continue;
    const span=spans[index];
    best.set(template.pattern.id,{pattern:template.pattern,score,fit:Math.max(0,Math.min(100,100*(1-rmse*2))),confidence:confidenceOf(score,bestScores),stage:template.stage,start:span.start,length:span.length,curve:span.curve,reference:warp(span.curve,template.reference,true).aligned});
  }
  return [...best.values()].sort((a,b)=>b.score-a.score||b.fit-a.fit||a.pattern.name.localeCompare(b.pattern.name));
}

/** Plain-language reading of a match, calibrated against random walks rather than fixed score cut-offs. */
export function resemblanceLabel(match:Pick<ReferenceMatch,'confidence'>):string{
  return match.confidence>=95?'Distinct resemblance':match.confidence>=80?'Moderate resemblance':'Not distinguishable from noise';
}

/** Secondary similarity for an already evaluated geometric candidate. This
 * does not run random-walk calibration or decide whether the structure exists.
 */
export function fitReferenceCurve(prices:readonly number[],shape:readonly number[],forming=false):{curve:number[];reference:number[];fit:number}{
  const curve=normalizeCurve(prices),reference=normalizeCurve(forming&&shape.length>=6?shape.slice(0,-1):shape);
  if(!curve.length||!reference.length)return {curve:[],reference:[],fit:0};
  const result=warp(curve,reference,true);
  return {curve,reference:result.aligned,fit:Math.max(0,Math.min(100,100*(1-result.rmse*2)))};
}

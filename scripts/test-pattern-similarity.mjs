import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

function load(file){
  const source=readFileSync(new URL(file,import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports={};new Function('exports',code)(exports);return exports;
}
const {normalizeCurve,rankReferencePatterns}=load('../src/features/trading/patternSimilarity.ts');
const {patternCatalog}=load('../src/features/trading/patternCatalog.ts');
const top=patternCatalog.find(pattern=>pattern.id==='double-top');
const bottom=patternCatalog.find(pattern=>pattern.id==='double-bottom');
const curve=normalizeCurve(top.shape).map(value=>100+value*25);
const matches=rankReferencePatterns(curve,[bottom,top]);
assert.equal(matches[0].pattern.id,top.id,'A two-peak curve should beat its inverted reference');
assert.ok(matches[0].score>99,'An exact shape should score close to 100');
const scaled=rankReferencePatterns(curve.map(value=>value*200+75),[bottom,top]);
assert.ok(Math.abs(scaled[0].score-matches[0].score)<1e-8,'Price units and level must not change similarity');
const inverted=rankReferencePatterns(curve.map(value=>300-value),[bottom,top]);
assert.equal(inverted[0].pattern.id,bottom.id,'An inverted curve should match the bottom');
for(const invalid of [[],[1,2],Array(48).fill(100),[...curve.slice(0,-1),NaN],[...curve.slice(0,-1),Infinity],curve.map(()=>0)]){
  assert.deepEqual(rankReferencePatterns(invalid,patternCatalog),[],'Invalid or flat data must not produce matches');
}
const noisy=curve.map((value,index)=>value+(index%2?4:-4));
assert.ok(rankReferencePatterns(noisy,[top])[0].score<matches[0].score,'Noise should reduce the score');
const ranked=rankReferencePatterns(curve,patternCatalog);
assert.ok(ranked.every(match=>match.score>=0&&match.score<=100&&match.reference.length===64&&match.reference.every(Number.isFinite)));
assert.ok(ranked.every((match,index)=>!index||ranked[index-1].score>=match.score),'Scores must be sorted');
assert.ok(ranked.every(match=>match.pattern.group!=='Overview'),'Category overviews are not formations');
const keys=ranked.map(match=>normalizeCurve(match.pattern.shape).map(value=>value.toFixed(5)).join(','));
assert.equal(new Set(keys).size,keys.length,'Identical drawings should not occupy multiple result slots');
assert.ok(ranked.every(match=>match.score>=0&&match.score<=100&&match.confidence>=0&&match.confidence<=100),'Scores and confidence stay in range');
assert.equal(new Set(ranked.map(match=>match.pattern.id)).size,ranked.length,'One result per pattern');

// Downsampling averages every candle instead of skipping some.
const zigzag=Array.from({length:128},(_,index)=>index%2?110:100).map((value,index)=>value+index*.01);
const averaged=normalizeCurve(zigzag);
assert.equal(averaged.length,64);
assert.ok(averaged.every((value,index)=>!index||value>=averaged[index-1]-1e-9),'A fast zigzag averages to its underlying trend');

// End mode finds a pattern that fills only the latest part of the window.
const drift=Array.from({length:64},(_,index)=>100+Math.sin(index/3)*.4);
const recent=normalizeCurve(top.shape).map(value=>100+value*25);
const window=[...drift,...recent];
const fullRank=rankReferencePatterns(window,patternCatalog).find(match=>match.pattern.id==='double-top');
const endRank=rankReferencePatterns(window,patternCatalog,{mode:'end'});
assert.equal(endRank[0].pattern.id,'double-top','End mode should find the recent double top');
assert.equal(endRank[0].length,64,'The matched span should be the recent half');
assert.ok(endRank[0].fit>fullRank.fit,'Searching recent spans should beat forcing the whole window');

// Forming detection: everything except the breakout leg.
const forming=normalizeCurve(top.shape.slice(0,-1)).map(value=>100+value*25);
const formingTop=rankReferencePatterns(forming,[top])[0];
assert.equal(formingTop.stage,'forming','A double top without its breakdown is still forming');
assert.equal(matches[0].stage,'complete');

// Random walks should rarely look like a clean pattern.
let seed=7;const rand=()=>{seed=(seed*16807)%2147483647;return seed/2147483647-.5;};
let price=100;const walk=Array.from({length:96},()=>price+=rand());
assert.ok(rankReferencePatterns(walk,patternCatalog)[0].score<matches[0].score,'A random walk scores below an exact pattern');
assert.equal(rankReferencePatterns(curve,patternCatalog)[0].confidence,100,'An exact pattern beats every random walk');
console.log('Pattern similarity checks passed: recognition, scale invariance, inversion, invalid input, noise, alignment, deduplication, averaging, recent spans, forming stage and calibration.');

const {selectPatternRange}=load('../src/features/trading/patternRange.ts');
const candles=Array.from({length:20},(_,index)=>({time:1000+index*300,close:100+index}));
const forward=selectPatternRange(candles,1600,4300,300,10000);
const backward=selectPatternRange(candles,4300,1600,300,10000);
assert.deepEqual(forward,backward,'Dragging backwards must select the same candles');
assert.equal(forward.length,10);
assert.equal(forward[0].time,1600);
assert.equal(forward.at(-1).time,4300);
const completed=selectPatternRange(candles,1000,6700,300,4000);
assert.equal(completed.at(-1).time,3700,'Exclude the still-forming candle');
candles[2].close=999;
assert.equal(forward[0].close,102,'The selection must be a frozen copy');
assert.throws(()=>selectPatternRange(candles,1000,2200,300,10000),/at least 8/);
assert.throws(()=>selectPatternRange(candles.filter((_,index)=>index!==5),1000,6700,300,10000),/missing candles/);
assert.throws(()=>selectPatternRange(candles.map((row,index)=>index===5?{...row,close:NaN}:row),1000,6700,300,10000),/invalid prices/);
const huge=Array.from({length:2001},(_,index)=>({time:1000+index*300,close:100}));
assert.throws(()=>selectPatternRange(huge,1000,1000000,300,1000000),/at most/);
console.log('Range selection checks passed: reverse drag, inclusive bounds, completed candles, frozen results, gaps and size limits.');

const {formatPatternTime}=load('../src/features/trading/patternRange.ts');
assert.equal(formatPatternTime(Date.parse('2026-11-16T23:35:00Z')/1000),'2026-11-17 08:35');
assert.equal(formatPatternTime(Date.parse('2026-11-17T01:40:00Z')/1000),'2026-11-17 10:40');
assert.equal(formatPatternTime(Date.parse('2026-12-31T20:00:00Z')/1000),'2027-01-01 05:00');

const {assessPatternStructure}=load('../src/features/trading/patternStructure.ts');
function priceBars(vertices){
  const closes=vertices.flatMap((value,index)=>index===vertices.length-1?[value]:Array.from({length:6},(_,step)=>value+(vertices[index+1]-value)*step/6));
  return closes.map((close,index)=>({time:1000+index*300,open:close,high:close+.01,low:close-.01,close}));
}
function candidate(rows,id,extra={}){
  return {...matches[0],pattern:patternCatalog.find(pattern=>pattern.id===id),start:0,length:rows.length,fit:100,confidence:100,...extra};
}
const confirmed=priceBars([100,102,106,103,106,103,100]);
assert.equal(assessPatternStructure(confirmed,candidate(confirmed,'double-top')).status,'confirmed');
const developing=priceBars([100,102,106,103,106,105,104]);
const pending=assessPatternStructure(developing,candidate(developing,'double-top'));
assert.equal(pending.status,'forming','A template stage cannot confirm a breakout absent from actual prices');
assert.equal(pending.breakout,false);
assert.ok(pending.checks.some(check=>check.label==='Closing neckline break'&&!check.passed));
const invertedBars=confirmed.map(row=>({...row,open:200-row.open,close:200-row.close,high:200-row.low,low:200-row.high}));
assert.equal(assessPatternStructure(invertedBars,candidate(invertedBars,'double-bottom')).status,'confirmed');
const unequal=priceBars([100,102,106,103,104,102,100]);
assert.equal(assessPatternStructure(unequal,candidate(unequal,'double-top')).status,'rejected','Unequal peaks cannot be confirmed just because a sketch fits');
const noTrend=priceBars([106,103,106,103,106,103,100]);
assert.equal(assessPatternStructure(noTrend,candidate(noTrend,'double-top')).status,'rejected','A top requires a prior rise');
assert.equal(assessPatternStructure(confirmed,candidate(confirmed,'double-top',{confidence:9})).status,'rejected','Low random-walk percentile cannot become a detected structure');
assert.equal(assessPatternStructure(confirmed,candidate(confirmed,'double-top',{fit:69})).status,'rejected');
assert.equal(assessPatternStructure(confirmed.map(({time,close})=>({time,close})),candidate(confirmed,'double-top')).status,'unverified','Close-only data cannot verify OHLC structure');
assert.equal(assessPatternStructure(confirmed,candidate(confirmed,'butterfly')).status,'unverified','Unsupported ratios must not be called confirmed');
assert.equal(assessPatternStructure(confirmed.slice(0,12),candidate(confirmed.slice(0,12),'double-top')).status,'unverified');
const shoulders=priceBars([100,105,110,105,116,105,110,105,100]);
assert.equal(assessPatternStructure(shoulders,candidate(shoulders,'head-and-shoulders')).status,'confirmed');
const flag=priceBars([100,104,108,112,110,112,109,111,108,110,107,109,116]);
assert.equal(assessPatternStructure(flag,candidate(flag,'bullish-flag')).status,'confirmed','Parallel pullback after an impulse and a closing break passes');
const triangle=priceBars([100,112,103,112,106,112,109,112,116]);
assert.equal(assessPatternStructure(triangle,candidate(triangle,'ascending-triangle')).status,'confirmed','Flat resistance and rising support must converge');
assert.equal(assessPatternStructure(triangle,candidate(triangle,'rectangle')).status,'rejected','Rising support is not a rectangle');
console.log('Structural and time checks passed: UTC+9 rollover, neckline breakout, forming stages, inverse structure, false positives and unsupported families.');

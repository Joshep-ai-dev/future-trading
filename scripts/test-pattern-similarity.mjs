import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

function load(file){
  return loadModule(new URL(file,import.meta.url));
}
const moduleCache=new Map();
function loadModule(url){
  if(moduleCache.has(url.href))return moduleCache.get(url.href);
  const source=readFileSync(url,'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports={};moduleCache.set(url.href,exports);
  new Function('exports','require',code)(exports,specifier=>{
    assert.ok(specifier.startsWith('.'),'Test loader only loads local modules');
    return loadModule(new URL(specifier.endsWith('.ts')?specifier:specifier+'.ts',url));
  });return exports;
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
assert.ok(pending.checks.some(check=>check.label==='Closing breakout'&&!check.passed));
const invertedBars=confirmed.map(row=>({...row,open:200-row.open,close:200-row.close,high:200-row.low,low:200-row.high}));
assert.equal(assessPatternStructure(invertedBars,candidate(invertedBars,'double-bottom')).status,'confirmed');
const unequal=priceBars([100,102,106,103,104,102,100]);
assert.equal(assessPatternStructure(unequal,candidate(unequal,'double-top')).status,'rejected','Unequal peaks cannot be confirmed just because a sketch fits');
const noTrend=priceBars([106,103,106,103,106,103,100]);
assert.equal(assessPatternStructure(noTrend,candidate(noTrend,'double-top')).status,'rejected','A top requires a prior rise');
assert.equal(assessPatternStructure(confirmed,candidate(confirmed,'double-top',{confidence:9})).status,'confirmed','Geometry is independent of random-walk resemblance');
assert.equal(assessPatternStructure(confirmed,candidate(confirmed,'double-top',{fit:69})).status,'confirmed','Template similarity cannot veto valid geometry');
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

const {detectZigZag}=load('../src/features/trading/zigzag.ts');
const {recognizePatterns,GEOMETRIC_PATTERN_IDS}=load('../src/features/trading/patternRecognition.ts');
const detectedSwings=detectZigZag(shoulders);
assert.ok(detectedSwings.pivots.length>=6);
assert.ok(detectedSwings.pivots.every((pivot,index)=>pivot.confirmedAt>pivot.index&&pivot.threshold>0&&(!index||pivot.high!==detectedSwings.pivots[index-1].high)),'Pivots must alternate and be confirmed on later bars');
assert.equal(detectedSwings.provisional.confirmedAt,null,'The latest swing remains provisional');
for(let length=2;length<=shoulders.length;length++){
  assert.deepEqual(detectZigZag(shoulders.slice(0,length)).pivots,detectedSwings.pivots.filter(pivot=>pivot.confirmedAt<length),'Appending bars must not move or rewrite confirmed pivots');
}
const outside=priceBars([100,101,103]).slice(-3).map((row,index)=>({...row,time:1000+index*300}));
outside.push({time:1900,open:103,high:120,low:90,close:95});
assert.ok(detectZigZag(outside).pivots.every(pivot=>pivot.index!==3),'An outside bar cannot confirm its own high/low order');
const noisySwings=[100,102,101,102,101,102,101,103,102,104,103,105].map((close,index)=>({time:1000+index*300,open:close,high:close+.01,low:close-.01,close}));
assert.ok(detectZigZag(noisySwings,{reversalAtr:.5}).pivots.length>detectZigZag(noisySwings,{reversalAtr:4}).pivots.length,'Higher ATR thresholds should suppress these smaller swings');
assert.deepEqual(detectZigZag([{time:1,close:10}]).pivots,[]);
assert.throws(()=>detectZigZag(confirmed,{reversalAtr:0}),/Invalid/);

const recognized=recognizePatterns(confirmed,patternCatalog);
assert.equal(recognized.supported,20);
assert.equal(GEOMETRIC_PATTERN_IDS.size,20);
assert.ok(recognized.matches.some(item=>item.pattern.id==='double-top'&&item.assessment.status==='confirmed'));
assert.ok(recognized.matches.every(item=>item.assessment.checks.filter(check=>check.label!=='Closing breakout').every(check=>check.passed)),'Similarity cannot promote a failed structure');
assert.ok(!recognizePatterns(unequal,patternCatalog).matches.some(item=>item.pattern.id==='double-top'));
const pendingRecognition=recognizePatterns(developing,patternCatalog).matches.find(item=>item.pattern.id==='double-top');
assert.equal(pendingRecognition.assessment.status,'forming');
assert.ok(pendingRecognition.assessment.boundaries.some(boundary=>boundary.label==='Neckline'));
assert.ok(recognized.matches.every(item=>item.score>=0&&item.score<=100&&item.templateFit>=0&&item.templateFit<=100));
assert.ok(recognized.matches.every((item,index)=>!index||recognized.matches[index-1].score>=item.score));
const scaledBars=confirmed.map(row=>({...row,open:row.open*10,high:row.high*10,low:row.low*10,close:row.close*10}));
assert.equal(recognizePatterns(scaledBars,patternCatalog).matches.find(item=>item.pattern.id==='double-top').assessment.status,'confirmed');
const rangeForming=priceBars([100,106,100,106,100,106,101]);
const rectanglePending=recognizePatterns(rangeForming,patternCatalog).matches.find(item=>item.pattern.id==='rectangle');
assert.equal(rectanglePending.assessment.status,'forming');
assert.equal(rectanglePending.assessment.direction,'undetermined');
const rangeBreak=priceBars([100,106,100,106,100,106,98]);
const rectangleBreak=recognizePatterns(rangeBreak,patternCatalog).matches.find(item=>item.pattern.id==='rectangle');
assert.equal(rectangleBreak.assessment.status,'confirmed');
assert.equal(rectangleBreak.assessment.direction,'bearish');
const triangleDown=priceBars([100,112,103,112,106,112,109,112,99]);
const downBreak=recognizePatterns(triangleDown,patternCatalog).matches.find(item=>item.pattern.id==='ascending-triangle');
assert.equal(downBreak.assessment.status,'confirmed');
assert.equal(downBreak.assessment.direction,'bearish','Triangle direction comes from the actual break, not its library bias');
const wickOnly=rangeForming.map(row=>({...row}));wickOnly.at(-1).high=108;
assert.notEqual(recognizePatterns(wickOnly,patternCatalog).matches.find(item=>item.pattern.id==='rectangle')?.assessment.status,'confirmed','A wick alone cannot confirm a breakout');
assert.equal(recognizePatterns(wickOnly,patternCatalog).matches.find(item=>item.pattern.id==='rectangle')?.assessment.status,'forming','An unfinished wick must not widen the geometric tolerances');
const cup=priceBars([90,95,100,98,95,93,92,93,95,98,100,97,99,104]);
assert.equal(recognizePatterns(cup,patternCatalog).matches.find(item=>item.pattern.id==='cup-and-handle')?.assessment.status,'confirmed');
const inverseCup=cup.map(row=>({...row,open:200-row.open,close:200-row.close,high:200-row.low,low:200-row.high}));
assert.equal(recognizePatterns(inverseCup,patternCatalog).matches.find(item=>item.pattern.id==='inverted-cup-and-handle')?.assessment.status,'confirmed');
const flatBars=Array.from({length:40},(_,index)=>({time:1000+index*300,open:100,high:100,low:100,close:100}));
assert.equal(recognizePatterns(flatBars,patternCatalog).matches.length,0);
assert.equal(recognizePatterns(confirmed.filter((_,index)=>index!==5),patternCatalog).matches.length,0,'Missing candles cannot validate a structure');
assert.deepEqual(detectZigZag(confirmed.map((row,index)=>index===4?{...row,time:NaN}:row)).pivots,[]);
const mirror=rows=>rows.map(row=>({...row,open:300-row.open,close:300-row.close,high:300-row.low,low:300-row.high}));
const triple=priceBars([100,102,106,103,106,103,106,103,100]);
const pennant=priceBars([90,95,110,100,109,101,108,102,107,103,112]);
const symmetrical=priceBars([100,110,101,109,102,108,103,107,104,112]);
const wedge=priceBars([100,110,103,111,106,112,109,113,106]);
const channel=priceBars([100,108,103,111,106,114,109,117,120]);
const examples=new Map([
  ['double-top',confirmed],['double-bottom',mirror(confirmed)],['triple-top',triple],['triple-bottom',mirror(triple)],
  ['head-and-shoulders',shoulders],['inverse-head-and-shoulders',mirror(shoulders)],
  ['bullish-flag',flag],['bearish-flag',mirror(flag)],['bullish-pennant',pennant],['bearish-pennant',mirror(pennant)],
  ['ascending-triangle',triangle],['descending-triangle',mirror(triangle)],['symmetrical-triangle',symmetrical],
  ['rising-wedge',wedge],['falling-wedge',mirror(wedge)],['rectangle',rangeBreak],
  ['rising-channel',channel],['falling-channel',mirror(channel)],['cup-and-handle',cup],['inverted-cup-and-handle',inverseCup],
]);
for(const [id,rows] of examples){
  const result=recognizePatterns(rows,patternCatalog);
  const match=result.matches.find(item=>item.pattern.id===id);
  const failed=result.rejected.find(item=>item.pattern.id===id)?.assessment.checks.filter(check=>!check.passed).map(check=>check.label);
  assert.equal(match?.assessment.status,'confirmed',`${id} should recognize its OHLC fixture; failed: ${failed?.join(', ')}`);
}
assert.equal(examples.size,GEOMETRIC_PATTERN_IDS.size);
console.log('Geometry-first pipeline checks passed: causal ATR pivots, unfinished legs, sensitivity, 20 formations, geometry gates, direction, wick rejection and cup/inverse cup.');

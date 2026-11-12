// Run with node scripts/test-supertrend.cjs. Uses the project's TS compiler.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/shared/charts/supertrend.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText;
const result = {exports: {}};
new Function('module', 'exports', compiled)(result, result.exports);
const {chartSupertrend,supertrendSegments} = result.exports;
const values=points=>points.map(({time,value,direction})=>({time,value,direction}));
const bars = [[10,11,9,10],[10,11,9,10],[10,14,10,13],[13,15,12,14],[14,14,8,9]]
  .map(([open,high,low,close],i)=>({time:i*300,open,high,low,close}));

// Independently hand-calculated SMA seed, Wilder updates, carried bands and flips.
assert.deepEqual(values(chartSupertrend(bars,300,2,1)), [
  {time:0,value:null,direction:null},
  {time:300,value:12,direction:'down'},
  {time:600,value:9,direction:'up'},
  {time:900,value:10.5,direction:'up'},
  {time:1200,value:15.5,direction:'down'},
]);

// No future candles influence earlier outputs; forming candles can be excluded
// by the caller without changing completed results.
const changed = bars.map((bar,i)=>i<3?bar:{...bar,high:100,close:90});
assert.deepEqual(chartSupertrend(bars,300,2,1).slice(0,3),chartSupertrend(changed,300,2,1).slice(0,3));
assert.deepEqual(chartSupertrend(bars.slice(0,3),300,2,1),chartSupertrend(bars,300,2,1).slice(0,3));

// Pine operates on available bars; missing time intervals do not reset ATR.
const afterGap = bars.slice(2).map((bar,i)=>({...bar,time:1800+i*300}));
const gapResult=chartSupertrend([...bars.slice(0,2),...afterGap],300,2,1);
assert.deepEqual(gapResult.map(p=>[p.value,p.pineDirection]),chartSupertrend(bars,300,2,1).map(p=>[p.value,p.pineDirection]));
assert.notEqual(gapResult[2].value,null);
assert.equal(chartSupertrend(bars,300,10,3).every(point=>point.value===null),true);
assert.notDeepEqual(chartSupertrend(bars,300,2,1),chartSupertrend(bars,300,2,3));
assert.deepEqual(chartSupertrend([],300),[]);
for(const [period,factor] of [[0,3],[1.5,3],[2,0],[2,NaN],[2,.005],[1001,3]]){
  assert.throws(()=>chartSupertrend(bars,300,period,factor));
}

const invalid = [...bars.slice(0,2),{...bars[2],close:NaN},...afterGap];
assert.equal(chartSupertrend(invalid,300,2,1)[2].value,null);
assert.deepEqual(values(chartSupertrend(invalid,300,2,1).slice(3)),values(chartSupertrend(afterGap,300,2,1)));
const calculated=chartSupertrend(bars,300,2,1);
assert.deepEqual(calculated.map(p=>p.pineDirection),[1,1,-1,-1,1]);
assert.deepEqual(calculated.map(p=>p.change),[null,null,'up',null,'down']);
assert.equal(chartSupertrend(bars,300,1,1)[0].value,null); // barstate.isfirst mask
assert.equal(chartSupertrend(bars,300,1,1)[0].bodyMiddle,null);
assert.equal(calculated[2].bodyMiddle,11.5);
const live=bars.map((bar,i)=>i===4?{time:bar.time,open:14,high:20,low:14,close:19}:bar);
assert.notEqual(chartSupertrend(live,300,2,1)[4].pineDirection,calculated[4].pineDirection);
assert.deepEqual(chartSupertrend(live,300,2,1).slice(0,4),calculated.slice(0,4));
assert.deepEqual(supertrendSegments(calculated).map(segment=>segment.map(p=>p.time)),[[300],[600,900],[1200]]);

// Render checks: linebr never joins distinct runs; fill uses body midpoint,
// Pine v6 colors and 90% transparency. No browser/chart dependency required.
const overlaySource=fs.readFileSync(path.join(__dirname,'../src/shared/charts/SupertrendOverlay.ts'),'utf8');
const overlayCode=ts.transpileModule(overlaySource,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const overlayModule={exports:{}};
new Function('module','exports','require',overlayCode)(overlayModule,overlayModule.exports,()=>result.exports);
const overlay=new overlayModule.exports.SupertrendOverlay();
const strokes=[],fills=[];let points=[];
const ctx={save(){},restore(){},beginPath(){points=[];},moveTo(x,y){points.push([x,y]);},lineTo(x,y){points.push([x,y]);},closePath(){},fill(){fills.push({points:[...points],alpha:this.globalAlpha,color:this.fillStyle});},stroke(){strokes.push({points:[...points],alpha:this.globalAlpha,color:this.strokeStyle});}};
overlay.attached({requestUpdate(){},chart:{timeScale:()=>({timeToCoordinate:t=>t/30,coordinateToLogical:x=>x/10})},series:{priceToCoordinate:value=>value}});
overlay.setData(calculated);overlay.setVisible(true);
const render=()=>overlay.paneViews()[0].renderer().draw({useMediaCoordinateSpace:callback=>callback({context:ctx,mediaSize:{width:1000,height:1000}})});
render();
assert.deepEqual(strokes,[{points:[[20,9],[30,10.5]],alpha:1,color:'#4caf50'}]);
assert.deepEqual(fills,[{points:[[20,11.5],[30,13.5],[30,10.5],[20,9]],alpha:.1,color:'#4caf50'}]);
overlay.setData(chartSupertrend([...bars,{time:1500,open:9,high:10,low:8,close:9}],300,2,1));
render();assert.equal(strokes.at(-1).color,'#f23645');assert.equal(fills.at(-1).alpha,.1);
const previousStrokes=strokes.length;
overlay.setVisible(false);render();assert.equal(strokes.length,previousStrokes);
assert.equal(overlay.autoscaleInfo(0,4),null);
console.log('Pine Supertrend calculation, live-bar, line-break and fill checks passed.');

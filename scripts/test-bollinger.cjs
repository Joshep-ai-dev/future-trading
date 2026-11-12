const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('typescript');
function load(file){
  const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../',file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const module={exports:{}};new Function('module','exports',code)(module,module.exports);return module.exports;
}
const {chartBollingerBands,defaultBollinger,BB_MA_TYPES,BB_SOURCES}=load('src/shared/charts/bollingerBands.ts');
const near=(a,b,tolerance=1e-10)=>assert.ok(Math.abs(a-b)<tolerance,`${a} != ${b}`);
const candles=[1,2,3,4,5].map((close,i)=>({time:i*300,open:close-.2,high:close+1,low:close-1,close,volume:i+1}));
const config={...defaultBollinger,length:3};
const sma=chartBollingerBands(candles,config);
assert.equal(sma[0].basis,null);assert.equal(sma[1].upper,null);
near(sma[2].basis,2);near(sma[2].upper,2+2*Math.sqrt(2/3));near(sma[2].lower,2-2*Math.sqrt(2/3));
near(sma[4].basis,4);
const expected={SMA:[2,3,4],EMA:[2.25,3.125,4.0625],'SMMA (RMA)':[2,8/3,31/9],WMA:[14/6,20/6,26/6],VWMA:[14/6,29/9,50/12]};
for(const maType of BB_MA_TYPES){
  const rows=chartBollingerBands(candles,{...config,maType});
  for(let i=2;i<5;i++){
    near(rows[i].basis,expected[maType][i-2]);
    // Deviation is around the source SMA, not around the selected basis MA.
    near(rows[i].upper-rows[i].basis,2*Math.sqrt(2/3));
  }
}
assert.equal(chartBollingerBands(candles,{...config,maType:'EMA'})[0].basis,1);
for(const source of BB_SOURCES){
  const c=candles[0];
  const expectedValue=source==='hl2'?(c.high+c.low)/2:source==='hlc3'?(c.high+c.low+c.close)/3:source==='ohlc4'?(c.open+c.high+c.low+c.close)/4:source==='hlcc4'?(c.high+c.low+2*c.close)/4:c[source];
  const point=chartBollingerBands(candles,{...config,length:1,source})[0];
  near(point.basis,expectedValue);near(point.upper,expectedValue);near(point.lower,expectedValue);
}
const noVolume=candles.map(({volume,...c})=>c);
assert.equal(chartBollingerBands(noVolume,{...config,maType:'VWMA'}).every(row=>row.basis===null),true);
assert.equal(chartBollingerBands(candles.map(c=>({...c,volume:0})),{...config,maType:'VWMA'}).every(row=>row.basis===null),true);
// ta.vwma's SMA components ignore unavailable volume samples.
const sparseVolume=candles.map((c,i)=>i===3?{...c,volume:undefined}:c);
near(chartBollingerBands(sparseVolume,{...config,maType:'VWMA'})[3].basis,14/6);
const zeroTail=candles.map((c,i)=>({...c,volume:i<2?1.1:0}));
assert.equal(chartBollingerBands(zeroTail,{...config,maType:'VWMA'})[4].basis,null);
assert.deepEqual(chartBollingerBands(candles,{...config,offset:100}),sma);
assert.deepEqual(chartBollingerBands(candles,{...config,offset:-100}),sma);
const futureChanged=candles.map((c,i)=>i<3?c:{...c,close:c.close*2});
assert.deepEqual(chartBollingerBands(futureChanged,config).slice(0,3),sma.slice(0,3));
const withGap=candles.map((c,i)=>i<3?c:{...c,time:c.time+86400});
assert.deepEqual(chartBollingerBands(withGap,config).map(({time,...values})=>values),sma.map(({time,...values})=>values));
for(const extra of [{length:0},{length:1.5},{multiplier:0},{multiplier:51},{offset:501},{offset:.5},{maType:'unknown'},{source:'unknown'}]){
  assert.throws(()=>chartBollingerBands(candles,{...config,...extra}));
}
// Long rolling history checked against an independent two-pass population stdev.
const history=Array.from({length:1500},(_,i)=>({time:i*300,open:50,high:52,low:48,close:50+Math.sin(i*.13),volume:1}));
const rows=chartBollingerBands(history,defaultBollinger);
for(let i=19;i<history.length;i++){
  const values=history.slice(i-19,i+1).map(c=>c.close),mean=values.reduce((a,b)=>a+b,0)/20;
  const deviation=Math.sqrt(values.reduce((sum,value)=>sum+(value-mean)**2,0)/20);
  near(rows[i].basis,mean,1e-8);near(rows[i].upper,mean+2*deviation,1e-8);
}

// Rendering checks use bar-index offset even when candle timestamps have gaps.
const {BollingerOverlay}=load('src/shared/charts/BollingerOverlay.ts');
const overlay=new BollingerOverlay();
const strokes=[],fills=[];let points=[];
const ctx={save(){},restore(){},beginPath(){points=[];},moveTo(x,y){points.push([x,y]);},lineTo(x,y){points.push([x,y]);},closePath(){},fill(){fills.push({points:[...points],color:this.fillStyle});},stroke(){strokes.push({points:[...points],color:this.strokeStyle});}};
const times=new Map([[0,0],[86400,10]]);
overlay.attached({requestUpdate(){},chart:{timeScale:()=>({timeToCoordinate:t=>times.get(t)??null,coordinateToLogical:x=>x/10,logicalToCoordinate:i=>i*10})},series:{priceToCoordinate:v=>v}});
overlay.setData([{time:0,basis:10,upper:12,lower:8},{time:86400,basis:11,upper:13,lower:9}],2);
overlay.setVisible(true);
const render=()=>overlay.paneViews()[0].renderer().draw({useMediaCoordinateSpace:callback=>callback({context:ctx,mediaSize:{width:1000,height:1000}})});
render();
assert.deepEqual(strokes,[{points:[[20,10],[30,11]],color:'#2962ff'},{points:[[20,12],[30,13]],color:'#f23645'},{points:[[20,8],[30,9]],color:'#089981'}]);
assert.deepEqual(fills,[{points:[[20,12],[30,13],[30,9],[20,8]],color:'rgba(33,150,243,0.015)'}]);
overlay.setData([{time:0,basis:10,upper:12,lower:8},{time:86400,basis:11,upper:13,lower:9}],-1);
render();assert.deepEqual(strokes.at(-3).points,[[-10,10],[0,11]]);
overlay.setVisible(false);const count=strokes.length;render();assert.equal(strokes.length,count);
assert.equal(overlay.autoscaleInfo(0,3),null);
console.log('Bollinger MA, population deviation, source, offset and rendering checks passed.');

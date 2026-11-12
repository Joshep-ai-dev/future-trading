const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('typescript');

function load(file,requireStub=()=>({}),extra={}){
  const source=fs.readFileSync(path.join(__dirname,'../',file),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const module={exports:{}};
  new Function('module','exports','require',...Object.keys(extra),code)(module,module.exports,requireStub,...Object.values(extra));
  return module.exports;
}
const {mergeHistory,canAppendCandles}=load('src/shared/charts/candleHistory.ts');
const previous=[0,300,600].map(time=>({time,open:10,high:12,low:9,close:11,volume:5}));
assert.equal(canAppendCandles(previous,previous.map(row=>({...row}))),true);
assert.equal(canAppendCandles(previous,[...previous,{...previous[2],time:900}]),true);
assert.equal(canAppendCandles(previous,[...previous.slice(0,-1),{...previous[2],close:12}]),true);
for(const key of ['open','high','low','close','volume']){
  const corrected=previous.map((row,i)=>i===0?{...row,[key]:row[key]+.1}:row);
  assert.equal(canAppendCandles(previous,corrected),false,`Correction to old ${key} must redraw history`);
}
const corrected=mergeHistory(previous,[{...previous[0],close:10.5}]);
assert.equal(corrected[0].close,10.5);
assert.equal(canAppendCandles(previous,corrected),false);
assert.equal(canAppendCandles(previous,previous.slice(1)),false);
assert.equal(canAppendCandles(previous,[{...previous[0],time:-300},...previous]),false);
assert.equal(canAppendCandles([],previous),false);

// Sync revisions publish to every mounted chart subscriber, including when
// the minute cutoff is unchanged; hook dependencies can reload immediately.
const listeners=new Set();
const browser={addEventListener:(_,fn)=>listeners.add(fn),removeEventListener:(_,fn)=>listeners.delete(fn),dispatchEvent:()=>listeners.forEach(fn=>fn())};
let read,unsubscribe;
const events=[];
const revision=load('src/shared/charts/marketDataRevision.ts',()=>({
  useSyncExternalStore:(subscribe,snapshot)=>{read=snapshot;unsubscribe=subscribe(()=>events.push(snapshot()));return snapshot();},
}),{window:browser,Event});
assert.equal(revision.useMarketDataRevision(),0);
revision.notifyMarketDataUpdated();revision.notifyMarketDataUpdated();
assert.equal(read(),2);
assert.deepEqual(events,[1,2]);
unsubscribe();revision.notifyMarketDataUpdated();assert.deepEqual(events,[1,2]);
console.log('Chart sync notifications and historical candle correction checks passed.');

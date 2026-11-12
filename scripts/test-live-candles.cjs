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
const history=load('src/shared/charts/candleHistory.ts');
const {aggregateMinutes}=load('src/shared/charts/aggregateTimeframe.ts');
const rows=[0,60,120,180,240].map(time=>({time,open:10,high:12,low:9,close:11,volume:3}));
const corrected=history.mergeHistory(rows,[{...rows[4],close:12,volume:7}]);
const bars=aggregateMinutes(corrected,300,300);
assert.equal(bars.length,1);
assert.equal(bars[0].close,12);
assert.equal(bars[0].volume,19);
assert.equal(aggregateMinutes(corrected,300,299).length,0,'Forming candles must remain separate');
assert.equal(aggregateMinutes(corrected.slice(1),300,300).length,0,'Missing minutes must not be invented');

(async()=>{
  let state,cleanup,timer,delay,aborted=false,fail=false;
  const effects=[];
  const react={useState:initial=>{state=initial;return [state,next=>{state=typeof next==='function'?next(state):next;}];},useEffect:fn=>effects.push(fn)};
  const hook=load('src/shared/charts/useLiveMarketMinutes.ts',name=>name==='react'?react:name.includes('candleHistory')?history:{api:async()=>{
    if(fail)throw new Error('offline');
    return {candles:[{...rows[4],close:12,volume:7}],checkedAt:280,stale:false};
  }},{AbortController:class{signal={};abort(){aborted=true;}},setTimeout:(fn,ms)=>{timer=fn;delay=ms;return 1;},clearTimeout:()=>{timer=null;}});
  hook.useLiveMarketMinutes(true);
  cleanup=effects[0]();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(state.minutes.length,1);
  assert.equal(state.stale,false);
  assert.equal(delay,2000);
  await timer();
  assert.equal(state.minutes.length,1,'Same-minute updates must replace, not duplicate');
  fail=true;await timer();
  assert.equal(state.stale,true);
  assert.match(state.error,/offline/);
  assert.equal(state.minutes[0].close,12,'Outages preserve the last real candle');
  cleanup();assert.equal(aborted,true);assert.equal(timer,null);
  console.log('Live polling, outage status, candle replacement and OHLCV aggregation checks passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});

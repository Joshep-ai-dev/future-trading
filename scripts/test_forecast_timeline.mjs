import assert from 'node:assert/strict';
import test from 'node:test';
import {retainNextForecast,retainObservedCloses,compareForecasts} from '../src/features/research/forecastTimeline.ts';

const prediction={originTime:100,originClose:50,issuedAt:101,path:[{time:400,close:51}]};
test('retains the first forecast instead of rewriting it on refresh',()=>{
  const first=retainNextForecast([],prediction);
  assert.equal(first.length,1);
  assert.equal(retainNextForecast(first,{...prediction,path:[{time:400,close:99}]}),first);
});
test('rejects forecasts made at or after the target',()=>{
  assert.equal(retainNextForecast([],{...prediction,issuedAt:400}).length,0);
});
test('does not substitute a nearby live tick for a candle close',()=>{
  assert.equal(compareForecasts(retainNextForecast([],prediction),[{time:399,close:50}])[0].actual,null);
});
test('retains observed closes beyond the visible market history',()=>{
  const saved=retainObservedCloses(retainNextForecast([],prediction),[{time:400,close:50.5}]);
  assert.equal(compareForecasts(saved,[])[0].error,.5);
  assert.equal(retainObservedCloses(saved,[{time:400,close:90}])[0].actualClose,50.5);
});
test('orders forecasts chronologically',()=>{
  const later=retainNextForecast([],{...prediction,path:[{time:700,close:52}]});
  assert.deepEqual(retainNextForecast(later,prediction).map(p=>p.time),[400,700]);
});

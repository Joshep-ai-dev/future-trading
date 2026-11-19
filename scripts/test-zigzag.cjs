// Run with node scripts/test-zigzag.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../src/shared/charts/zigZag.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText;
const result = {exports: {}};
new Function('module', 'exports', compiled)(result, result.exports);
const {chartZigZag} = result.exports;
const bars = values => values.map((value, i) => ({time:i*60, high:value, low:value, close:value}));
assert.deepEqual(chartZigZag([], 5), []);
assert.deepEqual(chartZigZag(bars([100,101,99,102]), 5), []);
assert.deepEqual(chartZigZag(bars([100,106,112,105,100,106]), 5), [
  {time:0,value:100}, {time:120,value:112}, {time:240,value:100}, {time:300,value:106},
]);
assert.deepEqual(chartZigZag(bars([100,94,88,95,100,94]), 5), [
  {time:0,value:100}, {time:120,value:88}, {time:240,value:100}, {time:300,value:94},
]);
// Same-direction extensions move the provisional endpoint, not confirmed pivots.
const before = chartZigZag(bars([100,106,112,105,100,106]), 5);
const after = chartZigZag(bars([100,106,112,105,100,106,110]), 5);
assert.deepEqual(after.slice(0,-1), before.slice(0,-1));
assert.deepEqual(after.at(-1), {time:360,value:110});
// Wicks establish extremes; a later close must confirm the reversal.
assert.deepEqual(chartZigZag([
  {time:0,high:101,low:99,close:100},
  {time:60,high:110,low:100,close:106},
  {time:120,high:109,low:102,close:108},
  {time:180,high:108,low:103,close:104},
], 5), [{time:0,value:99},{time:60,value:110},{time:180,value:103}]);
for (const value of [0,-1,101,NaN,Infinity]) assert.throws(() => chartZigZag([],value), RangeError);
console.log('Zig Zag swing, reversal, wick, provisional-leg and input checks passed.');

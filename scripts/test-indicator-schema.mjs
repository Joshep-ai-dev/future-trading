// Run with node scripts/test-indicator-schema.mjs. Bundles the TS schema with esbuild (from Vite) and checks it.
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const source=String.raw`
import assert from 'node:assert/strict';
import {defaultIndicators} from './src/shared/charts/indicatorConfig';
import {normalizeIndicatorConfig,validateSettings,isValidConfig,schemaKeys,INDICATOR_SCHEMAS} from './src/shared/charts/indicatorSchema';
const d={...defaultIndicators};
assert.ok(isValidConfig(d));
// every config key is edited by exactly one dialog except shared ones
const all=Object.keys(INDICATOR_SCHEMAS).flatMap(k=>schemaKeys(k as any));
assert.deepEqual(new Set(all),new Set(Object.keys(d)),'schema covers every config key');
assert.equal(all.length,new Set(all).size,'no key owned twice');
assert.deepEqual(validateSettings('rsi',{...d,rsiLower:80}).map(i=>i.message),['Lower band must be below the upper band.']);
assert.match(validateSettings('rsi',{...d,rsiLength:1.5})[0].message,/whole number/);
assert.match(validateSettings('atr',{...d,atrLength:NaN})[0].message,/required/);
assert.match(validateSettings('bollinger',{...d,bbMultiplier:60})[0].message,/between 0.001 and 50/);
assert.ok(validateSettings('bollinger',{...d,bbLength:5000}).length===0,'bb length has no max');
assert.match(validateSettings('atr',{...d,atrSmoothing:'X' as any})[0].message,/Choose/);
assert.equal(normalizeIndicatorConfig({rsiColor:'red',rsiWidth:9,atrColor:'#123456'}).rsiColor,d.rsiColor);
assert.equal(normalizeIndicatorConfig({rsiWidth:9}).rsiWidth,d.rsiWidth);
assert.equal(normalizeIndicatorConfig({atrColor:'#123456',rsiLength:3}).atrColor,'#123456');
assert.deepEqual(normalizeIndicatorConfig({rsiLength:3,rsiUpper:10,rsiLower:20}),d,'bad inputs reset all');
assert.deepEqual(normalizeIndicatorConfig(null),d);
console.log('schema checks passed');
`;
const result=await build({stdin:{contents:source,loader:'ts',resolveDir:fileURLToPath(new URL('..',import.meta.url))},bundle:true,platform:'node',format:'esm',write:false,logLevel:'warning'});
await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

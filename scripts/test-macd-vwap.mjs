// Run with node scripts/test-macd-vwap.mjs. Bundles the TS indicators with esbuild (from Vite) and checks hand-worked values.
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const source=String.raw`
import assert from 'node:assert/strict';
import {chartMacd,macdHistogramColor} from './src/shared/charts/macd';
import {anchorStart,chartVwap} from './src/shared/charts/vwap';

const near=(actual,expected,label)=>assert.ok(actual!==null&&Math.abs(actual-expected)<1e-4,label+': '+actual+' != '+expected);
const bars=(closes)=>closes.map((close,i)=>({time:i*60,open:close,high:close,low:close,close}));

// EMA MACD 2/3/2 on closes 1 2 4 7 11, worked by hand (ta.ema seeds with the SMA of the first values).
const ema=chartMacd(bars([1,2,4,7,11]),{fast:2,slow:3,signal:2,source:'close',oscillatorMa:'EMA',signalMa:'EMA'});
assert.deepEqual(ema.slice(0,2).map(p=>p.macd),[null,null]);
near(ema[2].macd,0.83333,'macd[2]');near(ema[3].macd,1.05556,'macd[3]');near(ema[4].macd,1.40741,'macd[4]');
assert.equal(ema[2].signal,null);
near(ema[3].signal,0.94444,'signal[3]');near(ema[4].signal,1.25309,'signal[4]');
near(ema[3].histogram,0.11111,'hist[3]');near(ema[4].histogram,0.15432,'hist[4]');

// SMA oscillator: fast SMA2 - slow SMA3.
const sma=chartMacd(bars([1,2,4,7,11]),{fast:2,slow:3,signal:2,source:'close',oscillatorMa:'SMA',signalMa:'SMA'});
near(sma[2].macd,3-2.33333,'sma macd[2]');near(sma[4].macd,9-7.33333,'sma macd[4]');
near(sma[4].signal,(1.16667+1.66667)/2,'sma signal[4]');

// Histogram colors follow TradingView: grow/fall above or below zero.
const colors={growAbove:'GA',fallAbove:'FA',growBelow:'GB',fallBelow:'FB'};
assert.deepEqual([macdHistogramColor(2,1,colors),macdHistogramColor(1,2,colors),macdHistogramColor(-1,-2,colors),macdHistogramColor(-2,-1,colors)],['GA','FA','GB','FB']);

// VWAP anchors: UTC day, Monday week, month.
const friday=Date.UTC(2026,10,27,15,30)/1000;
assert.equal(anchorStart(friday,'Session'),Date.UTC(2026,10,27)/1000);
assert.equal(anchorStart(friday,'Week'),Date.UTC(2026,10,23)/1000);
assert.equal(anchorStart(friday,'Month'),Date.UTC(2026,10,1)/1000);

// Two bars before midnight UTC, one after: the session resets. Prices 10 x1, 20 x3 -> 17.5, sigma sqrt(18.75).
const midnight=Date.UTC(2026,10,28)/1000;
const candle=(time,price,volume)=>({time,open:price,high:price,low:price,close:price,volume});
const vwap=chartVwap([candle(midnight-120,10,1),candle(midnight-60,20,3),candle(midnight,30,2),candle(midnight+60,40,0)],{anchor:'Session',source:'hlc3',bandMultiplier:2});
near(vwap[0].vwap,10,'vwap[0]');near(vwap[1].vwap,17.5,'vwap[1]');
near(vwap[1].upper,17.5+2*Math.sqrt(18.75),'upper[1]');near(vwap[1].lower,17.5-2*Math.sqrt(18.75),'lower[1]');
assert.deepEqual(vwap.map(p=>p.anchored),[true,false,true,false]);
near(vwap[2].vwap,30,'reset vwap');near(vwap[2].upper,30,'reset band');
near(vwap[3].vwap,30,'zero-volume bar keeps vwap');

// A period that has seen no volume yet has no VWAP.
const empty=chartVwap([candle(midnight,30,0),{time:midnight+60,open:31,high:31,low:31,close:31}],{anchor:'Session',source:'close',bandMultiplier:1});
assert.deepEqual(empty.map(p=>p.vwap),[null,null]);
console.log('MACD and VWAP checks passed');
`;
const result=await build({stdin:{contents:source,loader:'ts',resolveDir:fileURLToPath(new URL('..',import.meta.url))},bundle:true,platform:'node',format:'esm',write:false,logLevel:'warning'});
await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

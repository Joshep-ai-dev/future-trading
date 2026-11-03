import {useEffect,useState} from 'react';
import {api} from '../../shared/api/api';
import type {SavedForecastModel} from './ForecastPage';
import ForecastPriceChart,{type PricePoint} from './ForecastPriceChart';
import {fmt} from '../../shared/types/types';

type Prediction={path?:PricePoint[];modelId?:string;model:string;timeframe:string;horizon:number;issuedAt:number;originTime:number;targetTime:number;originClose:number;predictedClose:number;predictedHigh:number;predictedLow:number;note:string};
type Record={id:number;prediction:Prediction;actual:null|{close:number;high:number;low:number;closeAbsoluteError:number;baselineAbsoluteError:number;directionCorrect:boolean};status?:'pending'|'awaiting_data'|'verified'};
const stamp=(time:number)=>new Date(time*1000).toISOString().replace('T',' ').slice(0,19);

export default function ForwardForecastPanel({selectedModel}:{selectedModel:SavedForecastModel}){
  const [quote,setQuote]=useState<{price:number;time:number;source:string;stale:boolean}|null>(null),[quoteError,setQuoteError]=useState(''),[ticks,setTicks]=useState<PricePoint[]>([]);
  const [viewMode,setViewMode]=useState<'rolling'|'saved'>('rolling'),[autoUpdate,setAutoUpdate]=useState(true);
  const [live,setLive]=useState<{history:PricePoint[];actual:PricePoint[];prediction:Prediction;checkedAt:number}|null>(null),[liveBusy,setLiveBusy]=useState(false),[liveError,setLiveError]=useState('');
  const [selectedRun,setSelectedRun]=useState<number|null>(null),[chart,setChart]=useState<{history:PricePoint[];actual:PricePoint[];prediction:Prediction}|null>(null);
  const [records,setRecords]=useState<Record[]>([]),[busy,setBusy]=useState(false),[checking,setChecking]=useState(false),[error,setError]=useState('');
  useEffect(()=>{let active=true;const load=()=>{void api<Record[]>('/api/forecast/forward').then(rows=>{if(active)setRecords(rows);}).catch(error=>{if(active)setError(String(error));});};load();const timer=window.setInterval(load,30000);return()=>{active=false;window.clearInterval(timer);};},[]);
  async function check(){setChecking(true);try{setRecords(await api<Record[]>('/api/forecast/forward'));setError('');}catch(error){setError(String(error));}finally{setChecking(false);}}
  async function issue(){setBusy(true);setError('');try{const row=await api<Record>('/api/forecast/forward',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model_id:selectedModel.id})});setRecords(current=>[row,...current.filter(item=>item.id!==row.id)].slice(0,100));setSelectedRun(row.id);setChart(null);}catch(error){setError(String(error));}finally{setBusy(false);}}
  useEffect(()=>{
    if(viewMode!=='rolling')return;
    let current=true;let timer:number|undefined;const controller=new AbortController();
    async function update(){
      setLiveBusy(true);
      try{const value=await api<{history:PricePoint[];actual:PricePoint[];prediction:Prediction;checkedAt:number}>(`/api/forecast/models/${selectedModel.id}/live`,{signal:controller.signal});if(current){setLive(value);setLiveError('');}}
      catch(error){if(current)setLiveError(String(error));}
      finally{if(current){setLiveBusy(false);if(autoUpdate)timer=window.setTimeout(()=>void update(),15000);}}
    }
    void update();return()=>{current=false;controller.abort();if(timer)window.clearTimeout(timer);};
  },[selectedModel.id,viewMode,autoUpdate]);
  useEffect(()=>{
    if(viewMode!=='rolling')return;
    let current=true;let timer:number|undefined;const controller=new AbortController();
    async function updateQuote(){
      try{const value=await api<{price:number;time:number;source:string;stale:boolean}>('/api/forecast/quote',{signal:controller.signal});if(current){setQuote(value);setQuoteError('');if(!value.stale)setTicks(previous=>[...previous.filter(point=>point.time<value.time),{time:value.time,close:value.price}].slice(-240));}}
      catch(error){if(current)setQuoteError(String(error));}
      finally{if(current&&autoUpdate)timer=window.setTimeout(()=>void updateQuote(),5000);}
    }
    void updateQuote();return()=>{current=false;controller.abort();if(timer)window.clearTimeout(timer);};
  },[viewMode,autoUpdate]);
  const visible=records.filter(row=>row.prediction.modelId===selectedModel.id);
  const active=visible.find(row=>row.id===selectedRun)||visible[0];
  useEffect(()=>{if(!active){setChart(null);return;}let current=true;const load=()=>{void api<{history:PricePoint[];actual:PricePoint[];prediction:Prediction}>(`/api/forecast/forward/${active.id}/chart`).then(value=>{if(current)setChart(value);}).catch(error=>{if(current)setError(String(error));});};load();const timer=window.setInterval(load,30000);return()=>{current=false;window.clearInterval(timer);};},[active?.id]);
  const display=viewMode==='rolling'?live:chart;
  const prediction=display?.prediction;
  return <section className="forecast-live-panel" aria-label="Live forward prediction tests"><div className="forecast-result-heading"><div><h2>Live price forecast</h2><p className="setup-note">Uses {selectedModel.name} without retraining. Watch a rolling forecast as new candles arrive, or save a fixed prediction for later verification.</p></div><button type="button" disabled={busy} onClick={()=>void issue()}>{busy?'Refreshing and predicting...':'Predict ahead & save'}</button></div>
    <div className="forecast-result-heading"><div className="chip-group" role="group" aria-label="Prediction view"><button type="button" aria-pressed={viewMode==='rolling'} onClick={()=>setViewMode('rolling')}>Auto-updating forecast</button><button type="button" aria-pressed={viewMode==='saved'} onClick={()=>setViewMode('saved')}>Saved test snapshot</button></div>{viewMode==='rolling'&&<label className="forecast-auto-update"><input type="checkbox" checked={autoUpdate} onChange={event=>setAutoUpdate(event.target.checked)}/><span><strong>Auto update</strong><small>Market price: 5s | Forecast check: 15s</small></span></label>}</div>
    {viewMode==='rolling'&&<p className="setup-note" role="status">{liveBusy?'Refreshing market data and recalculating...':live?`Last checked ${stamp(live.checkedAt)} UTC. Input candle closed ${stamp(live.prediction.originTime)} UTC.`:'Loading forecast...'} The forecast updates when a new {selectedModel.config.timeframe} candle closes; it uses completed candles, not live ticks.</p>}
    {viewMode==='rolling'&&quoteError&&<p className="notice" role="status">Live market feed unavailable. {quote?`Last received price: ${fmt(quote.price,4)} at ${stamp(quote.time)} UTC.`:'No live price received yet.'}</p>}
    {viewMode==='rolling'&&quote&&<p className="setup-note">{quote.source} | Quote time {stamp(quote.time)} UTC{quote.stale||quoteError?' | STALE - not a current quote':''}. Live quotes are display-only; predictions use completed candles.</p>}
    {viewMode==='rolling'&&liveError&&<p className="error" role="alert">{liveError} {live?'The displayed forecast is from the last successful update.':''}</p>}
    {prediction&&!prediction.path?.length&&<p className="notice">This saved model predicts only the final price. Train a new model to enable a forecast curve with one predicted close per future candle.</p>}
    {display&&prediction&&<><div className="model-kpis">{[...(viewMode==='rolling'?[[quote?.stale||quoteError?'Last market price (stale)':'Live market price',quote?fmt(quote.price,4):'Loading...'],['Next predicted close',prediction.path?.length?`${fmt(prediction.path[0].close,4)} at ${stamp(prediction.path[0].time)} UTC`:'Retrain for multi-step prices']]:[]),['Last closed price',fmt(prediction.originClose,3)],['Forecast end price',fmt(prediction.predictedClose,3)],['Expected change',`${fmt((prediction.predictedClose/prediction.originClose-1)*100,2)}%`],['Actual end price',viewMode==='saved'&&active?.actual?fmt(active.actual.close,3):'Awaiting target'],['Target time (UTC)',stamp(prediction.targetTime)]].map(([label,value])=><div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div><ForecastPriceChart history={display.history} actual={viewMode==='rolling'?[...display.actual,...ticks.filter(point=>point.time>prediction.originTime&&point.time<=prediction.targetTime)]:display.actual} forecast={prediction}/></>}
    {busy&&<p role="status">Refreshing public silver history and using saved model weights. A prediction is saved only if its target close is still in the future.</p>}{error&&<p className="error" role="alert">{error}</p>}
    <div className="forecast-result-heading forecast-saved-heading"><h3>Saved forward tests</h3><button type="button" className="secondary" disabled={checking} onClick={()=>void check()}>{checking?'Checking...':'Check outcomes'}</button></div><p className="setup-note">Checks every 30 seconds while this tab is open. After a target closes, missing market data triggers a refresh; verification waits for every candle in the horizon. Previously saved predictions are never retrained.</p>
    {!visible.length?<p>No saved predictions yet.</p>:<div className="table-scroll"><table><thead><tr>{['Test / model','Saved (UTC)','Start candle close (UTC)','Target close (UTC)','Start price','Predicted end price','Actual end price','Predicted high / low','Actual high / low','Error / baseline','Status'].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{visible.map(row=><tr key={row.id} onClick={()=>{setSelectedRun(row.id);setViewMode('saved');}} title={row.prediction.note}><td><button type="button" className="trade-link" onClick={()=>{setSelectedRun(row.id);setViewMode('saved');}}>#{row.id}</button> {row.prediction.model.toUpperCase()} | {row.prediction.timeframe}</td><td>{stamp(row.prediction.issuedAt)}</td><td>{stamp(row.prediction.originTime)}</td><td>{stamp(row.prediction.targetTime)}</td><td>{fmt(row.prediction.originClose,3)}</td><td>{fmt(row.prediction.predictedClose,3)}</td><td>{row.actual?fmt(row.actual.close,3):'Pending'}</td><td>{fmt(row.prediction.predictedHigh,3)} / {fmt(row.prediction.predictedLow,3)}</td><td>{row.actual?`${fmt(row.actual.high,3)} / ${fmt(row.actual.low,3)}`:'Pending'}</td><td>{row.actual?`${fmt(row.actual.closeAbsoluteError,4)} / ${fmt(row.actual.baselineAbsoluteError,4)}`:'-'}</td><td>{row.actual?`Verified | direction ${row.actual.directionCorrect?'correct':'incorrect'}`:row.status==='awaiting_data'?'Awaiting complete candles':'Waiting for target close'}</td></tr>)}</tbody></table></div>}
  </section>;
}

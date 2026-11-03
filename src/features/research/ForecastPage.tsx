import {useState,type FormEvent} from 'react';
import {api} from '../../shared/api/api';
import {PageHeader} from '../../shared/ui/ui';
import {Field,TIMEFRAME_CHOICES} from '../strategy/BBReversalSettings';
import {fmt} from '../../shared/types/types';
import '../../styles/forecast.css';

type Point={originTime:number;targetTime:number;originClose:number;predictedClose:number;predictedHigh:number;predictedLow:number;actualClose:number;actualHigh:number;actualLow:number};
type Result={model:string;timeframe:string;horizon:number;trainStart:string;trainEnd:string;trainingRows:number;epochsTrained:number|null;note:string;metrics:{samples:number;closeMae:number;closeRmse:number;baselineMae:number;directionAccuracy:number;highMae:number;lowMae:number};predictions:Point[]};
const dateTime=(time:number)=>new Date(time*1000).toISOString().replace('T',' ').slice(0,16);

function PredictionChart({points}:{points:Point[]}){
  const values=points.flatMap(point=>[point.predictedClose,point.actualClose]);
  const low=Math.min(...values),high=Math.max(...values),span=Math.max(high-low,.001);
  const line=(key:'predictedClose'|'actualClose')=>points.map((point,index)=>`${50+index/Math.max(1,points.length-1)*900},${230-(point[key]-low)/span*200}`).join(' ');
  return <figure className="forecast-chart"><figcaption>Close at forecast horizon <span className="forecast-predicted">Predicted</span> <span className="forecast-actual">Actual</span></figcaption><svg viewBox="0 0 980 280" role="img" aria-label="Predicted and actual silver close prices at the forecast horizon"><text x="0" y="30">{fmt(high,3)}</text><text x="0" y="235">{fmt(low,3)}</text><polyline points={line('actualClose')} fill="none" stroke="#54d6aa" strokeWidth="2"/><polyline points={line('predictedClose')} fill="none" stroke="#87aaff" strokeWidth="2"/><text x="50" y="270">{dateTime(points[0].targetTime)}</text><text x="950" y="270" textAnchor="end">{dateTime(points[points.length-1].targetTime)} UTC</text></svg></figure>;
}

export default function ForecastPage({range}:{range:{startDate:string;endDate:string}}){
  const [config,setConfig]=useState({model:'gru',timeframe:'15m',start_date:new Date(Math.max(Date.parse(range.startDate),Date.parse(range.endDate)-2*86400000)).toISOString().slice(0,10),end_date:range.endDate,train_bars:6000,lookback:100,horizon:12,epochs:30});
  const [result,setResult]=useState<Result|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[stale,setStale]=useState(false);
  const update=(patch:Partial<typeof config>)=>{setConfig({...config,...patch});if(result)setStale(true);};
  async function run(event:FormEvent){event.preventDefault();setBusy(true);setError('');try{setResult(await api<Result>('/api/forecast/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(config)}));setStale(false);}catch(error){setError(String(error));}finally{setBusy(false);}}
  function download(){if(!result)return;const url=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download=`silver-forecast-${result.model}.json`;link.click();URL.revokeObjectURL(url);}
  const numeric=(key:'train_bars'|'lookback'|'horizon'|'epochs',label:string,min:number,max:number)=><Field key={key} label={label}><input type="number" required min={min} max={max} step={1} value={config[key]} onChange={event=>update({[key]:Number(event.target.value)})}/></Field>;
  return <section id="page-forecast" role="tabpanel" aria-labelledby="tab-forecast" className="forecast-page">
    <PageHeader eyebrow="SILVER RESEARCH" title="Forecast" description="Train a prediction model on earlier silver candles, then compare its forecasts with actual prices in a historical test period."/>
    <form className="forecast-controls" onSubmit={event=>void run(event)}><fieldset disabled={busy}><legend>Prediction experiment · XAG / USDT · OKX history</legend><div className="setup-grid">
      <Field label="Model"><select value={config.model} onChange={event=>update({model:event.target.value})}>{[['rnn','RNN'],['lstm','LSTM'],['gru','GRU'],['extra_trees','Extra Trees baseline']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></Field>
      <Field label="Timeframe"><select value={config.timeframe} onChange={event=>update({timeframe:event.target.value})}>{TIMEFRAME_CHOICES.map(value=><option key={value}>{value}</option>)}</select></Field>
      <Field label="Test start (UTC)"><input type="date" required min={range.startDate} max={config.end_date} value={config.start_date} onChange={event=>update({start_date:event.target.value})}/></Field>
      <Field label="Test end (UTC)"><input type="date" required min={config.start_date} max={range.endDate} value={config.end_date} onChange={event=>update({end_date:event.target.value})}/></Field>
      {numeric('train_bars','Earlier training candles',500,50000)}{numeric('horizon','Forecast horizon (candles)',1,100)}
      {config.model!=='extra_trees'&&<>{numeric('lookback','Observed candles',1,500)}{numeric('epochs','Maximum epochs',1,100)}</>}
    </div><p className="setup-note">The model is frozen throughout the test. Each prediction uses only candles closed at its origin time. High and low refer to the following horizon; close refers to its final candle. Maximum 3,000 test candles per run.</p><button type="submit">{busy?'Training and predicting…':'Run prediction test'}</button></fieldset></form>
    {busy&&<p role="status">Training on earlier history and predicting the selected test period. Neural models may take several minutes.</p>}
    {error&&<p className="error" role="alert">{error}</p>}
    {result&&<section aria-label="Forecast test results">{stale&&<p className="notice">Settings changed. Run again to update these results.</p>}<div className="forecast-result-heading"><h2>{result.model.toUpperCase()} · {result.timeframe} · {result.horizon}-candle forecast</h2><button type="button" className="secondary" onClick={download}>Export predictions</button></div><p className="setup-note">Training: {result.trainStart} ? {result.trainEnd} · {result.trainingRows.toLocaleString()} rows{result.epochsTrained!=null?` · ${result.epochsTrained} epochs`:''}</p>
      <div className="model-kpis">{[['Test predictions',result.metrics.samples.toLocaleString()],['Close MAE (USDT)',fmt(result.metrics.closeMae,4)],['Unchanged-price MAE',fmt(result.metrics.baselineMae,4)],['Close RMSE (USDT)',fmt(result.metrics.closeRmse,4)],['Direction accuracy',`${fmt(result.metrics.directionAccuracy)}%`],['High / low MAE',`${fmt(result.metrics.highMae,4)} / ${fmt(result.metrics.lowMae,4)}`]].map(([label,value])=><div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
      <p className="setup-note">Lower error is better. The unchanged-price baseline predicts that the future close equals the current close. {result.note}</p>
      <PredictionChart points={result.predictions}/><h3>Latest 100 predictions</h3><div className="table-scroll"><table><thead><tr>{['Forecast made (UTC)','Target close (UTC)','Origin close','Predicted close','Actual close','Predicted high / low','Actual high / low'].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{result.predictions.slice(-100).reverse().map(point=><tr key={point.originTime}><td>{dateTime(point.originTime)}</td><td>{dateTime(point.targetTime)}</td><td>{fmt(point.originClose,3)}</td><td>{fmt(point.predictedClose,3)}</td><td>{fmt(point.actualClose,3)}</td><td>{fmt(point.predictedHigh,3)} / {fmt(point.predictedLow,3)}</td><td>{fmt(point.actualHigh,3)} / {fmt(point.actualLow,3)}</td></tr>)}</tbody></table></div>
    </section>}
  </section>;
}

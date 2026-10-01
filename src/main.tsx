import {useEffect,useState,type FormEvent} from 'react';
import {createRoot} from 'react-dom/client';
import {api} from './api';
import Chart from './Chart';
import BacktestPanel from './BacktestPanel';
import {type Analysis,type Parameters} from './types';
import './style.css';

const defaults: Parameters = {timeframe:'1m'};
function App() {
  const [settings,setSettings] = useState(defaults);
  const [data,setData] = useState<Analysis|null>(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  async function run(event?: FormEvent) {
    event?.preventDefault();setBusy(true);setError('');
    try {setData(await api<Analysis>('/api/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(settings)}));}
    catch(e) {setError(String(e));} finally {setBusy(false);}
  }
  useEffect(()=>{void run();},[]);
  const dirty = data && JSON.stringify(settings)!==JSON.stringify(data.params);
  // Compare values rather than object insertion order from the API.
  const changed = dirty && Object.keys(settings).some(k=>settings[k as keyof Parameters]!==data.params[k as keyof Parameters]);
  return <main><header><div><small>OKX · XAG-USDT-SWAP · LOCAL CSV</small><h1>Silver / Price research</h1><p>Historical price charts from local CSV data.</p></div><span className="badge">Historical research</span></header>
    <form onSubmit={run}><fieldset disabled={busy}><div className="settings-grid">
      <label>Bar size<select value={settings.timeframe} onChange={e=>setSettings({...settings,timeframe:e.target.value as Parameters['timeframe']})}>{['1m','5m','10m','15m','1h','4h','1d'].map(t=><option key={t}>{t}</option>)}</select></label>
    </div><div className="form-actions"><button type="submit">{busy?'Loading…':'Load prices'}</button></div></fieldset></form>
    {error && <p role="alert" className="error">{error}</p>}{changed && <p className="notice">Bar size changed. Load prices to update the chart.</p>}
    {busy && <p role="status">Reading CSV…</p>}
    {data && <><p className="caption">Results: {data.params.timeframe} bars · latest bar {new Date(data.asOf*1000).toISOString()}.</p>
      <section><h2>Price · {data.params.timeframe}</h2><p>Showing the latest {data.candles.length.toLocaleString()} of {data.quality.completeBars.toLocaleString()} complete bars. Times are UTC.</p><Chart data={data}/></section>
      <BacktestPanel range={data.dataRange}/><footer>{data.quality.minuteBars.toLocaleString()} source minutes · {data.quality.missingMinutes.toLocaleString()} missing minutes · {data.quality.excludedBars} incomplete {data.params.timeframe} bars excluded.<p>Source: data/OKX_XAG-USDT-SWAP_1m.csv. CSV is read-only.</p></footer></>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);

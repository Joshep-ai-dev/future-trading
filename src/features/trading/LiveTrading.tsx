import {useEffect,useState,type ReactNode} from 'react';
import {api} from '../../shared/api/api';
import ExchangeMarketHeader from './ExchangeMarketHeader';
import ExchangeOverview from './ExchangeOverview';
import LiveMarketChart from './LiveMarketChart';
import {useExchangeVenue} from '../../shared/api/exchangeVenue';
import {Button,Panel} from '../../shared/ui/ui';
import LiveAssets from './LiveAssets';
import TerminalSplitter from '../../shared/ui/TerminalSplitter';
import type {BacktestSettings} from '../../shared/types/types';

function PaperSessionNotice(){
  const [running,setRunning]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  useEffect(()=>{
    let active=true;
    const abort=new AbortController();
    async function check(){
      try{
        const value=await api<{session:{running:boolean}|null}>('/api/paper',{signal:abort.signal});
        if(active)setRunning(!!value.session?.running);
      }catch{/* The notice retries on the next check. */}
    }
    void check();const timer=setInterval(()=>void check(),5000);
    return()=>{active=false;abort.abort();clearInterval(timer);};
  },[]);
  async function pause(){
    setBusy(true);setError('');
    try{await api('/api/paper/pause',{method:'POST'});setRunning(false);}
    catch(reason){setError(String(reason));}finally{setBusy(false);}
  }
  if(!running)return null;
  return <div className="paper-running-notice" role="status"><div><strong>Paper bot still running</strong><span>Switching accounts leaves the simulation active.</span>{error&&<p className="error">{error}</p>}</div><Button variant="secondary" disabled={busy} onClick={()=>void pause()}>{busy?'Pausing...':'Pause paper bot'}</Button></div>;
}

export default function LiveTrading({settings,controls}:{settings:BacktestSettings;controls:ReactNode}){
  const venue=useExchangeVenue();
  return <div id="page-paper" role="tabpanel" aria-labelledby="tab-paper">
    <ExchangeMarketHeader venue={venue}/>
    <div className="terminal-grid live-terminal-grid">
      <div className="terminal-main"><LiveMarketChart key={venue} venue={venue} settings={settings}/><TerminalSplitter/><ExchangeOverview venue={venue}/></div>
      <aside className="terminal-sidebar" aria-label="Live execution"><PaperSessionNotice/><Panel className="live-terminal-controls">{controls}</Panel><LiveAssets venue={venue}/></aside>
    </div>
  </div>;
}

import {useEffect,useState,type ReactNode} from 'react';
import {api} from '../../shared/api/api';
import ExchangeMarketHeader from './ExchangeMarketHeader';
import ExchangeOverview from './ExchangeOverview';
import LiveMarketChart from './LiveMarketChart';
import {useExchangeVenue} from '../../shared/api/exchangeVenue';
import {Button,Panel} from '../../shared/ui/ui';
import LiveAssets from './LiveAssets';
import TerminalSplitter from '../../shared/ui/TerminalSplitter';
import BotStatusPanel,{BotChartBadge} from './BotStatusPanel';
import type {BotStatus} from '../../shared/api/exchangeTypes';
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

function useLiveBot(){
  const [bot,setBot]=useState<BotStatus|null>(null);
  useEffect(()=>{
    let active=true;
    async function load(){try{const value=await api<{bot:BotStatus}>('/api/exchange/status');if(active)setBot(value.bot);}catch{/* Keep the last known bot state. */}}
    void load();const timer=setInterval(()=>void load(),3000);
    return()=>{active=false;clearInterval(timer);};
  },[]);
  return bot;
}

export default function LiveTrading({settings,controls}:{settings:BacktestSettings;controls:ReactNode}){
  const venue=useExchangeVenue();
  const bot=useLiveBot(),botHere=!!bot?.running&&bot.venue===venue;
  return <div id="page-paper" role="tabpanel" aria-labelledby="tab-paper">
    <ExchangeMarketHeader venue={venue}/>
    <div className="terminal-grid live-terminal-grid">
      <div className="terminal-main"><LiveMarketChart key={venue} venue={venue} settings={settings} overlay={<BotChartBadge state={botHere?bot?.strategyState:null} running={botHere}/>}/><TerminalSplitter/><ExchangeOverview venue={venue}/></div>
      <aside className="terminal-sidebar" aria-label="Live execution"><PaperSessionNotice/><Panel className="live-terminal-controls">{controls}</Panel><BotStatusPanel state={botHere?bot?.strategyState:null} running={botHere} timeLabel={botHere&&bot?.strategyState?.timestamp?new Date(bot.strategyState.timestamp*1000).toISOString().slice(0,16).replace('T',' ')+' UTC':undefined} emptyHint={bot?.running?`The strategy is running on ${bot.venue?.toUpperCase()}. Switch to that exchange to see its status.`:'Start the strategy in the Bots tab to see live buy and sell readiness.'}/><LiveAssets venue={venue}/></aside>
    </div>
  </div>;
}

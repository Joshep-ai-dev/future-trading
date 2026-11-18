import {ExecutionModeContext,type ExecutionMode} from './ExecutionModeContext';
import {useEffect,useState,type ReactNode} from 'react';
import {api} from '../../shared/api/api';
import ExchangeMarketHeader from './ExchangeMarketHeader';
import OrderBook from './OrderBook';
import ExchangeOverview from './ExchangeOverview';
import LiveMarketChart from './LiveMarketChart';
import {useExchangeVenue} from '../../shared/api/exchangeVenue';
import {Button,Panel} from '../../shared/ui/ui';
import LiveAssets from './LiveAssets';
import TerminalSplitter from '../../shared/ui/TerminalSplitter';
import BotStatusPanel,{BotChartBadge} from './BotStatusPanel';
import type {BotStatus} from '../../shared/api/exchangeTypes';
import type {BacktestSettings} from '../../shared/types/types';
import TradingWorkspaceTools from './TradingWorkspaceTools';

type LivePanels={book:boolean;order:boolean};
const panelsKey='silver.live.panels';
function readPanels():LivePanels{
  try{const saved=JSON.parse(localStorage.getItem(panelsKey)??'{}');return {book:saved.book!==false,order:saved.order!==false};}
  catch{return {book:true,order:true};}
}

/** Chart-toolbar toggles that show or hide the order book and the order panel. */
function PanelToggles({panels,onToggle}:{panels:LivePanels;onToggle:(key:keyof LivePanels)=>void}){
  return <div className="live-panel-toggles" role="group" aria-label="Show or hide panels">
    <button type="button" className="tv-icon live-panel-toggle" aria-pressed={panels.book} aria-controls="live-order-book" title={panels.book?'Hide order book':'Show order book'} aria-label="Order book" onClick={()=>onToggle('book')}>
      <svg viewBox="0 0 28 28" aria-hidden="true"><path d="M7 8h14M11 12h10M9 16h12M13 20h8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
    </button>
    <button type="button" className="tv-icon live-panel-toggle" aria-pressed={panels.order} aria-controls="live-execution-sidebar" title={panels.order?'Hide order panel':'Show order panel'} aria-label="Order panel" onClick={()=>onToggle('order')}>
      <svg viewBox="0 0 28 28" aria-hidden="true"><rect x="5" y="6.5" width="18" height="15" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M16.5 6.5v15" stroke="currentColor" strokeWidth="1.5"/></svg>
    </button>
  </div>;
}

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
  const [panels,setPanels]=useState(readPanels);
  function togglePanel(key:keyof LivePanels){
    setPanels(old=>{const next={...old,[key]:!old[key]};try{localStorage.setItem(panelsKey,JSON.stringify(next));}catch{/* Session only. */}return next;});
  }
  const controlsOpen=panels.order;
  const executionMode=useState<ExecutionMode>('manual');
  const venue=useExchangeVenue();
  const bot=useLiveBot(),botHere=!!bot?.running&&bot.venue===venue;
  return <ExecutionModeContext.Provider value={executionMode}><div id="page-paper" role="tabpanel" aria-labelledby="tab-paper">
    <div className="terminal-grid live-terminal-grid" data-controls={controlsOpen?'visible':'hidden'}>
      <div className={panels.book?"terminal-main has-order-book":"terminal-main"}><ExchangeMarketHeader venue={venue} botRunning={!!bot?.running} actions={<TradingWorkspaceTools showSidebarToggle={false} mode="live" open={controlsOpen} onToggle={()=>togglePanel('order')} panelId="live-execution-sidebar"/>}/><LiveMarketChart key={venue} venue={venue} settings={settings} toolbarEnd={<PanelToggles panels={panels} onToggle={togglePanel}/>} overlay={<BotChartBadge state={botHere?bot?.strategyState:null} running={botHere}/>}/>{panels.book&&<OrderBook venue={venue}/>}<TerminalSplitter/><ExchangeOverview venue={venue}/></div>
      <aside id="live-execution-sidebar" className="terminal-sidebar" aria-label="Live execution" hidden={!controlsOpen}><PaperSessionNotice/><Panel className="live-terminal-controls">{controls}</Panel><BotStatusPanel state={botHere?bot?.strategyState:null} running={botHere} timeLabel={botHere&&bot?.strategyState?.timestamp?new Date(bot.strategyState.timestamp*1000).toISOString().slice(0,16).replace('T',' ')+' UTC':undefined} emptyHint={bot?.running?`The strategy is running on ${bot.venue?.toUpperCase()}. Switch to that exchange to see its status.`:settings.strategy==='none'?'No automated strategy is configured. The market chart and manual order ticket are available.':'Start the strategy in the Bots tab to see live buy and sell readiness.'}/><LiveAssets venue={venue}/></aside>
    </div>
  </div></ExecutionModeContext.Provider>;
}

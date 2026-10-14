import {useEffect,useState,type FormEvent} from 'react';
import {api} from './api';
import type {BacktestSettings} from './types';

type Venue='okx'|'htx'|'mexc'|'binance';
type VenueStatus={venue:Venue;connected:boolean;symbol:string;contractSize?:number;position?:{side?:string;quantity?:number;entryPrice?:number;markPrice?:number;unrealizedPnl?:number;error?:string}|null};
type BotStatus={running:boolean;venue:Venue|null;timeframe:string|null;position:{direction:string;quantity:number;entryPrice:number;stop:number}|null;error:string|null;lastProcessed:number|null};
const venues:{id:Venue;name:string;passphrase?:boolean}[]=[{id:'okx',name:'OKX',passphrase:true},{id:'htx',name:'HTX'},{id:'mexc',name:'MEXC'},{id:'binance',name:'Binance USDⓈ-M'}];
const leverageOptions=[...Array.from({length:20},(_,index)=>index+1),...Array.from({length:16},(_,index)=>(index+5)*5)];

export default function LiveExecution({settings}:{settings:BacktestSettings}){
  const [statuses,setStatuses]=useState<VenueStatus[]>([]),[bot,setBot]=useState<BotStatus>({running:false,venue:null,timeframe:null,position:null,error:null,lastProcessed:null});
  const [venue,setVenue]=useState<Venue>('okx'),[key,setKey]=useState(''),[secret,setSecret]=useState(''),[passphrase,setPassphrase]=useState('');
  const [mode,setMode]=useState<'manual'|'bot'>('manual'),[direction,setDirection]=useState<'long'|'short'>('long');
  const [quantity,setQuantity]=useState('1'),[stop,setStop]=useState(''),[manualConfirm,setManualConfirm]=useState(false),[autoConfirm,setAutoConfirm]=useState(false);
  const [liveLeverage,setLiveLeverage]=useState(String(Math.max(1,Math.floor(settings.max_leverage)))),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const selected=venues.find(item=>item.id===venue)!;
  const account=statuses.find(item=>item.venue===venue);
  const connected=!!account?.connected;
  const botForVenue=bot.running&&bot.venue===venue;

  async function refresh(){
    try{
      const value=await api<{venues:VenueStatus[];bot:BotStatus}>('/api/exchange/status');
      setStatuses(value.venues);setBot(value.bot);
    }catch{/* Keep the last known account display while the backend restarts. */}
  }
  useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),3000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{if(bot.running&&bot.venue===venue)setMode('bot');},[bot.running,bot.venue,venue]);
  async function run(path:string,body?:unknown){
    setBusy(true);setMessage('');
    try{
      const result=await api<any>(path,{method:'POST',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
      setMessage(result.message??(result.order?`Order accepted · ${result.order.side} · ${result.order.filled??result.order.amount} contracts${result.protectiveStop?' · protective stop accepted':''}`:'Request completed.'));
      if(path==='/api/exchange/order')setManualConfirm(false);
      if(path==='/api/exchange/auto/start'){setAutoConfirm(false);setMode('bot');}
      await refresh();return true;
    }catch(error){setMessage(String(error));return false;}finally{setBusy(false);}
  }
  async function connect(event:FormEvent){
    event.preventDefault();
    const ok=await run('/api/exchange/connect',{venue,api_key:key,secret,passphrase:passphrase||null});
    if(ok){setKey('');setSecret('');setPassphrase('');}
  }
  function changeVenue(value:Venue){setVenue(value);setKey('');setSecret('');setPassphrase('');setManualConfirm(false);setAutoConfirm(false);}

  return <div className="live-account-content">
    <div className="live-connect-section">
      <div className="live-section-heading"><div><span className="account-step">01</span><div><h3>Exchange account</h3><p>Connect a supported account for XAG/USDT perpetuals.</p></div></div><span className={`live-badge ${connected?'connected':''}`}>{connected?'CONNECTED':'NOT CONNECTED'}</span></div>
      <div className="exchange-radio-list" role="radiogroup" aria-label="Exchange account"><span className="exchange-radio-heading">Select exchange</span>{venues.map(item=>{const status=statuses.find(value=>value.venue===item.id);return <label key={item.id} className={venue===item.id?'selected':''}><input type="radio" name="live-exchange" value={item.id} checked={venue===item.id} onChange={()=>changeVenue(item.id)}/><span>{item.name}<small>{status?.connected?'Connected':'Set API access'}</small></span></label>;})}</div>
      {connected?<div className="connected-account-row"><div className="connected-account-details"><strong>{selected.name} · {account.symbol}</strong><span>API credentials held in memory until disconnect or backend restart</span></div><div className="connected-position">{account.position?.error?<span className="error">{account.position.error}</span>:account.position?.side?<><strong className={account.position.side==='long'?'positive':'negative'}>{account.position.side.toUpperCase()} · {account.position.quantity} XAG</strong><span>Entry {account.position.entryPrice??'—'} · Mark {account.position.markPrice??'—'} · uPnL {account.position.unrealizedPnl??'—'} USDT</span></>:<span className="muted">No open XAG position</span>}</div>{account.position?.side&&<button type="button" className="secondary close-position-button" disabled={busy||botForVenue} onClick={()=>{if(window.confirm('Send a reduce-only market order to close the XAG/USDT position?'))void run('/api/exchange/close',{venue,confirmation:'CLOSE LIVE POSITION'});}}>Close position</button>}<button type="button" className="text-button disconnect-button" disabled={busy||botForVenue||!!account.position?.side} title={account.position?.side?'Close the position before disconnecting':''} onClick={()=>void run('/api/exchange/disconnect',{venue})}>Disconnect</button></div>:<form className="live-connect-form" onSubmit={connect}>
        <label>API key<input autoComplete="off" spellCheck={false} value={key} onChange={event=>setKey(event.target.value)} required/></label>
        <label>API secret<input autoComplete="new-password" type="password" value={secret} onChange={event=>setSecret(event.target.value)} required/></label>
        {selected.passphrase&&<label>API passphrase<input autoComplete="new-password" type="password" value={passphrase} onChange={event=>setPassphrase(event.target.value)} required/></label>}
        <button className="secondary connect-button" disabled={busy}>{busy?'Connecting…':'Connect account'}</button>
        <p className="credential-note">Use a dedicated key with read and trade access only. Disable withdrawals and restrict by IP where supported. Credentials are never saved in the browser.</p>
      </form>}
    </div>

    <div className="live-method-section">
      <div className="live-section-heading"><div><span className="account-step">02</span><div><h3>Choose execution mode</h3><p>Use a manual ticket or let the BB strategy manage entries and exits.</p></div></div></div>
      <div className="execution-mode-switch" role="radiogroup" aria-label="Live execution mode">
        <label className={mode==='manual'?'selected':''}><input type="radio" name="live-execution-mode" value="manual" checked={mode==='manual'} disabled={botForVenue} onChange={()=>setMode('manual')}/><span>Manual order</span><small>You control each entry</small></label>
        <label className={mode==='bot'?'selected':''}><input type="radio" name="live-execution-mode" value="bot" checked={mode==='bot'} onChange={()=>setMode('bot')}/><span>Strategy bot</span><small>BB Outer Band Reversal</small></label>
      </div>

      {mode==='manual'?<div className="execution-mode-panel manual-panel">
        <div className="manual-order-inputs"><div className="direction-control" role="group" aria-label="Order direction"><button type="button" aria-pressed={direction==='long'} className={direction==='long'?'long selected':''} onClick={()=>setDirection('long')}>Long</button><button type="button" aria-pressed={direction==='short'} className={direction==='short'?'short selected':''} onClick={()=>setDirection('short')}>Short</button></div>
          <label>Quantity <small>XAG</small><input type="number" min="0.001" step="any" value={quantity} onChange={event=>setQuantity(event.target.value)} disabled={!connected||busy||botForVenue}/></label>
          <label>Stop trigger <small>USDT</small><input type="number" min="0.001" step="any" value={stop} onChange={event=>setStop(event.target.value)} disabled={!connected||busy||botForVenue}/></label>
          <label>Isolated leverage<select value={liveLeverage} onChange={event=>setLiveLeverage(event.target.value)} disabled={!connected||busy||botForVenue}>{leverageOptions.map(value=><option key={value} value={value}>{value}×</option>)}</select></label>
        </div>
        <div className="execution-confirm-row"><div><strong>Market entry with protective stop</strong><p>Order size is entered in XAG. Review the fill and stop on the exchange after submission.</p><label className="live-ack"><input type="checkbox" checked={manualConfirm} onChange={event=>setManualConfirm(event.target.checked)} disabled={!connected||busy}/> I understand this sends a real market order.</label></div><button type="button" className="live-danger" disabled={!connected||!manualConfirm||!quantity||!stop||busy||botForVenue} onClick={()=>void run('/api/exchange/order',{venue,direction,quantity:Number(quantity),stop_price:Number(stop),leverage:Number(liveLeverage),confirmation:'PLACE LIVE ORDER'})}>{busy?'Submitting…':`Place ${direction} order`}</button></div>
        {!connected&&<p className="connect-required">Connect an exchange account above to enable the live order ticket.</p>}
      </div>:<div className="execution-mode-panel bot-panel">
        <div className="bot-config-summary"><div><span className="strategy-icon">BB</span><div><strong>BB Outer Band Reversal</strong><small>{settings.entry_timeframe} candles · Both directions · protective exchange stop</small></div></div><label>Leverage<select value={liveLeverage} onChange={event=>setLiveLeverage(event.target.value)} disabled={!connected||bot.running}>{leverageOptions.map(value=><option key={value} value={value}>{value}×</option>)}</select></label></div>
        <p className="live-hint">Uses current strategy settings: {settings.bb_reversal.amount_per_trade}{settings.bb_reversal.amount_unit==='percent'?'%':' USDT'} allocation, with a {settings.entry_timeframe} execution timeframe. Automation checks completed candles and pauses if exchange position state differs from its own.</p>
        {botForVenue?<div className="bot-live-status"><div><span className="bot-running-dot"/><strong>Bot running</strong><span>{bot.venue?.toUpperCase()} · {bot.timeframe} · {bot.position?`${bot.position.direction} ${bot.position.quantity} XAG · stop ${bot.position.stop}`:'Flat · waiting for a signal'}</span></div><button type="button" className="secondary" disabled={busy} onClick={()=>void run('/api/exchange/auto/stop')}>Stop strategy</button></div>:bot.running?<div className="bot-live-status"><div><span className="bot-running-dot"/><strong>Another strategy is active</strong><span>{bot.venue?.toUpperCase()} · {bot.timeframe}. Stop it before starting another.</span></div><button type="button" className="secondary" disabled={busy} onClick={()=>void run('/api/exchange/auto/stop')}>Stop active bot</button></div>:<div className="execution-confirm-row"><div><label className="live-ack"><input type="checkbox" checked={autoConfirm} onChange={event=>setAutoConfirm(event.target.checked)} disabled={!connected||busy}/> I authorize the bot to place and manage real orders.</label><small>Starting requires a flat exchange position. Stopping the bot leaves any open position and exchange stop active.</small></div><button type="button" className="live-danger" disabled={!connected||!autoConfirm||busy} onClick={()=>void run('/api/exchange/auto/start',{...settings,strategy:'bb_outer_reversal',max_leverage:Number(liveLeverage),venue,confirmation:'START LIVE STRATEGY'})}>{busy?'Starting…':'Start live strategy'}</button></div>}
        {!connected&&<p className="connect-required">Connect an exchange account above to configure and start the live strategy.</p>}
        {bot.error&&<p className="error" role="alert">{bot.error}</p>}
      </div>}
    </div>
    <div className="live-account-footer"><strong>Live trading risk</strong><span>Exchange margin, contract sizing and stop triggers vary. Confirm API keys have withdrawals disabled and review every order and protective stop on the exchange.</span><span className="utc-label">Time zone preference is set above.</span></div>
    {message&&<p className={message.startsWith('Error:')?'error':'live-result'} role="status">{message}</p>}
  </div>;
}

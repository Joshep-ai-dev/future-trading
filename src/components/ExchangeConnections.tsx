import {useEffect,useState,type FormEvent} from 'react';
import {EXCHANGES,type ExchangeVenue} from '../exchangeVenue';
import type {ExchangeAction,VenueStatus} from '../exchangeTypes';
import {Button,StatusBadge} from './ui';

type Props={venue:ExchangeVenue;statuses:VenueStatus[];savedVenues:ExchangeVenue[];busy:boolean;onVenueChange:(venue:ExchangeVenue)=>void;onRun:ExchangeAction;onOpenTerminal?:()=>void};
export default function ExchangeConnections({venue,statuses,savedVenues,busy,onVenueChange,onRun,onOpenTerminal}:Props){
  const [apiKey,setApiKey]=useState('');
  const [secret,setSecret]=useState('');
  const [passphrase,setPassphrase]=useState('');
  const exchange=EXCHANGES.find(item=>item.id===venue)!;
  const account=statuses.find(item=>item.venue===venue);
  const connected=!!account?.connected;
  const saved=savedVenues.includes(venue);
  useEffect(()=>{setApiKey('');setSecret('');setPassphrase('');},[venue]);
  async function connect(event:FormEvent){
    event.preventDefault();
    if(await onRun('/api/exchange/connect',{venue,api_key:apiKey,secret,passphrase:passphrase||null})){
      setApiKey('');setSecret('');setPassphrase('');
    }
  }
  function disconnect(){
    if(window.confirm(`Disconnect ${exchange.name}? This stops this app's bot and monitoring. Exchange positions and orders remain active. Saved keys are kept.`))void onRun('/api/exchange/disconnect',{venue});
  }
  function forget(){
    if(window.confirm('Remove the saved API keys from this computer? An active connection stays connected until you disconnect.'))void onRun('/api/exchange/forget',{venue});
  }
  return <div className="connections-workspace">
    <div className="connections-list" role="radiogroup" aria-label="Select exchange connection">
      <div className="connections-list-heading">EXCHANGES <span>{statuses.filter(item=>item.connected).length} connected</span></div>
      {EXCHANGES.map(item=>{
        const active=statuses.some(status=>status.venue===item.id&&status.connected);
        return <label key={item.id} className={`connection-choice ${venue===item.id?'selected':''}`}><input type="radio" name="connection-venue" value={item.id} checked={venue===item.id} onChange={()=>onVenueChange(item.id)}/><span className="connection-monogram" aria-hidden="true">{item.name.slice(0,1)}</span><span><strong>{item.name}</strong><small>{active?'API connected':savedVenues.includes(item.id)?'Saved API keys':'Not connected'}</small></span><i className={active?'connected':''}/></label>;
      })}
    </div>
    <div className="connection-detail">
      <div className="connection-detail-heading"><div><span className="connection-monogram connection-monogram--large" aria-hidden="true">{exchange.name.slice(0,1)}</span><div><h2>{exchange.name}</h2><p>USDT perpetual trading</p></div></div><StatusBadge dot tone={connected?'positive':'neutral'}>{connected?'Connected':'Disconnected'}</StatusBadge></div>
      {connected?<>
        <div className="connection-success"><span aria-hidden="true">✓</span><div><strong>Your exchange is connected</strong></div></div>
        <dl className="connection-metadata"><div><dt>Contract</dt><dd>{account.symbol}</dd></div><div><dt>Credential storage</dt><dd>{saved?'Encrypted on this computer':'Current session only'}</dd></div><div><dt>Connection</dt><dd>Local API session</dd></div></dl>
        <div className="connection-actions"><Button onClick={onOpenTerminal}>Open trading terminal <span aria-hidden="true">↗</span></Button><Button variant="danger" disabled={busy} onClick={disconnect}>{busy?'Working...':'Disconnect'}</Button></div>
        <p className="connection-footnote">Disconnect stops local automation and monitoring. It keeps your saved keys and leaves exchange positions, orders, and stops active.</p>
      </>:<>
        <p className="connection-intro">Connect your {exchange.name} API key to access live market and account data.</p>
        {saved&&<div className="connection-saved"><div><strong>Saved connection available</strong><span>Your API credentials are encrypted on this computer.</span></div><Button variant="secondary" disabled={busy} onClick={()=>void onRun('/api/exchange/reconnect',{venue})}>Reconnect</Button></div>}
        <form className="connection-form" onSubmit={connect}>
          <label className="ui-field"><span>API key</span><input autoComplete="off" spellCheck={false} value={apiKey} onChange={event=>setApiKey(event.target.value)} placeholder="Enter your API key" required disabled={busy}/></label>
          <label className="ui-field"><span>API secret</span><input type="password" autoComplete="new-password" value={secret} onChange={event=>setSecret(event.target.value)} placeholder="Enter your API secret" required disabled={busy}/></label>
          {exchange.passphrase&&<label className="ui-field"><span>API passphrase</span><input type="password" autoComplete="new-password" value={passphrase} onChange={event=>setPassphrase(event.target.value)} required disabled={busy}/></label>}
          <Button type="submit" disabled={busy}>{busy?'Connecting...':'Connect '+exchange.name}</Button>
        </form>
        <p className="connection-footnote">A successful connection saves your credentials encrypted locally for the next session.</p>
      </>}
      <div className="connection-security"><span>Use read and trade permissions with withdrawals disabled.</span>{saved&&<Button variant="ghost" disabled={busy} onClick={forget}>Remove saved keys</Button>}</div>
    </div>
  </div>;
}

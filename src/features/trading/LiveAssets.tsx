import type {ExchangeVenue} from '../../shared/api/exchangeVenue';
import {liveNumber as number,useExchangeStream} from '../../shared/api/useExchangeStream';
import {Panel,StatusBadge} from '../../shared/ui/ui';
import {instrumentDetails,useExchangeInstrument} from '../../shared/api/exchangeInstrument';

export default function LiveAssets({venue}:{venue:ExchangeVenue}){
  const {data,connected}=useExchangeStream(venue);
  const asset=instrumentDetails(useExchangeInstrument()).base;
  const collateral=venue==='hyperliquid'?'USDC':'USDT';
  const verified=data?.positions!=null&&!data.errors.positions;
  const pnl=verified&&data.positions!.every(position=>position.unrealizedPnl!=null)?data.positions!.reduce((sum,position)=>sum+position.unrealizedPnl!,0):null;
  return <Panel className="live-assets" title="Assets" actions={<StatusBadge tone={connected&&data?.streams.account==='live'?'positive':'warning'} dot>{venue.toUpperCase()}</StatusBadge>}>
    <div className="assets-heading"><strong>Margin account</strong><span>{collateral} perpetual</span></div>
    <dl><div><dt>Available margin</dt><dd>{number(data?.balance?.free,4)}</dd></div><div><dt>Used margin</dt><dd>{number(data?.balance?.used,4)}</dd></div><div><dt>Account equity</dt><dd>{number(data?.balance?.total,4)}</dd></div></dl>
    <div className="assets-pnl"><span>Unrealized PnL <small>{asset} · {collateral}</small></span><strong className={pnl==null?'':pnl<0?'negative':'positive'}>{pnl!=null&&pnl>0?'+':''}{number(pnl,4)}</strong></div>
    {data?.errors.balance&&<p className="ticket-help">Balance unavailable. Waiting for the exchange.</p>}
    <p className="assets-note">All amounts in {collateral}. Unavailable exchange values appear as —.</p>
  </Panel>;
}

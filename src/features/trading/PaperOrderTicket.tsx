import {OrderTicket,type InitialBalance} from './ManualOrderTicket';
import type {ExchangeSnapshot} from '../../shared/api/useExchangeStream';
import type {ExchangeVenue} from '../../shared/api/exchangeVenue';
import type {Position} from './PaperTrading';

export default function PaperOrderTicket({asset,venue,price,balance,position,busy,botRunning,fresh,leverage,onLeverageChange,onRun,initialBalance}:{asset:string;venue:ExchangeVenue;price:number|null;balance:number;position:Position|null;busy:boolean;botRunning:boolean;fresh:boolean;leverage:string;onLeverageChange:(value:string)=>void;onRun:(path:string,body:unknown)=>Promise<boolean>;initialBalance?:InitialBalance}){
  const unrealized=position&&price!=null?(price-position.entry_price)*position.direction*position.quantity:0;
  const snapshot:ExchangeSnapshot={symbol:asset,updatedAt:Date.now(),market:{last:price},balance:{free:Math.max(0,balance-(position?.margin??0))},
    positions:position?[{side:position.direction===1?'long':'short',quantity:position.quantity,entryPrice:position.entry_price,
      markPrice:price,unrealizedPnl:unrealized,leverage:Number(leverage),liquidationPrice:null,marginMode:'isolated',initialMargin:null,percentage:null}]:[],
    orders:[],candle:null,errors:{},streams:{market:fresh?'live':'reconnecting',account:'live'},sectionTimes:{}};
  return <OrderTicket paper venue={venue} asset={asset} data={snapshot} streamConnected connected busy={busy} blocked={false} botRunning={botRunning} leverage={leverage} minimumLeverage={1} maximumLeverage={100} leverageLoading={false} onLeverageChange={onLeverageChange} onRun={onRun} initialBalance={initialBalance}/>;
}

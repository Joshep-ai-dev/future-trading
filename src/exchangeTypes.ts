import type {ExchangeVenue} from './exchangeVenue';

export type VenueStatus={executionError?:string|null;venue:ExchangeVenue;connected:boolean;symbol:string;contractSize?:number;position?:{side?:string;quantity?:number;entryPrice?:number;markPrice?:number;unrealizedPnl?:number;error?:string}|null};
export type BotStatus={running:boolean;venue:ExchangeVenue|null;timeframe:string|null;position:{direction:string;quantity:number;entryPrice:number;stop:number}|null;error:string|null;lastProcessed:number|null};
export type ExchangeAction=(path:string,body?:unknown)=>Promise<boolean>;

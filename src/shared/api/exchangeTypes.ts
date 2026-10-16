import type {ExchangeVenue} from './exchangeVenue';

export type VenueStatus={executionError?:string|null;venue:ExchangeVenue;connected:boolean;symbol:string;contractSize?:number;position?:{side?:string;quantity?:number;entryPrice?:number;markPrice?:number;unrealizedPnl?:number;error?:string}|null};
export type StrategyCheck={label:string;passed:boolean;value:number|null;threshold:number|null};
export type StrategyIndicators={bbUpper:number|null;bbBasis:number|null;bbLower:number|null;bbWidthPct:number|null;atr:number|null;adx:number|null;trendSma:number|null;rsi:number|null};
export type StrategyState={indicators?:StrategyIndicators;status:'warming_up'|'scanning'|'position_open';timestamp?:number;close?:number|null;signal?:'long'|'short'|null;longReadiness:number;shortReadiness:number;longChecks:StrategyCheck[];shortChecks:StrategyCheck[];closeState?:{direction:string;entryPrice:number;stop:number;stopDistance:number;trailingActive:boolean}|null};
export type BotStatus={running:boolean;venue:ExchangeVenue|null;timeframe:string|null;position:{direction:string;quantity:number;entryPrice:number;stop:number}|null;strategyState:StrategyState|null;error:string|null;lastProcessed:number|null};
export type ExchangeAction=(path:string,body?:unknown)=>Promise<boolean>;

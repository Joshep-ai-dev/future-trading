import type {UTCTimestamp} from 'lightweight-charts';
import type {Analysis} from '../types/types';
import {TV} from './tvTheme';

/** Shared TradingView-style volume bars used by live, paper, and backtest charts. */
export function chartVolume(candles:Analysis['candles']){
  return candles.filter(candle=>candle.volume!==undefined).map(candle=>({
    time:candle.time as UTCTimestamp,
    value:candle.volume!,
    color:candle.close>=candle.open?TV.upVolume:TV.downVolume,
  }));
}

import type {BacktestSettings} from '../../shared/types/types';

export const bbDefaults: BacktestSettings['bb_reversal'] = {
  rsi_exit_enabled:false,rsi_exit_length:14,rsi_exit_move:.3,rsi_exit_short:15,rsi_exit_long:85,
  trade_mode:'Both',bb_length:20,bb_mult:3,min_bb_width_pct:.8,atr_length:14,min_atr:.03,
  adx_length:14,adx_threshold:20,pullback_bars:3,initial_sl:.5,trail_trigger:.6,
  trail_distance:.3,trail_multiplier:2,sma_length:30,sma_slope_bars:3,
  counter_profit_pct:75,counter_sl_pct:75,quantity:1,use_sma_trend_adjustment:true,amount_per_trade:100,amount_unit:'percent',
};

/** Mirrors server/strategies/ml/strategy.py MLSettings defaults. */
export const mlDefaults: BacktestSettings['ml'] = {
  feature_groups:['returns','volatility','bollinger','trend','oscillators','volume','candles','calendar','higher_timeframe'],
  models:{lightgbm:1,xgboost:0,hist_gbm:0,random_forest:0,extra_trees:.5,logistic:0,neural_net:0},
  horizon:24,take_profit_atr:1.5,stop_atr:1,atr_length:14,entry_threshold:.55,min_edge:.15,min_reward_cost:3,
  train_bars:6000,retrain_every:2000,trade_mode:'Both',reverse_on_signal:true,amount_per_trade:100,amount_unit:'percent',
  capacity:'standard',exit_mode:'learned',tp_quantile:.5,sl_quantile:.7,min_reward_risk:1.2,trailing:true,trail_start:.6,trail_noise:1,
  regimes:['Trend up','Trend down','Range','Volatile'],recency_half_life:2000,min_atr:.03,min_target:.5,let_profit_run:true,quality_filter:true,quality_threshold:.5,
};

export const REGIME_NAMES=['Trend up','Trend down','Range','Volatile'] as const;

export const STRATEGY_LABELS:Record<string,string>={bb_outer_reversal:'BB Outer Band Reversal',ml_ensemble:'ML Ensemble'};

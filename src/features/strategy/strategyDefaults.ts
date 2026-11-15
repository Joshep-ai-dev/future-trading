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
  forecast_guard:true,forecast_next_open:true,forecast_adaptive_exits:true,forecast_max_hold_bars:0,risk_per_trade_pct:.5,max_drawdown_pct:10,daily_loss_pct:3,
  feature_groups:['returns','volatility','trend','volume','candles'],
  models:{extra_trees:1},forecast_model:'extra_trees',sequence_lookback:100,sequence_epochs:30,
  horizon:24,forecast_target_fraction:.8,forecast_stop_buffer:1,take_profit_pct:1,stop_loss_pct:.65,take_profit_atr:1.5,stop_atr:1,atr_length:14,entry_threshold:.55,min_edge:.15,min_reward_cost:3,
  train_bars:6000,retrain_every:2000,trade_mode:'Both',reverse_on_signal:false,amount_per_trade:100,amount_unit:'percent',
  capacity:'light',exit_mode:'forecast',tp_quantile:.5,sl_quantile:.7,min_reward_risk:0,trailing:false,trail_start:.6,trail_noise:1,
  regimes:['Trend up','Trend down','Range','Volatile'],recency_half_life:0,min_atr:.03,min_target:0,let_profit_run:false,quality_filter:false,quality_threshold:.5,device:'auto',
};

export const REGIME_NAMES=['Trend up','Trend down','Range','Volatile'] as const;

export const STRATEGY_LABELS:Record<string,string>={none:'No strategy configured',adx_supertrend:'ADX + Supertrend'};
/** Mirrors server/strategies/adx_supertrend.py Settings defaults. */
export const adxSupertrendDefaults: BacktestSettings['adx_supertrend'] = {
  adx_length: 14, di_length: 14, adx_threshold: 25, adx_rising_bars: 1, require_di_agreement: false,
  st_length: 10, st_multiplier: 3, trade_mode: 'Both', amount_per_trade: 100, amount_unit: 'percent',
  htf_filter: true, htf_timeframe: '1h',
  atr_filter: true, atr_length: 14, atr_window: 500, atr_min_pct: 10, atr_max_pct: 95,
  rsi_filter: true, rsi_length: 14, rsi_overbought: 70, rsi_oversold: 30,
  forecast_filter: false, forecast_model_id: '', forecast_min_probability: 0.55,
};

/** Mirrors server/strategies/ml/directional.py DirectionalSettings defaults (tuned for 5m candles). */
export const mlDirectionalDefaults: BacktestSettings['ml_directional'] = {
  take_profit_atr:4.5,stop_atr:3,max_hold_bars:48,atr_length:14,train_days:90,trade_days:30,calibration_fraction:.15,
  min_probability:.5,min_ev_r:.1,min_gap:.1,vol_low_pct:10,vol_high_pct:98,trade_mode:'Both',trades_per_day:0,
  risk_per_trade_pct:.5,max_drawdown_pct:0,trees:300,learning_rate:.03,max_depth:4,min_leaf:100,seed:7,
};

export const rlDefaults:BacktestSettings['rl']={train_bars:10000,retrain_every:1000,lookback:100,timesteps:51200,learning_rate:.0003,seed:7,min_atr:.03,stop_atr:3,max_drawdown_pct:20,drawdown_penalty:.1,turnover_penalty:.0001,amount_per_trade:100,amount_unit:'percent'};

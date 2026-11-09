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

export const STRATEGY_LABELS:Record<string,string>={bb_outer_reversal:'BB Outer Band Reversal',ml_ensemble:'ML Strategy',rl_ppo:'RL PPO'};

export const rlDefaults:BacktestSettings['rl']={train_bars:10000,retrain_every:1000,lookback:100,timesteps:51200,learning_rate:.0003,seed:7,min_atr:.03,stop_atr:3,max_drawdown_pct:20,drawdown_penalty:.1,turnover_penalty:.0001,amount_per_trade:100,amount_unit:'percent'};

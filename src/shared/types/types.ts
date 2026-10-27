export type Parameters = {timeframe: '1m'|'3m'|'5m'|'10m'|'15m'|'30m'|'1h'|'4h'|'1d'};
export type Analysis = {
  history?: {hasMore: boolean; nextBefore: number | null};
  params: Parameters; asOf: number; dataRange: {startDate: string; endDate: string};
  quality: {minuteBars: number; missingMinutes: number; excludedBars: number; completeBars: number};
  candles: {time: number; open: number; high: number; low: number; close: number; volume?: number}[];
};
export const fmt = (v: number | null, digits=2) => v === null ? '—' : v.toLocaleString('en-US', {maximumFractionDigits: digits});

export type MLConfig = {
  feature_groups: string[]; models: Record<string, number>; horizon: number; take_profit_atr: number; stop_atr: number;
  atr_length: number; entry_threshold: number; min_edge: number; min_reward_cost: number; train_bars: number;
  retrain_every: number; trade_mode: 'Both'|'Long Only'|'Short Only'; reverse_on_signal: boolean;
  amount_per_trade: number; amount_unit: 'price'|'percent'; capacity: 'light'|'standard'|'rich';
  exit_mode: 'learned'|'fixed'; tp_quantile: number; sl_quantile: number; min_reward_risk: number;
  trailing: boolean; trail_start: number; trail_noise: number; regimes: string[]; recency_half_life: number; min_atr: number; min_target: number; let_profit_run: boolean; quality_filter: boolean; quality_threshold: number; device: 'auto'|'gpu'|'cpu';
};
export type RegimeStat = {name:string;share:number;trades:number;netPnl:number;winRate:number|null;allowed:boolean};
export type ModelReport = {
  exitMode?: 'learned'|'fixed'; regimes?: RegimeStat[]; blockedBySize?: number; funnel?: {step:string;remaining:number;note?:string}[]; blockedByRewardRisk?: number; blockedByRegime?: number;
  learnedExits?: {long_tp:number|null;long_sl:number|null;short_tp:number|null;short_sl:number|null};
  folds: {start:number;end:number;trainRows:number;bars:number;accuracy:number|null}[];
  importance: Record<string, number>; featureCount: number; trainedBars: number; accuracy: number|null;
  labelBalance: {long:number;none:number;short:number}; blockedByCost: number;
  medianTarget: number|null; medianRoundTripCost: number|null;
};
export type BacktestSettings = {
  market: 'xag'|'stable';
  atr_active: boolean; atr_period: number; atr_multiplier: number;
  ema_fast: number; ema_slow: number; rsi_period: number; rsi_threshold: number; rsi_active: boolean;
  strategy: 'sweep'|'mtf'|'chartart_v12'|'bb_outer_reversal'|'ml_ensemble'; ml: MLConfig; bb_period: number; chartart_stop_pct: number;
  bb_reversal: {rsi_exit_enabled:boolean; rsi_exit_length:number; rsi_exit_move:number; rsi_exit_short:number; rsi_exit_long:number; amount_per_trade:number; amount_unit:'price'|'percent'; use_sma_trend_adjustment:boolean; trade_mode: 'Both'|'Long Only'|'Short Only'; bb_length:number; bb_mult:number; min_bb_width_pct:number; atr_length:number; min_atr:number; adx_length:number; adx_threshold:number; pullback_bars:number; initial_sl:number; trail_trigger:number; trail_distance:number; trail_multiplier:number; sma_length:number; sma_slope_bars:number; counter_profit_pct:number; counter_sl_pct:number; quantity:number};
  exit_condition: 'none'|'ema'|'rsi'|'either';
  stop_mode: 'none'|'fixed'|'breakeven'|'trailing'|'breakeven_trailing';
  direction_active: boolean; direction_timeframe: '15m'|'30m'|'1h'|'4h';
  setup_active: boolean; setup_timeframe: '5m'|'15m'|'30m'|'1h';
  entry_active: boolean; entry_timeframe: '1m'|'3m'|'5m'|'10m'|'15m'|'30m'|'1h'|'4h'|'1d';
  start_date: string; end_date: string; validation_date?: string; capital: number;
  tick_size: number; fee_bps: number; spread: number; slippage: number; funding_bps: number;
  max_leverage: number; session_start: number; session_end: number; session_timezone: 'UTC'|'Asia/Shanghai'|'Asia/Tokyo'|'Asia/Singapore'|'Europe/London'|'America/New_York';
};
export type Trade = {
  id: number; direction: number; signalTime: number; entryTime: number; exitTime: number;
  entry: number; exit: number; stop: number | null; target: number | null; trigger: number | null; sweepLevel: number | null;
  quantity: number; riskBudget: number; plannedRisk: number | null; netPnl: number; grossPnl: number;
  fees: number; funding: number; executionCost: number; netR: number; balance: number;
  initialStop?: number | null; finalStop?: number | null; initialRisk?: number;
  trailActivationPrice?: number;
  stopHistory?: {time: number; price: number; reason: string; confirmedAt?: number}[];
  exitSignal?: {time: number; closeTime: number; reason: string; ema20: number | null; ema50: number | null; rsi20: number | null};
  exitReason: string; session: string; ambiguous: boolean; obstacle: number | null;
  signalLabel?: string; signalCloseTime?: number; confirmations?: Confirmation[];
  swingHighs: number[]; swingLows: number[]; period: string;
};
export type Summary = {
  trades: number; wins: number; losses: number; netPnl: number; endingBalance: number; returnPct: number;
  winRate: number; profitFactor: number | null; maxDrawdownPct: number; averageR: number;
  fees: number; funding: number; executionCost: number; meets100Trades: boolean;
};
export type PeriodResult = {
  name: string; start: number; end: number; trades: Trade[]; equity: {time: number; value: number}[];
  summary: Summary; status: string;
  diagnostics: {signals: number; invalidEntries: number; sweeps: number; blockedByLevel: number; expiredOrders: number; cancelledOrders: number; ambiguousBars: number};
};
export type Confirmation = {stage: string; timeframe: string; closeTime: number; ema20: number; ema50: number; rsi20: number | null};
export type IndicatorPoint = {time: number; ema20: number | null; ema50: number | null; rsi20: number | null; bbBasis?: number | null; bbUpper?: number | null; bbLower?: number | null; trendSma?:number|null; adx?:number|null; atr?:number|null; bbWidthPct?:number|null};
export type BacktestResult = {runId?: number|null; strategy?: string; model?: ModelReport|null; strategyName: string; executionTimeframe: string; barSeconds: number; indicators: IndicatorPoint[]; settings: BacktestSettings; backtest: PeriodResult; candles: Analysis['candles']};
export type TuneMetrics = {averageWin?:number;averageLoss?:number;payoffRatio?:number|null;score:number;trades:number;wins:number;losses:number;winRate:number;netPnl:number;returnPct:number;maxDrawdownPct:number;averageLossPct:number};
export type FineTuneCase = {
  id:string;rank:number;reliable?:boolean;bestSettings:BacktestSettings;
  bestParameters:Partial<BacktestSettings['bb_reversal']>&{leverage?:number};
  periods:{train:{metrics:TuneMetrics};validation:{metrics:TuneMetrics};forwardTest:{metrics:TuneMetrics}};
};
export type FineTuneResult = {searchMethod?:'grid'|'ml';gridAxes?:Record<string,number[]>|null;
  bestSettings:BacktestSettings;bestParameters:Partial<BacktestSettings['bb_reversal']>&{leverage?:number};
  model:string;objective:string;candidatesEvaluated:number;seedCandidates:number;adaptiveCandidatesEvaluated:number;shortlisted:number;
  periods:{train:{start:number;end:number;metrics:TuneMetrics};validation:{start:number;end:number;metrics:TuneMetrics};forwardTest:{start:number;end:number;metrics:TuneMetrics}};
  candidates?:FineTuneCase[];modelHyperparameters?:Record<string,number|number[]>|null;modelCrossValidationRmse?:number|null;
};

export type CandlePage = {candles: Analysis["candles"]; hasMore: boolean; nextBefore: number | null};

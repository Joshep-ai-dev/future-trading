export type Parameters = {timeframe: '1m'|'3m'|'5m'|'10m'|'15m'|'30m'|'1h'|'4h'|'1d'};
export type Analysis = {
  history?: {hasMore: boolean; nextBefore: number | null};
  params: Parameters; asOf: number; dataRange: {startDate: string; endDate: string};
  quality: {minuteBars: number; missingMinutes: number; excludedBars: number; completeBars: number};
  candles: {time: number; open: number; high: number; low: number; close: number}[];
};
export const fmt = (v: number | null, digits=2) => v === null ? '—' : v.toLocaleString('en-US', {maximumFractionDigits: digits});

export type BacktestSettings = {
  ema_fast: number; ema_slow: number; rsi_period: number; rsi_threshold: number; rsi_active: boolean;
  strategy: 'sweep'|'mtf';
  exit_condition: 'none'|'ema'|'rsi'|'either';
  stop_mode: 'none'|'fixed'|'breakeven'|'trailing'|'breakeven_trailing';
  direction_active: boolean; direction_timeframe: '15m'|'30m'|'1h'|'4h';
  setup_active: boolean; setup_timeframe: '5m'|'15m'|'30m'|'1h';
  entry_active: boolean; entry_timeframe: '1m'|'3m'|'5m'|'15m';
  start_date: string; end_date: string; validation_date: string; capital: number;
  tick_size: number; fee_bps: number; spread: number; slippage: number; funding_bps: number;
  max_leverage: number; session_start: number; session_end: number; session_timezone: string;
};
export type Trade = {
  id: number; direction: number; signalTime: number; entryTime: number; exitTime: number;
  entry: number; exit: number; stop: number | null; target: number | null; trigger: number | null; sweepLevel: number | null;
  quantity: number; riskBudget: number; plannedRisk: number | null; netPnl: number; grossPnl: number;
  fees: number; funding: number; executionCost: number; netR: number; balance: number;
  initialStop?: number | null; finalStop?: number | null; initialRisk?: number;
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
export type IndicatorPoint = {time: number; ema20: number | null; ema50: number | null; rsi20: number | null};
export type BacktestResult = {strategyName: string; executionTimeframe: string; barSeconds: number; indicators: IndicatorPoint[]; settings: BacktestSettings; research: PeriodResult; validation: PeriodResult; candles: Analysis['candles']};

export type CandlePage = {candles: Analysis["candles"]; hasMore: boolean; nextBefore: number | null};

export type Parameters = {timeframe: '1m'|'5m'|'10m'|'15m'|'1h'|'4h'|'1d'};
export type Analysis = {
  history?: {hasMore: boolean; nextBefore: number | null};
  params: Parameters; asOf: number; dataRange: {startDate: string; endDate: string};
  quality: {minuteBars: number; missingMinutes: number; excludedBars: number; completeBars: number};
  candles: {time: number; open: number; high: number; low: number; close: number}[];
};
export const fmt = (v: number, digits=2) => v.toLocaleString('en-US', {maximumFractionDigits: digits});

export type BacktestSettings = {
  start_date: string; end_date: string; validation_date: string; capital: number;
  tick_size: number; fee_bps: number; spread: number; slippage: number; funding_bps: number;
  max_leverage: number; session_start: number; session_end: number; session_timezone: string;
};
export type Trade = {
  id: number; direction: number; signalTime: number; entryTime: number; exitTime: number;
  entry: number; exit: number; stop: number; target: number; trigger: number; sweepLevel: number;
  quantity: number; riskBudget: number; plannedRisk: number; netPnl: number; grossPnl: number;
  fees: number; funding: number; executionCost: number; netR: number; balance: number;
  exitReason: string; session: string; ambiguous: boolean; obstacle: number | null;
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
  diagnostics: {sweeps: number; blockedByLevel: number; expiredOrders: number; cancelledOrders: number; ambiguousBars: number};
};
export type BacktestResult = {settings: BacktestSettings; research: PeriodResult; validation: PeriodResult; candles: Analysis['candles']};

export type CandlePage = {candles: Analysis["candles"]; hasMore: boolean; nextBefore: number | null};

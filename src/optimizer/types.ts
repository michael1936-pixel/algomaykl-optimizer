export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ema9?: number;
  ema21?: number;
  ema50?: number;
  ma_val?: number;
  rsi?: number;
  atr?: number;
  avg_atr?: number;
  vol_ma?: number;
  bb_basis?: number;
  bb_upper?: number;
  bb_lower?: number;
  adx?: number;
  plusDI?: number;
  minusDI?: number;
  bar_index?: number;
  swing_filter?: number;
  ok_bar?: number;
  ok_dist?: number;
  sl_pc_long_entry?: number;
  sl_pc_short_entry?: number;
  be_pc_long?: number;
  be_pc_short?: number;
  trail_pc_long?: number;
  trail_pc_short?: number;
  tp_pc_long?: number;
  tp_pc_short?: number;
  tp_trail_pc_long?: number;
  tp_trail_pc_short?: number;
  s1_can_enter_long?: number;
  s1_can_enter_short?: number;
  s2_can_enter_long?: number;
  s2_can_enter_short?: number;
  s3_can_enter_long?: number;
  s3_can_enter_short?: number;
  s4_can_enter_long?: number;
  s4_can_enter_short?: number;
  s5_can_enter_long?: number;
  s5_can_enter_short?: number;
}

export type StrategyType = 'stocks' | 'futures';

export interface StocksStrategyParameters {
  ma_len: number;
  signals_on_close: boolean;
  stop_distance_percent_long: number;
  be_trigger_pct_long: number;
  trail_rsi_pct_input_long: number;
  tp_percent_long: number;
  tp_trail_distance_long: number;
  rsi_long_entry_min: number;
  rsi_trail_long: number;
  stop_distance_percent_short: number;
  be_trigger_pct_short: number;
  trail_rsi_pct_input_short: number;
  tp_percent_short: number;
  tp_trail_distance_short: number;
  rsi_short_entry_max: number;
  rsi_trail_short: number;
  non_regress_stop: boolean;
  prefer_tp_priority: boolean;
  close_only_trail: boolean;
  allow_flip_L2S: boolean;
  allow_flip_S2L: boolean;
  bars_between_trades: number;
  stop_on_close_only?: boolean;
}

export type StrategyParameters = StocksStrategyParameters | ExtendedStocksStrategyParameters;

export interface Trade {
  entryTime: number;
  entryPrice: number;
  exitTime?: number;
  exitPrice?: number;
  type: 'long' | 'short';
  pnl?: number;
  pnlPct?: number;
  exitReason?: 'stop_loss' | 'take_profit' | 'trailing_stop' | 'signal' | 'flip' | 'end_of_data' | 'tp';
  highestPrice?: number;
  lowestPrice?: number;
  stopPrice?: number;
  tpPrice?: number;
  breakevenTriggered?: boolean;
  capitalAtEntry?: number;
  barsInTrade?: number;
  entryBarIndex?: number;
  exitBarIndex?: number;
  entryStrategyId?: number;
  qty?: number;
  equityBefore?: number;
  equityAfter?: number;
  grossReturnPct?: number;
  commissionSideUsd?: number;
  slippageSideUsd?: number;
  roundTripCostUsd?: number;
  roundTripCostPct?: number;
  nightsInTrade?: number;
  overnightUsd?: number;
  overnightPct?: number;
  netReturnPct?: number;
}

export interface S2SignalRecord {
  time_ms: number;
  close: number;
  barIndex: number;
}

export interface BacktestResult {
  parameters: StrategyParameters;
  totalReturn: number;
  finalCapital: number;
  winRate: number;
  totalTrades: number;
  longTrades: number;
  shortTrades: number;
  winningTrades: number;
  losingTrades: number;
  sharpeRatio: number;
  maxDrawdown: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  totalFeesUsd: number;
  trades: Trade[];
  s2SellSignals?: S2SignalRecord[];
  s2ShortBaseSignals?: S2SignalRecord[];
  s2CanEnterShortSignals?: S2SignalRecord[];
}

export interface ParameterRange {
  min: number;
  max: number;
  step: number;
}

export interface ExtendedStocksStrategyParameters extends StocksStrategyParameters {
  avoid_opening_bar: boolean;
  block_close_bar: boolean;
  use_big_bar_filter: boolean;
  big_bar_atr_mult: number;
  use_dist_filter: boolean;
  max_dist_from_ema50_pc: number;
  cooldown_after_loss_bars: number;
  use_post_trail_tighten: boolean;
  post_trail_tighten_pct: number;
  use_min_bars_post_trail: boolean;
  min_bars_post_trail: number;
  exit_all_now: boolean;
  block_new_entries: boolean;
  use_vix_range_filter: boolean;
  vix_normal_min: number;
  vix_normal_max: number;
  use_vix_exit_long: boolean;
  use_vix_exit_short: boolean;
  use_vix_freeze: boolean;
  vix_lookback_bars: number;
  vix_spike_pct: number;
  vix_freeze_bars: number;
  use_atr_sl: boolean;
  atr_mult_long: number;
  atr_mult_short: number;
  enable_strat1: boolean;
  enable_rsi_exit: boolean;
  rsi_exit_long: number;
  rsi_exit_short: number;
  min_bars_in_trade_exit: number;
  s1_ema_fast_len: number;
  s1_ema_mid_len: number;
  s1_ema_trend_len: number;
  s1_rsi_len: number;
  s1_atr_len: number;
  s1_atr_ma_len: number;
  s1_atr_hi_mult: number;
  s1_adx_len: number;
  s1_adx_strong: number;
  s1_bb_len: number;
  s1_bb_mult: number;
  s1_far_from_bb_pc: number;
  s1_vol_len: number;
  s1_hi_vol_mult: number;
  s1_min_conds: number;
  enable_strat2: boolean;
  bb2_use_trend_filter: boolean;
  bb2_ma_len: number;
  bb2_adx_max: number;
  bb2_adx_len: number;
  bb2_rsi_long_max: number;
  bb2_rsi_short_min: number;
  bb2_bb_len: number;
  bb2_bb_mult: number;
  enable_strat3: boolean;
  s3_breakout_len: number;
  s3_adx_min: number;
  s3_use_vol_filter: boolean;
  s3_vol_mult: number;
  s3_rsi_long_min: number;
  s3_rsi_short_max: number;
  enable_strat4: boolean;
  s4_use_trend_filter: boolean;
  s4_min_inside_range_pc: number;
  s4_rsi_long_min: number;
  s4_rsi_short_max: number;
  enable_strat5: boolean;
  s5_squeeze_len: number;
  s5_atr_mult_low: number;
  s5_range_len: number;
  s5_use_vol_filter: boolean;
  s5_vol_mult: number;
  s5_rsi_long_min: number;
  s5_rsi_short_max: number;
  simulationStartDate?: Date;
}

export interface ExtendedStocksOptimizationConfig {
  strategyType: 'stocks';
  ma_len: ParameterRange;
  bars_between_trades: ParameterRange;
  cooldown_after_loss_bars: ParameterRange;
  allow_flip_L2S: boolean;
  allow_flip_S2L: boolean;
  signals_on_close: boolean;
  non_regress_stop: boolean;
  prefer_tp_priority: boolean;
  close_only_trail: boolean;
  stop_on_close_only: boolean;
  stop_distance_percent_long: ParameterRange;
  be_trigger_pct_long: ParameterRange;
  trail_rsi_pct_input_long: ParameterRange;
  tp_percent_long: ParameterRange;
  tp_trail_distance_long: ParameterRange;
  rsi_long_entry_min: ParameterRange;
  rsi_trail_long: ParameterRange;
  stop_distance_percent_short: ParameterRange;
  be_trigger_pct_short: ParameterRange;
  trail_rsi_pct_input_short: ParameterRange;
  tp_percent_short: ParameterRange;
  tp_trail_distance_short: ParameterRange;
  rsi_short_entry_max: ParameterRange;
  rsi_trail_short: ParameterRange;
  avoid_opening_bar: boolean;
  block_close_bar: boolean;
  use_big_bar_filter: boolean;
  big_bar_atr_mult: ParameterRange;
  use_dist_filter: boolean;
  max_dist_from_ema50_pc: ParameterRange;
  use_post_trail_tighten: boolean;
  post_trail_tighten_pct: ParameterRange;
  use_min_bars_post_trail: boolean;
  min_bars_post_trail: ParameterRange;
  exit_all_now: boolean;
  block_new_entries: boolean;
  use_vix_range_filter: boolean;
  vix_normal_min: ParameterRange;
  vix_normal_max: ParameterRange;
  use_vix_exit_long: boolean;
  use_vix_exit_short: boolean;
  use_vix_freeze: boolean;
  vix_lookback_bars: ParameterRange;
  vix_spike_pct: ParameterRange;
  vix_freeze_bars: ParameterRange;
  use_atr_sl: boolean;
  atr_mult_long: ParameterRange;
  atr_mult_short: ParameterRange;
  enable_strat1: boolean;
  enable_rsi_exit: boolean;
  rsi_exit_long: ParameterRange;
  rsi_exit_short: ParameterRange;
  min_bars_in_trade_exit: ParameterRange;
  s1_ema_fast_len: ParameterRange;
  s1_ema_mid_len: ParameterRange;
  s1_ema_trend_len: ParameterRange;
  s1_rsi_len: ParameterRange;
  s1_atr_len: ParameterRange;
  s1_atr_ma_len: ParameterRange;
  s1_atr_hi_mult: ParameterRange;
  s1_adx_len: ParameterRange;
  s1_adx_strong: ParameterRange;
  s1_bb_len: ParameterRange;
  s1_bb_mult: ParameterRange;
  s1_far_from_bb_pc: ParameterRange;
  s1_vol_len: ParameterRange;
  s1_hi_vol_mult: ParameterRange;
  s1_min_conds: ParameterRange;
  enable_strat2: boolean;
  bb2_use_trend_filter: boolean;
  bb2_ma_len: ParameterRange;
  bb2_adx_max: ParameterRange;
  bb2_adx_len: ParameterRange;
  bb2_rsi_long_max: ParameterRange;
  bb2_rsi_short_min: ParameterRange;
  bb2_bb_len: ParameterRange;
  bb2_bb_mult: ParameterRange;
  enable_strat3: boolean;
  s3_breakout_len: ParameterRange;
  s3_adx_min: ParameterRange;
  s3_use_vol_filter: boolean;
  s3_vol_mult: ParameterRange;
  s3_rsi_long_min: ParameterRange;
  s3_rsi_short_max: ParameterRange;
  enable_strat4: boolean;
  s4_use_trend_filter: boolean;
  s4_min_inside_range_pc: ParameterRange;
  s4_rsi_long_min: ParameterRange;
  s4_rsi_short_max: ParameterRange;
  enable_strat5: boolean;
  s5_squeeze_len: ParameterRange;
  s5_atr_mult_low: ParameterRange;
  s5_range_len: ParameterRange;
  s5_use_vol_filter: boolean;
  s5_vol_mult: ParameterRange;
  s5_rsi_long_min: ParameterRange;
  s5_rsi_short_max: ParameterRange;
}

export interface SymbolData {
  symbol: string;
  candles: Candle[];
  startDate: Date;
  endDate: Date;
}

export interface PeriodSplit {
  trainStartDate: Date;
  trainEndDate: Date;
  testStartDate: Date;
  testEndDate: Date;
  trainPercent: number;
}

export interface PortfolioBacktestResult {
  symbol: string;
  result: BacktestResult;
  capitalAllocated: number;
  contributionToTotal: number;
}

export interface MonthlyPerformance {
  symbol: string;
  year: number;
  month: number;
  returnPct: number;
  endingCapital: number;
  tradesCount: number;
  phase: 'train' | 'test';
}

export interface PortfolioOptimizationResult {
  mode: 'single' | 'portfolio' | 'per-symbol';
  trainPeriod: PeriodSplit;
  trainResults: PortfolioBacktestResult[];
  testResults: PortfolioBacktestResult[];
  totalTrainReturn: number;
  totalTestReturn: number;
  overfit: number;
  parameters: ExtendedStocksStrategyParameters | ExtendedStocksStrategyParameters[];
  monthlyPerformance: MonthlyPerformance[];
  initialCapital: number;
  actualTestedCount?: number;
  skippedCombinations?: number;
  filteringActive?: boolean;
}

export type ObjectiveType = 'profit' | 'consistency' | 'lowDrawdown';

export interface ConsistencyMetrics {
  monthlyReturnStdDev: number;
  monthlyReturnMean: number;
  coefficientOfVariation: number;
  consistencyScore: number;
  slope: number;
  rSquared: number;
  positiveMonthsRatio: number;
}

export interface MultiObjectiveResult {
  bestForProfit: PortfolioOptimizationResult | null;
  bestForConsistency: PortfolioOptimizationResult | null;
  bestForLowDrawdown: PortfolioOptimizationResult | null;
  selectedObjective: ObjectiveType;
  consistencyMetrics?: {
    profit?: ConsistencyMetrics;
    consistency?: ConsistencyMetrics;
    lowDrawdown?: ConsistencyMetrics;
  };
}

export type StageStatusType = 'pending' | 'running' | 'completed' | 'skipped';

export interface StageStatusInfo {
  stageNumber: number;
  stageName: string;
  status: StageStatusType;
  startTime?: number;
  endTime?: number;
  elapsedTime?: number;
  skipReason?: string;
}

export interface SmartProgressInfo {
  currentStage: number;
  totalStages: number;
  stageName: string;
  stageDescription: string;
  currentRound: number;
  current: number;
  total: number;
  stageProgress?: {
    current: number;
    total: number;
    percent: number;
  };
  overallProgress?: {
    current: number;
    total: number;
    percent: number;
  };
  globalBestTrainReturn?: number;
  globalBestTestReturn?: number;
  stageCombinations?: number;
  skippedCombinations?: number;
  stageEstimatedTimeRemaining?: number;
  stageElapsedTime?: number;
}

export interface StageProgressMap {
  [stageNumber: number]: {
    current: number;
    total: number;
  };
}

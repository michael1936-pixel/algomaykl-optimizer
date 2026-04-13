/**
 * Portfolio Optimizer — from server
 * Runs combinations with CombinationCache, preFilterSymbols, indicatorCache
 */
import type {
  SymbolData, PeriodSplit, ExtendedStocksOptimizationConfig,
  ExtendedStocksStrategyParameters, MultiObjectiveResult,
} from './types';
import { runPortfolioBacktest, preFilterSymbols, PreFilteredSymbolData } from './portfolioSimulator';
import { IndicatorCacheManager } from './indicatorCache';

/** Insert into a sorted-descending top-N array, maintaining max size */
function insertTopN(
  arr: Array<{ params: ExtendedStocksStrategyParameters; trainReturn: number }>,
  item: { params: ExtendedStocksStrategyParameters; trainReturn: number },
  maxN: number
) {
  if (arr.length >= maxN && item.trainReturn <= arr[arr.length - 1].trainReturn) return;
  // Binary insert
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].trainReturn > item.trainReturn) lo = mid + 1; else hi = mid;
  }
  arr.splice(lo, 0, item);
  if (arr.length > maxN) arr.length = maxN;
}
import { createEmptyMultiObjectiveResult, updateMultiObjectiveResult } from './multiObjectiveMetrics';
import { getMinConstraint } from './parameterValidation';

export interface ProgressInfo {
  current: number;
  total: number;
  bestReturn?: number;
  bestTestReturn?: number;
  combinationsPerSecond?: number;
  elapsedTime?: number;
  cacheHits?: number;
  cacheSize?: number;
}

export interface CombinationCacheEntry {
  parameters: ExtendedStocksStrategyParameters;
  trainReturn: number;
  testReturn: number;
  stageNumber: number;
  roundNumber: number;
  timestamp: number;
  protected?: boolean;
  strategyEnables: { enable_strat1: boolean; enable_strat2: boolean; enable_strat3: boolean; enable_strat4: boolean; enable_strat5: boolean };
}
export type CombinationCache = Map<string, CombinationCacheEntry>;

const BOOLEAN_PARAMS = [
  'use_big_bar_filter', 'use_dist_filter', 'avoid_opening_bar', 'block_close_bar',
  'use_post_trail_tighten', 'use_min_bars_post_trail', 'use_atr_sl', 'enable_rsi_exit',
  'bb2_use_trend_filter', 's3_use_vol_filter', 's4_use_trend_filter', 's5_use_vol_filter',
  'enable_strat1', 'enable_strat2', 'enable_strat3', 'enable_strat4', 'enable_strat5'
];

const NUMERIC_KEYS = [
  'ma_len', 'stop_distance_percent_long', 'be_trigger_pct_long', 'trail_rsi_pct_input_long',
  'tp_percent_long', 'tp_trail_distance_long', 'rsi_long_entry_min', 'rsi_trail_long',
  'stop_distance_percent_short', 'be_trigger_pct_short', 'trail_rsi_pct_input_short',
  'tp_percent_short', 'tp_trail_distance_short', 'rsi_short_entry_max', 'rsi_trail_short',
  'bars_between_trades', 'big_bar_atr_mult', 'max_dist_from_ema50_pc', 'cooldown_after_loss_bars',
  'post_trail_tighten_pct', 'min_bars_post_trail', 's1_rsi_len', 's1_atr_len', 's1_atr_ma_len',
  's1_atr_hi_mult', 's1_adx_len', 's1_adx_strong', 's1_bb_len', 's1_bb_mult', 's1_far_from_bb_pc',
  's1_vol_len', 's1_hi_vol_mult', 's1_min_conds', 's1_ema_fast_len', 's1_ema_mid_len', 's1_ema_trend_len',
  'bb2_ma_len', 'bb2_adx_max', 'bb2_rsi_long_max', 'bb2_rsi_short_min', 's3_breakout_len', 's3_adx_min',
  's3_vol_mult', 's3_rsi_long_min', 's3_rsi_short_max', 's4_min_inside_range_pc', 's4_rsi_long_min',
  's4_rsi_short_max', 's5_squeeze_len', 's5_atr_mult_low', 's5_range_len', 's5_vol_mult',
  's5_rsi_long_min', 's5_rsi_short_max', 'rsi_exit_long', 'rsi_exit_short', 'min_bars_in_trade_exit',
  'atr_mult_long', 'atr_mult_short',
];

function genRange(min: number, max: number, step: number, paramKey?: string): number[] {
  const minC = paramKey ? getMinConstraint(paramKey) : 0;
  const safeMin = Math.max(minC, min);
  if (safeMin === max) return [safeMin];
  const vals: number[] = [];
  for (let v = safeMin; v <= max + step * 0.01; v += step) vals.push(Number(v.toFixed(10)));
  return vals;
}

function genRangeWithMode(key: string, cfg: any, modes: Record<string, string>): number[] {
  if (!cfg) return [];
  const minC = getMinConstraint(key);
  if ((modes[key] || 'range') === 'fixed') return [Math.max(minC, cfg.min)];
  if (cfg.values?.length > 0) return cfg.values.filter((v: number) => v >= minC);
  return genRange(cfg.min, cfg.max, cfg.step, key);
}

function genBoolRange(key: string, val: boolean, modes: Record<string, string>): number[] {
  return (modes[key] || 'fixed') === 'range' ? [0, 1] : [val ? 1 : 0];
}

function comboKey(params: ExtendedStocksStrategyParameters): string {
  const keys = Object.keys(params).filter(k => !k.startsWith('enable_strat')).sort();
  const pairs = keys.map(k => {
    const v = (params as any)[k];
    return typeof v === 'number' ? `${k}=${v.toFixed(6)}` : typeof v === 'boolean' ? `${k}=${v}` : null;
  }).filter(Boolean);
  pairs.push(`s1=${params.enable_strat1}`, `s2=${params.enable_strat2}`, `s3=${params.enable_strat3}`, `s4=${params.enable_strat4}`, `s5=${params.enable_strat5}`);
  return pairs.join('|');
}

export function markBestCacheEntryProtected(cache: CombinationCache, stage: number, round: number): void {
  let bestKey: string | null = null, bestRet = -Infinity;
  for (const [k, e] of cache) {
    if (e.stageNumber === stage && e.roundNumber === round && e.trainReturn > bestRet) { bestRet = e.trainReturn; bestKey = k; }
  }
  if (bestKey) { const e = cache.get(bestKey); if (e) e.protected = true; }
}

export async function optimizePortfolio(
  symbolsData: SymbolData[],
  config: ExtendedStocksOptimizationConfig,
  periodSplit: PeriodSplit,
  mode: string,
  simConfig: any,
  onProgress: (info: ProgressInfo) => void,
  signal?: AbortSignal,
  parameterModes?: Record<string, string>,
  _useMemory = false,
  _objective = 'profit',
  combinationCache?: CombinationCache,
  stageNumber = 0,
  roundNumber = 0,
  preFiltered?: PreFilteredSymbolData[],
  indicatorCache?: IndicatorCacheManager,
  collectAllResults = false,
): Promise<MultiObjectiveResult & { allTestedResults?: Array<{ params: ExtendedStocksStrategyParameters; trainReturn: number }> }> {
  const pModes = parameterModes || {};
  const ext = config as any;

  // Build ranges
  const ranges: Record<string, number[]> = {};
  for (const key of NUMERIC_KEYS) {
    if (ext[key] && typeof ext[key] === 'object' && 'min' in ext[key]) {
      ranges[key] = genRangeWithMode(key, ext[key], pModes);
    }
  }
  for (const bp of BOOLEAN_PARAMS) {
    const val = ext[bp];
    if (typeof val === 'object' && val !== null && 'values' in val) {
      ranges[bp] = (pModes[bp] || 'range') === 'range' && val.values?.length > 1 ? [0, 1] : [val.values?.[0] ? 1 : 0];
    } else {
      ranges[bp] = genBoolRange(bp, val ?? false, pModes);
    }
  }

  const rangeKeys = Object.keys(ranges).filter(k => ranges[k].length > 0);
  const rangeArrays = rangeKeys.map(k => ranges[k]);
  const totalCombos = rangeArrays.reduce((a, b) => a * b.length, 1);

  if (!preFiltered) preFiltered = preFilterSymbols(symbolsData, periodSplit);
  if (!indicatorCache) indicatorCache = new IndicatorCacheManager();

  let current = 0, bestTrainReturn = -Infinity, bestTestReturn = -Infinity, cacheHits = 0;
  let multiResult = createEmptyMultiObjectiveResult('profit');
  const allResults: Array<{ params: ExtendedStocksStrategyParameters; trainReturn: number }> = [];
  const startTime = Date.now();

  // Generate combinations iteratively
  const indices = new Array(rangeKeys.length).fill(0);
  const lengths = rangeArrays.map(a => a.length);

  for (let iter = 0; iter < totalCombos; iter++) {
    if (signal?.aborted) break;

    const combo: Record<string, number> = {};
    for (let j = 0; j < rangeKeys.length; j++) combo[rangeKeys[j]] = rangeArrays[j][indices[j]];

    const params = {
      ...combo,
      non_regress_stop: ext.non_regress_stop, prefer_tp_priority: ext.prefer_tp_priority,
      close_only_trail: ext.close_only_trail, allow_flip_L2S: ext.allow_flip_L2S, allow_flip_S2L: ext.allow_flip_S2L,
      signals_on_close: ext.signals_on_close ?? true,
      avoid_opening_bar: combo.avoid_opening_bar === 1, block_close_bar: combo.block_close_bar === 1,
      use_big_bar_filter: combo.use_big_bar_filter === 1, use_dist_filter: combo.use_dist_filter === 1,
      use_post_trail_tighten: combo.use_post_trail_tighten === 1, use_min_bars_post_trail: combo.use_min_bars_post_trail === 1,
      use_atr_sl: combo.use_atr_sl === 1, enable_rsi_exit: combo.enable_rsi_exit === 1,
      enable_strat1: combo.enable_strat1 === 1, enable_strat2: combo.enable_strat2 === 1,
      enable_strat3: combo.enable_strat3 === 1, enable_strat4: combo.enable_strat4 === 1,
      enable_strat5: combo.enable_strat5 === 1,
      bb2_use_trend_filter: combo.bb2_use_trend_filter === 1, s3_use_vol_filter: combo.s3_use_vol_filter === 1,
      s4_use_trend_filter: combo.s4_use_trend_filter === 1, s5_use_vol_filter: combo.s5_use_vol_filter === 1,
      exit_all_now: false, block_new_entries: false,
      use_vix_range_filter: false, vix_normal_min: 10, vix_normal_max: 30,
      use_vix_exit_long: false, use_vix_exit_short: false, use_vix_freeze: false,
      vix_lookback_bars: 1, vix_spike_pct: 8, vix_freeze_bars: 1,
    } as ExtendedStocksStrategyParameters;

    const key = comboKey(params);

    if (combinationCache?.has(key)) {
      const cached = combinationCache.get(key)!;
      cacheHits++;
      if (cached.trainReturn > bestTrainReturn) { bestTrainReturn = cached.trainReturn; bestTestReturn = cached.testReturn; }
      if (collectAllResults) insertTopN(allResults, { params, trainReturn: cached.trainReturn }, 200);
      current++;
    } else {
      const result = runPortfolioBacktest(symbolsData, params, periodSplit, mode, simConfig, preFiltered, indicatorCache);
      current++;
      if (typeof result.totalTrainReturn === 'number' && !isNaN(result.totalTrainReturn)) {
        const portfolioResult = {
          mode: preFiltered.length === 1 ? 'single' as const : 'portfolio' as const,
          trainPeriod: periodSplit,
          trainResults: result.trainResults.map((r: any) => ({ ...r, result: { ...r.result, trades: [] } })),
          testResults: result.testResults.map((r: any) => ({ ...r, result: { ...r.result, trades: [] } })),
          totalTrainReturn: result.totalTrainReturn, totalTestReturn: result.totalTestReturn,
          overfit: result.totalTrainReturn > 0 ? Math.abs(result.totalTrainReturn - result.totalTestReturn) / result.totalTrainReturn : 0,
          parameters: params, monthlyPerformance: [], initialCapital: 10000,
        };
        multiResult = updateMultiObjectiveResult(multiResult, portfolioResult);
        if (result.totalTrainReturn > bestTrainReturn) { bestTrainReturn = result.totalTrainReturn; bestTestReturn = result.totalTestReturn; }
        if (combinationCache) {
          combinationCache.set(key, {
            parameters: params, trainReturn: result.totalTrainReturn, testReturn: result.totalTestReturn,
            stageNumber, roundNumber, timestamp: Date.now(),
            strategyEnables: { enable_strat1: params.enable_strat1, enable_strat2: params.enable_strat2, enable_strat3: params.enable_strat3, enable_strat4: params.enable_strat4, enable_strat5: params.enable_strat5 },
          });
        }
        if (collectAllResults) insertTopN(allResults, { params, trainReturn: result.totalTrainReturn }, 200);
      }
    }


    // Progress
    if (current % 500 === 0 || current === totalCombos) {
      const elapsed = (Date.now() - startTime) / 1000;
      const cps = current / Math.max(elapsed, 0.001);
      onProgress({ current, total: totalCombos, bestReturn: bestTrainReturn, bestTestReturn, combinationsPerSecond: cps, elapsedTime: elapsed, cacheHits, cacheSize: combinationCache?.size });
      await new Promise(r => setTimeout(r, 0));
    }

    // Advance indices
    for (let j = rangeKeys.length - 1; j >= 0; j--) {
      indices[j]++;
      if (indices[j] < lengths[j]) break;
      indices[j] = 0;
    }
  }

  const finalResult: any = {
    bestForProfit: multiResult.bestForProfit ? { ...multiResult.bestForProfit, actualTestedCount: current, stageCacheHits: cacheHits, stageNewCombinations: current - cacheHits } : null,
    bestForConsistency: multiResult.bestForConsistency,
    bestForLowDrawdown: multiResult.bestForLowDrawdown,
    selectedObjective: 'profit',
  };
  if (collectAllResults) finalResult.allTestedResults = allResults;
  return finalResult;
}

// No re-exports needed

export const DEFAULT_EXTENDED_STOCKS_PARAMETERS: ExtendedStocksStrategyParameters = {
  ma_len: 50, signals_on_close: true,
  stop_distance_percent_long: 5, be_trigger_pct_long: 35, trail_rsi_pct_input_long: 15,
  tp_percent_long: 6, tp_trail_distance_long: 3, rsi_long_entry_min: 52, rsi_trail_long: 75,
  stop_distance_percent_short: 5, be_trigger_pct_short: 35, trail_rsi_pct_input_short: 15,
  tp_percent_short: 6, tp_trail_distance_short: 3, rsi_short_entry_max: 35, rsi_trail_short: 30,
  non_regress_stop: false, prefer_tp_priority: true, close_only_trail: false,
  allow_flip_L2S: true, allow_flip_S2L: true, bars_between_trades: 0,
  avoid_opening_bar: false, block_close_bar: false,
  use_big_bar_filter: false, big_bar_atr_mult: 4, use_dist_filter: false, max_dist_from_ema50_pc: 15,
  cooldown_after_loss_bars: 0,
  use_post_trail_tighten: false, post_trail_tighten_pct: 4,
  use_min_bars_post_trail: false, min_bars_post_trail: 12,
  exit_all_now: false, block_new_entries: false,
  use_vix_range_filter: false, vix_normal_min: 10, vix_normal_max: 30,
  use_vix_exit_long: false, use_vix_exit_short: false,
  use_vix_freeze: false, vix_lookback_bars: 1, vix_spike_pct: 8, vix_freeze_bars: 1,
  use_atr_sl: false, atr_mult_long: 1.5, atr_mult_short: 1.5,
  enable_strat1: true, enable_rsi_exit: false,
  rsi_exit_long: 65, rsi_exit_short: 48, min_bars_in_trade_exit: 2,
  s1_ema_fast_len: 9, s1_ema_mid_len: 21, s1_ema_trend_len: 50,
  s1_rsi_len: 14, s1_atr_len: 16, s1_atr_ma_len: 12, s1_atr_hi_mult: 0.85,
  s1_adx_len: 11, s1_adx_strong: 18, s1_bb_len: 20, s1_bb_mult: 2.2,
  s1_far_from_bb_pc: 2, s1_vol_len: 16, s1_hi_vol_mult: 1, s1_min_conds: 3,
  enable_strat2: false, bb2_use_trend_filter: false,
  bb2_ma_len: 100, bb2_adx_max: 25, bb2_adx_len: 11,
  bb2_rsi_long_max: 50, bb2_rsi_short_min: 30, bb2_bb_len: 20, bb2_bb_mult: 2.2,
  enable_strat3: false, s3_breakout_len: 14, s3_adx_min: 15,
  s3_use_vol_filter: false, s3_vol_mult: 2, s3_rsi_long_min: 52, s3_rsi_short_max: 35,
  enable_strat4: false, s4_use_trend_filter: false,
  s4_min_inside_range_pc: 0.5, s4_rsi_long_min: 52, s4_rsi_short_max: 35,
  enable_strat5: false, s5_squeeze_len: 5, s5_atr_mult_low: 1.5,
  s5_range_len: 10, s5_use_vol_filter: false, s5_vol_mult: 1.5,
  s5_rsi_long_min: 52, s5_rsi_short_max: 35,
} as ExtendedStocksStrategyParameters;

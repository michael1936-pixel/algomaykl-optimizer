/**
 * Smart Optimizer — from server
 * 3 Rounds, 30 Stages (broad → refine → final)
 */
import { ENABLE_SMART_OPTIMIZER_LOGS } from './debugConfig';
import type {
  ExtendedStocksOptimizationConfig, ExtendedStocksStrategyParameters,
  SymbolData, PeriodSplit, MultiObjectiveResult,
} from './types';

/** Build version — always logged (even when ENABLE_SMART_OPTIMIZER_LOGS=false)
 *  so we can verify which code Railway is actually running */
export const OPTIMIZER_BUILD = 'v16-2026-04-12-full-sync';
import {
  optimizePortfolio, ProgressInfo, CombinationCache, markBestCacheEntryProtected,
  DEFAULT_EXTENDED_STOCKS_PARAMETERS,
} from './portfolioOptimizer';
import { preFilterSymbols } from './portfolioSimulator';
import { IndicatorCacheManager } from './indicatorCache';
import { createEmptyMultiObjectiveResult, updateMultiObjectiveResult } from './multiObjectiveMetrics';
import { NNE_PRESET_CONFIG } from './presetConfigs';
import { getMinConstraint } from './parameterValidation';

export interface SmartProgressInfo {
  current: number;
  total: number;
  currentStage: number;
  totalStages: number;
  stageName: string;
  stageDescription: string;
  bestReturn?: number;
  bestTestReturn?: number;
}

export interface StageResult {
  stageNumber: number;
  stageName: string;
  bestReturn: number;
  bestTestReturn: number;
  elapsedTime: number;
  plannedCombinations: number;
  actualTestedCombinations: number;
  bestParameters: any;
}

export interface StageStatus {
  stageNumber: number;
  stageName: string;
  status: 'pending' | 'running' | 'completed' | 'skipped';
  startTime?: number;
  endTime?: number;
  elapsedTime?: number;
  skipReason?: string;
}

// Alias for backward compatibility with Backtest.tsx
export type SmartOptimizationProgress = SmartProgressInfo;

export interface SmartOptimizationResult {
  finalResult: MultiObjectiveResult;
  stageResults: StageResult[];
  wasStopped?: boolean;
  wasPartiallySkipped?: boolean;
}

interface OptimizationStage {
  name: string;
  description: string;
  parametersToOptimize: string[];
  roundNumber: 1 | 2 | 3;
  stepMultiplier?: number;
  enabledStrategies?: { strat1: boolean; strat2: boolean; strat3: boolean; strat4: boolean; strat5: boolean };
  disableGlobalFilters?: boolean;
  isFinalTuning?: boolean;
  tuneRange?: number;
  useZoneData?: boolean;
  round1StageIndex?: number;
  isStrategyCombinationStage?: boolean;
  customRanges?: Record<string, { min: number; max: number; step: number }>;
  filterKey?: string;
}

const BOOLEAN_PARAMS_SET = new Set([
  'use_big_bar_filter', 'use_dist_filter', 'avoid_opening_bar', 'block_close_bar',
  'use_atr_sl', 'enable_rsi_exit', 'bb2_use_trend_filter', 's3_use_vol_filter',
  's4_use_trend_filter', 's5_use_vol_filter', 'enable_strat2', 'enable_strat3',
  'enable_strat4', 'enable_strat5'
]);

const GLOBAL_FILTER_BOOLS = new Set(['use_big_bar_filter', 'use_dist_filter', 'avoid_opening_bar', 'block_close_bar', 'use_atr_sl', 'enable_rsi_exit']);

const STAGE_FILTER_KEYS: Record<number, string> = { 3: 'bb2_use_trend_filter', 4: 's3_use_vol_filter', 5: 's4_use_trend_filter', 6: 's5_use_vol_filter' };

// ═══ Base 7 stages (reused in all 3 rounds) ═══
const BASE_STAGES: Omit<OptimizationStage, 'roundNumber'>[] = [
  { name: 'ניהול לונג', description: 'Long management', parametersToOptimize: ['stop_distance_percent_long', 'trail_rsi_pct_input_long', 'tp_percent_long', 'tp_trail_distance_long', 'rsi_long_entry_min', 'rsi_trail_long'] },
  { name: 'ניהול שורט', description: 'Short management', parametersToOptimize: ['stop_distance_percent_short', 'trail_rsi_pct_input_short', 'tp_percent_short', 'tp_trail_distance_short', 'rsi_short_entry_max', 'rsi_trail_short'] },
  { name: 'אסטרטגיה 1 EMA Trend', description: 'S1', parametersToOptimize: ['s1_ema_fast_len', 's1_ema_mid_len', 's1_ema_trend_len', 's1_rsi_len', 's1_atr_len', 's1_atr_ma_len', 's1_atr_hi_mult', 's1_adx_len', 's1_adx_strong', 's1_bb_len', 's1_bb_mult', 's1_far_from_bb_pc', 's1_vol_len', 's1_hi_vol_mult', 's1_min_conds'] },
  { name: 'אסטרטגיה 2 Bollinger', description: 'S2', parametersToOptimize: ['enable_strat2', 'bb2_use_trend_filter', 'bb2_ma_len', 'bb2_adx_max', 'bb2_rsi_long_max', 'bb2_rsi_short_min'] },
  { name: 'אסטרטגיה 3 Breakout', description: 'S3', parametersToOptimize: ['enable_strat3', 's3_use_vol_filter', 's3_breakout_len', 's3_adx_min', 's3_vol_mult', 's3_rsi_long_min', 's3_rsi_short_max'] },
  { name: 'אסטרטגיה 4 Inside Bar', description: 'S4', parametersToOptimize: ['enable_strat4', 's4_use_trend_filter', 's4_min_inside_range_pc', 's4_rsi_long_min', 's4_rsi_short_max'] },
  { name: 'אסטרטגיה 5 ATR Squeeze', description: 'S5', parametersToOptimize: ['enable_strat5', 's5_use_vol_filter', 's5_squeeze_len', 's5_atr_mult_low', 's5_range_len', 's5_vol_mult', 's5_rsi_long_min', 's5_rsi_short_max'] },
];

function generateDynamicStages(stepMult: number = 4): OptimizationStage[] {
  const stages: OptimizationStage[] = [];

  // Round 1: 7 stages — broad scan (step ×4)
  // Stages 0-2 (Long, Short, S1 EMA): strat1=true only
  // Stages 3-6 (S2-S5): each strategy runs ALONE (strat1=false)
  // S1 EMA stage (index 2) gets custom ranges to target ~373K combos instead of stepMult
  const S1_CUSTOM_RANGES: Record<string, { min: number; max: number; step: number }> = {
    // 6 high-impact params → 3 values each
    s1_ema_fast_len: { min: 5, max: 15, step: 5 },
    s1_rsi_len: { min: 10, max: 20, step: 5 },
    s1_adx_strong: { min: 14, max: 24, step: 5 },
    s1_atr_hi_mult: { min: 0.5, max: 1.2, step: 0.35 },
    s1_hi_vol_mult: { min: 0.8, max: 1.5, step: 0.35 },
    s1_bb_mult: { min: 1.8, max: 2.6, step: 0.4 },
    // 9 secondary params → 2 values each (min, max)
    s1_ema_mid_len: { min: 15, max: 30, step: 15 },
    s1_ema_trend_len: { min: 30, max: 70, step: 40 },
    s1_atr_len: { min: 10, max: 20, step: 10 },
    s1_atr_ma_len: { min: 8, max: 16, step: 8 },
    s1_adx_len: { min: 8, max: 16, step: 8 },
    s1_bb_len: { min: 15, max: 25, step: 10 },
    s1_far_from_bb_pc: { min: 1, max: 4, step: 3 },
    s1_vol_len: { min: 10, max: 20, step: 10 },
    s1_min_conds: { min: 2, max: 4, step: 2 },
  };

  for (let i = 0; i < 7; i++) {
    const stratNum = i - 1;
    const isS1Stage = i <= 2; // Long, Short, S1 EMA
    const isS1EmaStage = i === 2;
    stages.push({
      ...BASE_STAGES[i], roundNumber: 1, stepMultiplier: isS1EmaStage ? 1 : stepMult,
      enabledStrategies: { strat1: isS1Stage, strat2: stratNum === 2, strat3: stratNum === 3, strat4: stratNum === 4, strat5: stratNum === 5 },
      disableGlobalFilters: true, filterKey: STAGE_FILTER_KEYS[i],
      ...(isS1EmaStage ? { customRanges: S1_CUSTOM_RANGES } : {}),
    });
  }

  // Round 2: 7 stages — zone fine-tuning (S1 uses fineTune instead of zones)
  // Same strategy isolation as R1: S2-S5 run alone without S1
  for (let i = 0; i < 7; i++) {
    const stratNum = i - 1;
    const isS1Stage = i <= 2;
    const isS1EmaStage = i === 2;
    stages.push({
      ...BASE_STAGES[i], name: `דיוק ${BASE_STAGES[i].name}`, roundNumber: 2,
      enabledStrategies: { strat1: isS1Stage, strat2: stratNum === 2, strat3: stratNum === 3, strat4: stratNum === 4, strat5: stratNum === 5 },
      disableGlobalFilters: true, filterKey: STAGE_FILTER_KEYS[i],
      // S1 EMA: use fine-tune ±1 instead of zone expansion (too many params)
      ...(isS1EmaStage ? { isFinalTuning: true, tuneRange: 1 } : { useZoneData: true, round1StageIndex: i }),
    });
  }

  // Round 3: 16 stages
  // 3.1: Strategy combination
  stages.push({
    name: 'שילוב אסטרטגיות', description: 'Find winning combo',
    parametersToOptimize: ['enable_strat2', 'enable_strat3', 'enable_strat4', 'enable_strat5'],
    roundNumber: 3, isStrategyCombinationStage: true
  });

  // 3.2: Final fine-tune ±2 (7 stages)
  for (let i = 0; i < 7; i++) {
    stages.push({ ...BASE_STAGES[i], name: `דיוק סופי ${BASE_STAGES[i].name}`, roundNumber: 3, isFinalTuning: true, tuneRange: 2 });
  }

  // 3.3: Zone-based Long/Short
  stages.push({ ...BASE_STAGES[0], name: 'ניהול לונג Zones', roundNumber: 3, useZoneData: true, round1StageIndex: 0 });
  stages.push({ ...BASE_STAGES[1], name: 'ניהול שורט Zones', roundNumber: 3, useZoneData: true, round1StageIndex: 1 });

  // 3.4: Global filters (6 stages)
  stages.push({ name: 'מסנן Big Bar', description: 'Big bar filter', parametersToOptimize: ['use_big_bar_filter', 'big_bar_atr_mult'], roundNumber: 3, customRanges: { big_bar_atr_mult: { min: 2, max: 8, step: 0.1 } } });
  stages.push({ name: 'מסנן מרחק EMA50', description: 'Distance filter', parametersToOptimize: ['use_dist_filter', 'max_dist_from_ema50_pc'], roundNumber: 3, customRanges: { max_dist_from_ema50_pc: { min: 13, max: 25, step: 0.5 } } });
  stages.push({ name: 'סטופ ATR', description: 'ATR stop', parametersToOptimize: ['use_atr_sl', 'atr_mult_long', 'atr_mult_short'], roundNumber: 3, customRanges: { atr_mult_long: { min: 0.2, max: 3, step: 0.1 }, atr_mult_short: { min: 0.2, max: 3, step: 0.1 } } });
  stages.push({ name: 'יציאה RSI', description: 'RSI exit', parametersToOptimize: ['enable_rsi_exit', 'rsi_exit_long', 'rsi_exit_short', 'min_bars_in_trade_exit'], roundNumber: 3, customRanges: { rsi_exit_long: { min: 40, max: 75, step: 1 }, rsi_exit_short: { min: 20, max: 60, step: 1 }, min_bars_in_trade_exit: { min: 2, max: 12, step: 1 } } });
  stages.push({ name: 'חסימת נרות', description: 'Bar blocking', parametersToOptimize: ['avoid_opening_bar', 'block_close_bar'], roundNumber: 3 });
  stages.push({ name: 'מרווח עסקאות', description: 'Bars between trades', parametersToOptimize: ['bars_between_trades'], roundNumber: 3, customRanges: { bars_between_trades: { min: 1, max: 15, step: 1 } } });

  return stages;
}

// ═══ Config builders ═══

function expandConfigForStage(stage: OptimizationStage, baseConfig: ExtendedStocksOptimizationConfig, bestParams: Partial<ExtendedStocksStrategyParameters>): ExtendedStocksOptimizationConfig {
  const cfg = JSON.parse(JSON.stringify(baseConfig)) as ExtendedStocksOptimizationConfig;
  const stepMult = stage.stepMultiplier || 1;

  // Lock all params NOT in this stage to best values
  Object.keys(cfg).forEach(key => {
    const val = (cfg as any)[key];
    if (typeof val !== 'object' || val === null || !('min' in val)) return;
    if (stage.parametersToOptimize.includes(key)) return;
    const best = (bestParams as any)[key];
    const lockVal = typeof best === 'number' ? Math.max(getMinConstraint(key), best) : Math.max(getMinConstraint(key), val.min);
    (cfg as any)[key] = { min: lockVal, max: lockVal, step: val.step };
  });

  // Expand optimized params — use preset ranges for Round 1
  stage.parametersToOptimize.forEach(key => {
    if (BOOLEAN_PARAMS_SET.has(key)) return;
    const preset = (NNE_PRESET_CONFIG as any)[key];
    if (preset && typeof preset === 'object' && 'min' in preset && preset.min !== preset.max) {
      const step = (preset.step || 1) * stepMult;
      (cfg as any)[key] = { min: preset.min, max: preset.max, step };
    }
  });

  // Apply custom ranges
  if (stage.customRanges) {
    for (const [k, r] of Object.entries(stage.customRanges)) (cfg as any)[k] = { min: r.min, max: r.max, step: r.step };
  }

  // Set strategy enables
  if (stage.enabledStrategies) {
    cfg.enable_strat1 = stage.enabledStrategies.strat1;
    (cfg as any).enable_strat2 = stage.enabledStrategies.strat2;
    (cfg as any).enable_strat3 = stage.enabledStrategies.strat3;
    (cfg as any).enable_strat4 = stage.enabledStrategies.strat4;
    (cfg as any).enable_strat5 = stage.enabledStrategies.strat5;
  }

  // Disable global filters for Round 1 & 2
  if (stage.disableGlobalFilters) {
    GLOBAL_FILTER_BOOLS.forEach(k => (cfg as any)[k] = false);
    (cfg as any).bars_between_trades = { min: 0, max: 0, step: 1 };
  }

  // Lock booleans to best
  BOOLEAN_PARAMS_SET.forEach(k => {
    if (!stage.parametersToOptimize.includes(k) && k in bestParams) (cfg as any)[k] = (bestParams as any)[k];
  });

  return cfg;
}

function createFineTuneConfig(baseConfig: ExtendedStocksOptimizationConfig, bestParams: Partial<ExtendedStocksStrategyParameters>, paramsToTune: string[], tuneRange = 2): ExtendedStocksOptimizationConfig {
  const cfg = JSON.parse(JSON.stringify(baseConfig)) as ExtendedStocksOptimizationConfig;

  Object.keys(cfg).forEach(key => {
    const val = (cfg as any)[key];
    if (typeof val !== 'object' || val === null || !('min' in val)) return;
    const best = (bestParams as any)[key];
    if (paramsToTune.includes(key)) {
      const numBest = typeof best === 'number' ? best : (val.min + val.max) / 2;
      const origStep = val.step;
      const min = Math.max(getMinConstraint(key), numBest - origStep * tuneRange);
      const max = numBest + origStep * tuneRange;
      (cfg as any)[key] = { min, max, step: origStep };
    } else {
      const lockVal = typeof best === 'number' ? Math.max(getMinConstraint(key), best) : Math.max(getMinConstraint(key), val.min);
      (cfg as any)[key] = { min: lockVal, max: lockVal, step: val.step };
    }
  });

  BOOLEAN_PARAMS_SET.forEach(k => {
    if (!paramsToTune.includes(k) && k in bestParams) (cfg as any)[k] = (bestParams as any)[k];
    else if (paramsToTune.includes(k)) (cfg as any)[k] = { values: [false, true] };
  });

  return cfg;
}

function collectTopZones(allResults: Array<{ params: ExtendedStocksStrategyParameters; trainReturn: number }>, paramsToOptimize: string[], numZones: number): Record<string, number[]> {
  const zones: Record<string, number[]> = {};
  const numericParams = paramsToOptimize.filter(k => !BOOLEAN_PARAMS_SET.has(k));

  for (const paramKey of numericParams) {
    const valueGroups = new Map<number, { sum: number; count: number; values: number[] }>();
    for (const r of allResults) {
      const v = (r.params as any)[paramKey];
      if (typeof v !== 'number') continue;
      const rounded = Number(v.toFixed(10));
      const existing = valueGroups.get(rounded);
      if (existing) { existing.sum += r.trainReturn; existing.count++; existing.values.push(r.trainReturn); }
      else valueGroups.set(rounded, { sum: r.trainReturn, count: 1, values: [r.trainReturn] });
    }
    // Score = avg_return / std × log(count) — per document spec
    const scored = Array.from(valueGroups.entries()).map(([value, { sum, count, values }]) => {
      const avg = sum / count;
      const variance = values.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / Math.max(count, 1);
      const std = Math.sqrt(variance);
      const score = std > 0.0001 ? (avg / std) * Math.log(count + 1) : avg * Math.log(count + 1);
      return { value, score, count };
    }).sort((a, b) => b.score - a.score);
    zones[paramKey] = scored.slice(0, numZones).map(s => s.value).sort((a, b) => a - b);
  }
  return zones;
}

function createZoneConfig(baseConfig: ExtendedStocksOptimizationConfig, zones: Record<string, number[]>, paramsToOptimize: string[], bestParams: Partial<ExtendedStocksStrategyParameters>, expansionSteps: number): ExtendedStocksOptimizationConfig {
  const cfg = JSON.parse(JSON.stringify(baseConfig)) as ExtendedStocksOptimizationConfig;

  Object.keys(cfg).forEach(key => {
    const val = (cfg as any)[key];
    if (typeof val !== 'object' || val === null || !('min' in val)) return;
    if (paramsToOptimize.includes(key)) return;
    const best = (bestParams as any)[key];
    const lockVal = typeof best === 'number' ? Math.max(getMinConstraint(key), best) : Math.max(getMinConstraint(key), val.min);
    (cfg as any)[key] = { min: lockVal, max: lockVal, step: val.step };
  });

  for (const key of paramsToOptimize) {
    if (BOOLEAN_PARAMS_SET.has(key)) continue;
    const zoneValues = zones[key];
    if (!zoneValues || zoneValues.length === 0) continue;
    const origVal = (baseConfig as any)[key];
    const origStep = origVal?.step || 1;
    const minC = getMinConstraint(key);
    const expanded = new Set<number>();
    zoneValues.forEach(v => {
      for (let s = -expansionSteps; s <= expansionSteps; s++) {
        const val = v + origStep * s;
        if (val >= minC) expanded.add(val);
      }
    });
    const sorted = Array.from(expanded).sort((a, b) => a - b);
    (cfg as any)[key] = { min: sorted[0], max: sorted[sorted.length - 1], step: origStep, values: sorted };
  }

  BOOLEAN_PARAMS_SET.forEach(k => {
    if (!paramsToOptimize.includes(k) && k in bestParams) (cfg as any)[k] = (bestParams as any)[k];
  });

  return cfg;
}

// ═══ Main Optimizer Entry Point ═══

export async function runSmartOptimization(
  symbolsData: SymbolData[],
  baseConfig: ExtendedStocksOptimizationConfig,
  periodSplit: PeriodSplit,
  mode: string,
  simulationConfig: any,
  onProgress?: (info: SmartProgressInfo) => void,
  abortSignal?: AbortSignal,
  _useMemory = false,
  _objective = 'profit',
  _enableRound2 = true,
  _enableRound3 = true,
  enabledStages?: boolean[],
  _onSkipStageCallback?: any,
  _onSaveState?: any,
  _savedState?: any,
  round1StepMultiplier: number = 4,
  numGoodZones: number = 10,
  zoneExpansionSteps: number = 1,
  abortCheckFn?: () => Promise<boolean>,
): Promise<SmartOptimizationResult> {
  // Always log build version — critical for verifying Railway deployment
  console.log(`SMART_OPTIMIZER_BUILD=${OPTIMIZER_BUILD}`);
  if (ENABLE_SMART_OPTIMIZER_LOGS) {
    console.log('════════════════════════════════════════');
    console.log(`Smart Optimizer: ${symbolsData.length} symbols, ${mode} mode`);
    console.log(`Round 1: step ×${round1StepMultiplier} | Round 2: ${numGoodZones} zones ±${zoneExpansionSteps} | Round 3: combo + fine-tune`);
    console.log('════════════════════════════════════════');
  }

  const stages = generateDynamicStages(round1StepMultiplier);
  if (ENABLE_SMART_OPTIMIZER_LOGS) console.log(`Total stages: ${stages.length} (7 + 7 + ${stages.length - 14})`);

  const stageResults: StageResult[] = [];
  let bestParams: Partial<ExtendedStocksStrategyParameters> = {};
  let globalBestTrain = -Infinity, globalBestTest = -Infinity;
  let globalResult = createEmptyMultiObjectiveResult('profit');
  const cache: CombinationCache = new Map();
  const preFiltered = preFilterSymbols(symbolsData, periodSplit);
  const indicatorCache = new IndicatorCacheManager();

  // Collected zones from Round 1
  const round1Zones: Record<number, Array<{ params: ExtendedStocksStrategyParameters; trainReturn: number }>> = {};

  let activeCombination: { strat1: boolean; strat2: boolean; strat3: boolean; strat4: boolean; strat5: boolean } | null = null;

  let lastAbortCheck = Date.now();
  let prevRound = 0;
  for (let si = 0; si < stages.length; si++) {
    if (abortSignal?.aborted) break;

    // Check if stage is disabled by user
    if (enabledStages && enabledStages.length > si && !enabledStages[si]) continue;

    const stage = stages[si];
    const stageStart = Date.now();

    // Memory cleanup at round boundaries
    if (stage.roundNumber !== prevRound) {
      // Free round1Zones after Round 2 — no longer needed
      if (stage.roundNumber >= 3 && Object.keys(round1Zones).length > 0) {
        for (const key in round1Zones) delete round1Zones[key];
        if (ENABLE_SMART_OPTIMIZER_LOGS) console.log('🧹 Freed round1Zones memory');
      }
      // At start of Round 2, trim round1Zones to 50 entries per stage
      if (stage.roundNumber === 2) {
        for (const key of Object.keys(round1Zones)) {
          const k = Number(key);
          if (round1Zones[k] && round1Zones[k].length > 50) {
            round1Zones[k] = round1Zones[k].slice(0, 50);
          }
        }
      }
      // v15: No eviction — 24GB RAM, keep all cache entries across rounds
      prevRound = stage.roundNumber;
    }

    // Abort check — every 5 seconds, check if run was cancelled
    if (abortCheckFn) {
      if (!lastAbortCheck) lastAbortCheck = Date.now();
      if (Date.now() - lastAbortCheck > 5000) {
        lastAbortCheck = Date.now();
        const shouldAbort = await abortCheckFn();
        if (shouldAbort) {
          console.log(`🛑 Abort signal received at stage ${si + 1}/${stages.length}`);
          break;
        }
      }
    }

    if (ENABLE_SMART_OPTIMIZER_LOGS) {
      console.log(`\n▶ Stage ${si + 1}/${stages.length}: ${stage.name} (Round ${stage.roundNumber})`);
      console.log(`  isFinalTuning=${!!stage.isFinalTuning} useZoneData=${!!stage.useZoneData} customRanges=${!!stage.customRanges} stepMult=${stage.stepMultiplier || 1}`);
    }

    // Apply winning combination strategies to Round 3 stages
    if (activeCombination && stage.roundNumber === 3 && !stage.isStrategyCombinationStage) {
      stage.enabledStrategies = { ...activeCombination };
    }

    // Strategy Combination Stage — 23 specific combos per document spec
    if (stage.isStrategyCombinationStage) {
      const STRATEGY_COMBOS: { strat1: boolean; strat2: boolean; strat3: boolean; strat4: boolean; strat5: boolean }[] = [
        // 5 Singles
        { strat1: true, strat2: false, strat3: false, strat4: false, strat5: false },
        { strat1: false, strat2: true, strat3: false, strat4: false, strat5: false },
        { strat1: false, strat2: false, strat3: true, strat4: false, strat5: false },
        { strat1: false, strat2: false, strat3: false, strat4: true, strat5: false },
        { strat1: false, strat2: false, strat3: false, strat4: false, strat5: true },
        // 9 Pairs (including Breakout+InsideBar, InsideBar+ATR)
        { strat1: true, strat2: true, strat3: false, strat4: false, strat5: false },
        { strat1: true, strat2: false, strat3: true, strat4: false, strat5: false },
        { strat1: true, strat2: false, strat3: false, strat4: true, strat5: false },
        { strat1: true, strat2: false, strat3: false, strat4: false, strat5: true },
        { strat1: false, strat2: true, strat3: true, strat4: false, strat5: false },
        { strat1: false, strat2: true, strat3: false, strat4: true, strat5: false },
        { strat1: false, strat2: false, strat3: true, strat4: true, strat5: false },
        { strat1: false, strat2: false, strat3: true, strat4: false, strat5: true },
        { strat1: false, strat2: false, strat3: false, strat4: true, strat5: true },
        // 4 Triples
        { strat1: true, strat2: true, strat3: true, strat4: false, strat5: false },
        { strat1: true, strat2: true, strat3: false, strat4: true, strat5: false },
        { strat1: true, strat2: false, strat3: true, strat4: false, strat5: true },
        { strat1: true, strat2: false, strat3: false, strat4: true, strat5: true },
        // 5 "All except X"
        { strat1: false, strat2: true, strat3: true, strat4: true, strat5: true },
        { strat1: true, strat2: false, strat3: true, strat4: true, strat5: true },
        { strat1: true, strat2: true, strat3: false, strat4: true, strat5: true },
        { strat1: true, strat2: true, strat3: true, strat4: false, strat5: true },
        { strat1: true, strat2: true, strat3: true, strat4: true, strat5: false },
      ];

      let bestComboScore = -Infinity;
      let bestComboResult: any = null;
      let bestComboStrategies: typeof STRATEGY_COMBOS[0] | null = null;

      for (let ci = 0; ci < STRATEGY_COMBOS.length; ci++) {
        if (abortSignal?.aborted) break;
        const combo = STRATEGY_COMBOS[ci];
        const comboCfg = expandConfigForStage(stage, baseConfig, bestParams);
        comboCfg.enable_strat1 = combo.strat1;
        (comboCfg as any).enable_strat2 = combo.strat2;
        (comboCfg as any).enable_strat3 = combo.strat3;
        (comboCfg as any).enable_strat4 = combo.strat4;
        (comboCfg as any).enable_strat5 = combo.strat5;

        try {
          const comboResult = await optimizePortfolio(
            symbolsData, comboCfg, periodSplit, mode, simulationConfig,
            (info) => onProgress?.({ ...info, current: ci, total: STRATEGY_COMBOS.length, currentStage: si + 1, totalStages: stages.length, stageName: `${stage.name} (${ci + 1}/${STRATEGY_COMBOS.length})`, stageDescription: stage.description, bestReturn: info.bestReturn, bestTestReturn: info.bestTestReturn }),
            abortSignal, undefined, false, 'profit', cache, si + 1, stage.roundNumber, preFiltered, indicatorCache,
          );
          if (comboResult.bestForProfit) {
            const bp = comboResult.bestForProfit;
            const trainRet = bp.totalTrainReturn;
            const testRet = bp.totalTestReturn;
            const returnScore = (trainRet + testRet) / 2;
            const overfit = Math.abs(trainRet - testRet);
            const overfitPenalty = 1 / (1 + overfit / 200);
            const activeCount = [combo.strat1, combo.strat2, combo.strat3, combo.strat4, combo.strat5].filter(Boolean).length;
            const diversityBonus = 1 + (activeCount - 1) * 0.05;
            // winRate and tradeCount from train results
            const totalTrades = bp.trainResults.reduce((s: number, r: any) => s + (r.result?.totalTrades || 0), 0);
            const totalWins = bp.trainResults.reduce((s: number, r: any) => s + (r.result?.wins || 0), 0);
            const winRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
            const winRateBonus = Math.max(0, (winRate - 50) / 50);
            const tradeCountBonus = Math.min(totalTrades / 50, 1);
            const score = returnScore * overfitPenalty * diversityBonus * (1 + winRateBonus * 0.3 + tradeCountBonus * 0.2);

            if (ENABLE_SMART_OPTIMIZER_LOGS) console.log(`  Combo ${ci + 1}/23: [${combo.strat1 ? 'S1' : ''}${combo.strat2 ? 'S2' : ''}${combo.strat3 ? 'S3' : ''}${combo.strat4 ? 'S4' : ''}${combo.strat5 ? 'S5' : ''}] score=${score.toFixed(2)} ret=${returnScore.toFixed(2)} overfit=${overfit.toFixed(2)}`);

            if (score > bestComboScore) {
              bestComboScore = score;
              bestComboResult = bp;
              bestComboStrategies = combo;
            }
            globalResult = updateMultiObjectiveResult(globalResult, bp);
          }
        } catch (e: any) {
          console.warn(`Combo ${ci + 1} error: ${e.message}`);
        }
      }

      if (bestComboStrategies && bestComboResult) {
        activeCombination = { ...bestComboStrategies };
        bestParams.enable_strat2 = activeCombination.strat2;
        bestParams.enable_strat3 = activeCombination.strat3;
        bestParams.enable_strat4 = activeCombination.strat4;
        bestParams.enable_strat5 = activeCombination.strat5;
        if (bestComboResult.totalTrainReturn > globalBestTrain) {
          globalBestTrain = bestComboResult.totalTrainReturn;
          globalBestTest = bestComboResult.totalTestReturn;
        }
        stageResults.push({ stageNumber: si + 1, stageName: stage.name, bestReturn: bestComboResult.totalTrainReturn, bestTestReturn: bestComboResult.totalTestReturn, elapsedTime: (Date.now() - stageStart) / 1000, plannedCombinations: 23, actualTestedCombinations: STRATEGY_COMBOS.length, bestParameters: { ...bestParams } });
        if (ENABLE_SMART_OPTIMIZER_LOGS) console.log(`  ✓ Winning combo: S1=${activeCombination.strat1} S2=${activeCombination.strat2} S3=${activeCombination.strat3} S4=${activeCombination.strat4} S5=${activeCombination.strat5} (score=${bestComboScore.toFixed(2)})`);
      }
      continue;
    }

    // Build config for this stage
    let stageCfg: ExtendedStocksOptimizationConfig;
    if (stage.isFinalTuning) {
      stageCfg = createFineTuneConfig(baseConfig, bestParams, stage.parametersToOptimize, stage.tuneRange || 2);
    } else if (stage.useZoneData && stage.round1StageIndex !== undefined && round1Zones[stage.round1StageIndex]) {
      const zones = collectTopZones(round1Zones[stage.round1StageIndex], stage.parametersToOptimize, Math.min(numGoodZones, 50));
      stageCfg = createZoneConfig(baseConfig, zones, stage.parametersToOptimize, bestParams, zoneExpansionSteps);

      // Guard against Cartesian explosion: if zone config produces too many combos, fallback to fine-tune
      const numericKeys = stage.parametersToOptimize.filter(k => !BOOLEAN_PARAMS_SET.has(k));
      let estimatedCombos = 1;
      for (const key of numericKeys) {
        const val = (stageCfg as any)[key];
        if (val?.values?.length) estimatedCombos *= val.values.length;
        else if (val && typeof val === 'object' && 'min' in val && 'max' in val && 'step' in val) {
          estimatedCombos *= Math.max(1, Math.floor((val.max - val.min) / val.step) + 1);
        }
      }
      if (estimatedCombos > 5000) {
        if (ENABLE_SMART_OPTIMIZER_LOGS) console.log(`⚠ Zone config too large (${estimatedCombos} combos), falling back to fine-tune for stage ${si}`);
        stageCfg = createFineTuneConfig(baseConfig, bestParams, stage.parametersToOptimize, 2);
      }
    } else if (stage.roundNumber === 2) {
      // R2 fallback: fine-tune around best values instead of full range
      stageCfg = createFineTuneConfig(baseConfig, bestParams, stage.parametersToOptimize, 2);
    } else {
      stageCfg = expandConfigForStage(stage, baseConfig, bestParams);
    }

    // ═══ COMBO GUARD: cap every stage at 300K combos ═══
    {
      const MAX_STAGE_COMBOS = 300_000;
      const numericKeys = stage.parametersToOptimize.filter(k => !BOOLEAN_PARAMS_SET.has(k));
      const boolCount = stage.parametersToOptimize.filter(k => BOOLEAN_PARAMS_SET.has(k)).length;

      const countCombos = (cfg: ExtendedStocksOptimizationConfig): number => {
        let c = Math.pow(2, boolCount);
        for (const key of numericKeys) {
          const val = (cfg as any)[key];
          if (val?.values?.length) c *= val.values.length;
          else if (val && typeof val === 'object' && 'min' in val && 'max' in val && 'step' in val) {
            c *= Math.max(1, Math.floor((val.max - val.min) / val.step) + 1);
          }
        }
        return c;
      };

      let combos = countCombos(stageCfg);

      // Step 1: try reducing tuneRange (only for fine-tune stages)
      if (combos > MAX_STAGE_COMBOS && !stage.customRanges) {
        let tr = 2;
        while (combos > MAX_STAGE_COMBOS && tr > 0) {
          tr--;
          stageCfg = createFineTuneConfig(baseConfig, bestParams, stage.parametersToOptimize, tr);
          combos = countCombos(stageCfg);
          if (ENABLE_SMART_OPTIMIZER_LOGS) console.log(`⚠ Combo guard: tuneRange=${tr} → ${combos} combos`);
        }
      }

      // Step 2: if still over cap, prune values per parameter to fit
      if (combos > MAX_STAGE_COMBOS) {
        const originalCombos = combos;
        const numParams = numericKeys.length || 1;
        const comboBudgetForNumeric = MAX_STAGE_COMBOS / Math.max(1, Math.pow(2, boolCount));
        const maxValsPerParam = Math.max(2, Math.floor(Math.pow(comboBudgetForNumeric, 1 / numParams)));

        for (const key of numericKeys) {
          const val = (stageCfg as any)[key];
          if (!val) continue;

          // Get all candidate values
          let allValues: number[] = [];
          if (val.values?.length) {
            allValues = [...val.values];
          } else if (typeof val === 'object' && 'min' in val && 'max' in val && 'step' in val) {
            for (let v = val.min; v <= val.max + val.step * 0.01; v += val.step) {
              allValues.push(Math.round(v * 1e6) / 1e6);
            }
          }

          if (allValues.length <= maxValsPerParam) continue;

          // Keep maxValsPerParam values closest to bestParams value
          const best = (bestParams as any)[key] ?? allValues[Math.floor(allValues.length / 2)];
          allValues.sort((a, b) => Math.abs(a - best) - Math.abs(b - best));
          const kept = allValues.slice(0, maxValsPerParam).sort((a, b) => a - b);
          (stageCfg as any)[key] = { values: kept };
        }

        combos = countCombos(stageCfg);
        if (ENABLE_SMART_OPTIMIZER_LOGS) console.log(`⚠ Combo cap: ${originalCombos} → ${combos} (maxValsPerParam=${maxValsPerParam})`);
      }
    }

    // Set strategy enables from stage config
    if (stage.enabledStrategies) {
      stageCfg.enable_strat1 = stage.enabledStrategies.strat1;
      (stageCfg as any).enable_strat2 = stage.enabledStrategies.strat2;
      (stageCfg as any).enable_strat3 = stage.enabledStrategies.strat3;
      (stageCfg as any).enable_strat4 = stage.enabledStrategies.strat4;
      (stageCfg as any).enable_strat5 = stage.enabledStrategies.strat5;
    }
    if (stage.disableGlobalFilters) {
      GLOBAL_FILTER_BOOLS.forEach(k => (stageCfg as any)[k] = false);
      (stageCfg as any).bars_between_trades = { min: 0, max: 0, step: 1 };
    }

    // ═══ TELEMETRY: count actual planned combos before running ═══
    {
      const numericKeys = stage.parametersToOptimize.filter(k => !BOOLEAN_PARAMS_SET.has(k));
      const boolCount = stage.parametersToOptimize.filter(k => BOOLEAN_PARAMS_SET.has(k)).length;
      let plannedCombos = Math.pow(2, boolCount);
      for (const key of numericKeys) {
        const val = (stageCfg as any)[key];
        if (val?.values?.length) plannedCombos *= val.values.length;
        else if (val && typeof val === 'object' && 'min' in val && 'max' in val && 'step' in val) {
          plannedCombos *= Math.max(1, Math.floor((val.max - val.min) / val.step) + 1);
        }
      }
      if (ENABLE_SMART_OPTIMIZER_LOGS) {
        const source = stage.isFinalTuning ? 'fineTune' : stage.useZoneData ? 'zoneData' : stage.customRanges ? 'customRanges' : 'expandConfig';
        console.log(`START R${stage.roundNumber}/S${(si % 7) + 1} ${stage.name} | source=${source} | combos=${plannedCombos}`);
      }
    }

    try {
      const collectAll = stage.roundNumber === 1;
      const result = await optimizePortfolio(
        symbolsData, stageCfg, periodSplit, mode, simulationConfig,
        (info) => onProgress?.({ ...info, current: info.current, total: info.total, currentStage: si + 1, totalStages: stages.length, stageName: stage.name, stageDescription: stage.description, bestReturn: Math.max(globalBestTrain, info.bestReturn || 0), bestTestReturn: Math.max(globalBestTest, info.bestTestReturn || 0) }),
        abortSignal, undefined, false, 'profit', cache, si + 1, stage.roundNumber, preFiltered, indicatorCache, collectAll,
      );

      if (result.bestForProfit) {
        const bp = result.bestForProfit.parameters as ExtendedStocksStrategyParameters;
        const stageTrainReturn = result.bestForProfit.totalTrainReturn;
        const stageTestReturn = result.bestForProfit.totalTestReturn;

        // Extract optimized params
        stage.parametersToOptimize.forEach(param => {
          const value = (bp as any)[param];
          if (value !== undefined) (bestParams as any)[param] = value;
        });

        // ═══ REGRESSION DETECTION (Round 2+) ═══
        // If this stage returned worse than global best, rollback to global best params
        let regressionDetected = false;
        if (stage.roundNumber >= 2 && globalBestTrain !== -Infinity && stageTrainReturn < globalBestTrain) {
          regressionDetected = true;
          if (ENABLE_SMART_OPTIMIZER_LOGS) console.log(`⚠ REGRESSION detected at stage ${si + 1} (R${stage.roundNumber}): stage=${stageTrainReturn.toFixed(2)}% < global=${globalBestTrain.toFixed(2)}%`);
          // Rollback: restore params that this stage changed to global best values
          if (globalResult.bestForProfit) {
            const globalParams = globalResult.bestForProfit.parameters as ExtendedStocksStrategyParameters;
            stage.parametersToOptimize.forEach(paramKey => {
              const globalVal = (globalParams as any)[paramKey];
              if (globalVal !== undefined) {
                (bestParams as any)[paramKey] = globalVal;
              }
            });
            if (ENABLE_SMART_OPTIMIZER_LOGS) console.log(`  ↩ Rolled back ${stage.parametersToOptimize.length} params to global best values`);
          }
        }

        if (stageTrainReturn > globalBestTrain) {
          globalBestTrain = stageTrainReturn;
          globalBestTest = stageTestReturn;
        }
        globalResult = updateMultiObjectiveResult(globalResult, result.bestForProfit);
        markBestCacheEntryProtected(cache, si + 1, stage.roundNumber);

        // Save Round 1 results for zone-based tuning in Round 2 (top 50 only to save memory)
        if (collectAll && result.allTestedResults) {
          const sorted = result.allTestedResults
            .sort((a: any, b: any) => b.trainReturn - a.trainReturn)
            .slice(0, 50);
          round1Zones[si] = sorted;
        }

        // Free round1Zones entry after Round 2 stage consumed it
        if (stage.useZoneData && stage.round1StageIndex !== undefined && round1Zones[stage.round1StageIndex]) {
          delete round1Zones[stage.round1StageIndex];
          if (ENABLE_SMART_OPTIMIZER_LOGS) console.log(`🧹 Freed round1Zones[${stage.round1StageIndex}] after use`);
        }

        stageResults.push({
          stageNumber: si + 1, stageName: stage.name,
          bestReturn: stageTrainReturn, bestTestReturn: stageTestReturn,
          elapsedTime: (Date.now() - stageStart) / 1000,
          plannedCombinations: 0, actualTestedCombinations: 0,
          bestParameters: { ...bestParams },
        });
      }
    } catch (e: any) {
      if (abortSignal?.aborted) break;
      console.warn(`Stage ${si + 1} error: ${e.message}`);
    }
  }

  // ═══ FINAL COMPARISON: Fine-tuned bestParams vs Global Best ═══
  // If the last stage produced results, compare against global best
  const lastStage = stageResults[stageResults.length - 1];
  if (lastStage && globalResult.bestForProfit) {
    if (ENABLE_SMART_OPTIMIZER_LOGS) {
      const fineTunedAvg = (lastStage.bestReturn + lastStage.bestTestReturn) / 2;
      const globalAvg = (globalResult.bestForProfit.totalTrainReturn + globalResult.bestForProfit.totalTestReturn) / 2;
      if (globalAvg > fineTunedAvg) {
        console.log(`✓ Final comparison: Global best (${globalAvg.toFixed(2)}%) wins over fine-tuned (${fineTunedAvg.toFixed(2)}%) — using global`);
      } else {
        console.log(`✓ Final comparison: Fine-tuned (${fineTunedAvg.toFixed(2)}%) wins over global (${globalAvg.toFixed(2)}%) — fine-tuning improved results`);
      }
    }
  }

  return { finalResult: globalResult, stageResults, wasStopped: abortSignal?.aborted || false };
}

export function getOptimizationStages(): { name: string; stageNumber: number; round: number }[] {
  const stages = generateDynamicStages();
  return stages.map((s, i) => ({ name: s.name, stageNumber: i + 1, round: s.roundNumber }));
}

/** Estimate combinations for each stage before running */
export function estimateAllStageCombinations(baseConfig: ExtendedStocksOptimizationConfig): Record<number, number> {
  const stages = generateDynamicStages();
  const estimates: Record<number, number> = {};
  const topRound1FullCombos = 3;
  const localExpansionChoices = 3; // center-step, center, center+step

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    let count = 1;

    if (stage.isStrategyCombinationStage) {
      count = 23;
    } else if (stage.isFinalTuning) {
      const tuneRange = stage.tuneRange || 2;
      for (const key of stage.parametersToOptimize) {
        if (BOOLEAN_PARAMS_SET.has(key)) { count *= 2; continue; }
        const customRange = stage.customRanges?.[key];
        const preset = customRange || (baseConfig as any)[key];
        if (preset && typeof preset === 'object' && 'min' in preset && preset.min !== preset.max) {
          count *= (2 * tuneRange + 1);
        }
      }
    } else if (stage.useZoneData) {
      // Per document: Round 2 is seeded from the top full combinations of Round 1,
      // then each varying numeric parameter is expanded locally by -step / center / +step.
      count = topRound1FullCombos;
      for (const key of stage.parametersToOptimize) {
        if (BOOLEAN_PARAMS_SET.has(key)) continue;
        const customRange = stage.customRanges?.[key];
        const preset = customRange || (baseConfig as any)[key];
        if (preset && typeof preset === 'object' && 'min' in preset && preset.min !== preset.max) {
          count *= localExpansionChoices;
        }
      }
    } else {
      for (const key of stage.parametersToOptimize) {
        if (BOOLEAN_PARAMS_SET.has(key)) { count *= 2; continue; }
        const customRange = stage.customRanges?.[key];
        const preset = customRange || (baseConfig as any)[key];
        if (preset && typeof preset === 'object' && 'min' in preset && preset.min !== preset.max) {
          const step = (preset.step || 1) * (stage.stepMultiplier || 1);
          const range = Math.floor((preset.max - preset.min) / step) + 1;
          count *= Math.max(1, range);
        }
      }
    }

    const isS3Stage = stage.parametersToOptimize.some(p => p.startsWith('s3_'));
    const cap = isS3Stage ? 100_000 : 300_000;
    estimates[i + 1] = Math.min(cap, Math.max(1, count));
  }
  return estimates;
}

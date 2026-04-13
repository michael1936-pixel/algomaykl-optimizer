/**
 * Indicator Cache Manager — from server
 * Hash-based caching: compute once, reuse ~600K times
 */
import type { Candle, ExtendedStocksStrategyParameters } from './types';
import {
  calculateRSI, calculateEMA, calculateATR, calculateBBPine,
  calculateADXPine, calculateEMAPine
} from './indicators';
import { StrategyIndicators } from './strategies';

function simpleSMA(values: number[], length: number): number[] {
  const out = new Array(values.length).fill(NaN);
  if (length <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= length) sum -= values[i - length];
    if (i >= length - 1) out[i] = sum / length;
  }
  return out;
}

export function rollingHighest(values: number[], length: number): number[] {
  const out = new Array(values.length).fill(NaN);
  if (length <= 0) return out;
  const deque: number[] = [];
  for (let i = 0; i < values.length; i++) {
    while (deque.length > 0 && values[deque[deque.length - 1]] <= values[i]) deque.pop();
    deque.push(i);
    if (deque[0] <= i - length) deque.shift();
    if (i >= length - 1) out[i] = values[deque[0]];
  }
  return out;
}

export function rollingLowest(values: number[], length: number): number[] {
  const out = new Array(values.length).fill(NaN);
  if (length <= 0) return out;
  const deque: number[] = [];
  for (let i = 0; i < values.length; i++) {
    while (deque.length > 0 && values[deque[deque.length - 1]] >= values[i]) deque.pop();
    deque.push(i);
    if (deque[0] <= i - length) deque.shift();
    if (i >= length - 1) out[i] = values[deque[0]];
  }
  return out;
}

export interface PrecomputedData {
  closes: number[];
  highs: number[];
  lows: number[];
  vols: number[];
  rsiArr: number[];
  atrArr: number[];
  avgAtrArr: number[];
  volMaArr: number[];
  emaTrendArr: number[];
  ema9Arr: number[];
  ema21Arr: number[];
  ema100Arr: number[];
  adxCalcArr: number[];
  bbCalc: { basis: number[]; upper: number[]; lower: number[] };
  indicators: StrategyIndicators;
}

function getIndicatorParamsKey(params: ExtendedStocksStrategyParameters, datasetId?: string): string {
  const paramPart = [
    params.s1_rsi_len, params.s1_atr_len, params.s1_atr_ma_len, params.s1_vol_len,
    params.ma_len, params.bb2_ma_len ?? 100, params.s1_adx_len ?? 14,
    params.s1_bb_len ?? 20, params.s1_bb_mult ?? 2.2,
    params.s1_ema_fast_len ?? 9, params.s1_ema_mid_len ?? 21, params.s1_ema_trend_len ?? 50,
    params.bb2_adx_len ?? 11, params.bb2_bb_len ?? 20, params.bb2_bb_mult ?? 2.2,
  ].join('|');
  // Include dataset identity to prevent cross-symbol/train-test cache collisions
  return datasetId ? `${datasetId}::${paramPart}` : paramPart;
}

/** Build a stable dataset identity from candles (symbol + date range + count) */
export function buildDatasetId(candles: Candle[], symbol?: string, phase?: string): string {
  if (candles.length === 0) return 'empty';
  const first = candles[0].timestamp;
  const last = candles[candles.length - 1].timestamp;
  return `${symbol || 'unk'}:${phase || ''}:${candles.length}:${first}:${last}`;
}

export function precomputeIndicators(candles: Candle[], params: ExtendedStocksStrategyParameters): PrecomputedData {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const vols = candles.map(c => c.volume ?? 0);

  // FIXED: use params instead of hardcoded lengths
  const emaFastLen = params.s1_ema_fast_len ?? 9;
  const emaMidLen = params.s1_ema_mid_len ?? 21;
  const emaTrendLen = params.s1_ema_trend_len ?? 50;

  const rsiArr = calculateRSI(closes, params.s1_rsi_len);
  const atrArr = calculateATR(highs, lows, closes, params.s1_atr_len);
  const avgAtrArr = simpleSMA(atrArr, params.s1_atr_ma_len);
  const volMaArr = simpleSMA(vols, params.s1_vol_len);
  const emaTrendArr = calculateEMA(closes, emaTrendLen);
  const ema9Arr = calculateEMA(closes, emaFastLen);
  const ema21Arr = calculateEMA(closes, emaMidLen);
  const ema100Arr = calculateEMA(closes, params.bb2_ma_len ?? 100);
  const adxCalcArr = calculateADXPine(highs, lows, closes, params.s1_adx_len ?? 14);
  const bbCalc = calculateBBPine(closes, params.s1_bb_len ?? 20, params.s1_bb_mult ?? 2.2);

  // S2 BB — compute ONCE instead of 3 times
  const s2BbCalc = calculateBBPine(closes, params.bb2_bb_len ?? 20, params.bb2_bb_mult ?? 2.2);

  const indicators: StrategyIndicators = {
    rsi: rsiArr, ema9: ema9Arr, ema21: ema21Arr, ema50: emaTrendArr,
    ema100: ema100Arr, atr: atrArr, atrAvg: avgAtrArr, adx: adxCalcArr,
    bbBasis: bbCalc.basis, bbUpper: bbCalc.upper, bbLower: bbCalc.lower,
    volumeAvg: volMaArr, highs, lows,
    // S2 specific
    s2Adx: calculateADXPine(highs, lows, closes, params.bb2_adx_len ?? 11),
    s2BbBasis: s2BbCalc.basis,
    s2BbUpper: s2BbCalc.upper,
    s2BbLower: s2BbCalc.lower,
    s2Ema100: calculateEMAPine(closes, params.bb2_ma_len ?? 100),
  };

  return {
    closes, highs, lows, vols, rsiArr, atrArr, avgAtrArr, volMaArr,
    emaTrendArr, ema9Arr, ema21Arr, ema100Arr, adxCalcArr, bbCalc, indicators
  };
}

/**
 * IndicatorCacheManager — hash-based, compute once per unique indicator param set
 */
export class IndicatorCacheManager {
  private cache = new Map<string, PrecomputedData>();
  private hits = 0;
  private misses = 0;

  getOrCompute(candles: Candle[], params: ExtendedStocksStrategyParameters, datasetId?: string): PrecomputedData {
    const key = getIndicatorParamsKey(params, datasetId);
    const cached = this.cache.get(key);
    if (cached) {
      this.hits++;
      return cached;
    }
    this.misses++;
    const data = precomputeIndicators(candles, params);
    this.cache.set(key, data);
    return data;
  }

  clear() {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  get stats() {
    return { hits: this.hits, misses: this.misses, size: this.cache.size };
  }
}

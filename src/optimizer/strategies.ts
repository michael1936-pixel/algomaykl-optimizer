/**
 * 5 Entry Strategies — from server
 * Uses pre-computed rolling arrays (s3RangeHigh, s5AtrMa, etc.)
 */
import type { Candle, ExtendedStocksStrategyParameters } from './types';
import { highest, lowest } from './indicators';

export interface StrategyIndicators {
  rsi: number[];
  ema9: number[];
  ema21: number[];
  ema50: number[];
  ema100: number[];
  atr: number[];
  atrAvg: number[];
  adx: number[];
  bbBasis: number[];
  bbUpper: number[];
  bbLower: number[];
  volumeAvg: number[];
  s2Adx?: number[];
  s2BbBasis?: number[];
  s2BbUpper?: number[];
  s2BbLower?: number[];
  s2Ema100?: number[];
  highs?: number[];
  lows?: number[];
  s3RangeHigh?: number[];
  s3RangeLow?: number[];
  s5AtrMa?: number[];
  s5RangeHigh?: number[];
  s5RangeLow?: number[];
}

export interface StrategySignal {
  buySignal: boolean;
  sellSignal: boolean;
}

// ===== DIAGNOSTIC COUNTERS (temporary) =====
export const __SIG_COUNTERS = {
  s1: { buy: 0, sell: 0 },
  s2: { buy: 0, sell: 0 },
  s3: { buy: 0, sell: 0 },
  s4: { buy: 0, sell: 0 },
  s5: { buy: 0, sell: 0 },
};
export function __resetSigCounters() {
  for (const k of Object.keys(__SIG_COUNTERS) as (keyof typeof __SIG_COUNTERS)[]) {
    __SIG_COUNTERS[k].buy = 0;
    __SIG_COUNTERS[k].sell = 0;
  }
}

// ================= Strategy 1 – EMA Trend =================
export function strategy1_EMATrend(
  candles: Candle[], index: number, indicators: StrategyIndicators, params: ExtendedStocksStrategyParameters
): StrategySignal {
  // All indicator arrays are now index-aligned (full-length with NaN padding)
  if (index < 1) return { buySignal: false, sellSignal: false };

  const rsi = indicators.rsi[index];
  const e9 = indicators.ema9[index], pe9 = indicators.ema9[index - 1];
  const e21 = indicators.ema21[index], pe21 = indicators.ema21[index - 1];
  const e50 = indicators.ema50[index], pe50 = indicators.ema50[index - 1];
  const atr = indicators.atr[index], avgAtr = indicators.atrAvg[index];
  const adx = indicators.adx[index];
  const bbU = indicators.bbUpper[index], bbL = indicators.bbLower[index], bbB = indicators.bbBasis[index];
  const vol = candles[index].volume, avgVol = indicators.volumeAvg[index];

  if (isNaN(rsi) || isNaN(e9) || isNaN(pe9) || isNaN(e21) || isNaN(pe21) || isNaN(e50) || isNaN(pe50) || isNaN(atr) || isNaN(adx) || isNaN(bbU) || isNaN(bbL)) {
    return { buySignal: false, sellSignal: false };
  }
  const close = candles[index].close;

  const co21 = pe9 < pe21 && e9 > e21, co50 = pe9 < pe50 && e9 > e50;
  const cu21 = pe9 > pe21 && e9 < e21, cu50 = pe9 > pe50 && e9 < e50;

  let cnt = 0;
  if (vol > avgVol * params.s1_hi_vol_mult) cnt++;
  if (adx > params.s1_adx_strong) cnt++;
  if (atr > avgAtr * params.s1_atr_hi_mult) cnt++;
  const ft = params.s1_far_from_bb_pc / 100;
  if (close > bbB ? (bbU - close) / close > ft : (close - bbL) / close > ft) cnt++;
  const sf = cnt >= params.s1_min_conds;

  const bb = (co21 || co50) && rsi > 50;
  const bs = (cu21 || cu50) && rsi < 50;
  const buy = bb && sf && rsi > params.rsi_long_entry_min;
  const sell = bs && sf && rsi < params.rsi_short_entry_max;
  if (buy) __SIG_COUNTERS.s1.buy++;
  if (sell) __SIG_COUNTERS.s1.sell++;
  return { buySignal: buy, sellSignal: sell };
}

// ================= Strategy 2 – Bollinger Mean Reversion =================
export function strategy2_BollingerMeanReversion(
  candles: Candle[], index: number, indicators: StrategyIndicators, params: ExtendedStocksStrategyParameters
): StrategySignal {
  // F-S2-BB + F-S2-ADX: Pine S2 uses S1's global BB and global ADX (not separate s2 versions)
  const adxArr = indicators.adx;
  const bbUA = indicators.bbUpper;
  const bbLA = indicators.bbLower;
  const e100A = indicators.s2Ema100 ?? indicators.ema100;

  if (index < 1 || index >= candles.length || index >= indicators.rsi.length ||
      index >= adxArr.length || index >= bbUA.length || index >= bbLA.length) {
    return { buySignal: false, sellSignal: false };
  }

  const rsi = indicators.rsi[index], ma = e100A[index], adx = adxArr[index];
  const bbU = bbUA[index], bbL = bbLA[index], pbbU = bbUA[index - 1], pbbL = bbLA[index - 1];
  const c = candles[index].close, pc = candles[index - 1].close;
  const lo = candles[index].low, hi = candles[index].high;

  if (isNaN(rsi) || isNaN(adx) || isNaN(bbU) || isNaN(bbL) || isNaN(pbbU) || isNaN(pbbL)) {
    return { buySignal: false, sellSignal: false };
  }
  if (params.bb2_use_trend_filter && isNaN(ma)) {
    return { buySignal: false, sellSignal: false };
  }

  const re = adx < params.bb2_adx_max;
  const up = !params.bb2_use_trend_filter || c > ma;
  const dn = !params.bb2_use_trend_filter || c < ma;
  // F-S2-CROSS: Pine uses <= / >= (inclusive) for the prior-bar BB cross
  const lb = re && up && lo < bbL && pc <= pbbL && c > bbL;
  const sb = re && dn && hi > bbU && pc >= pbbU && c < bbU;

  const buy = lb && rsi <= params.bb2_rsi_long_max;
  const sell = sb && rsi >= params.bb2_rsi_short_min;
  if (buy) __SIG_COUNTERS.s2.buy++;
  if (sell) __SIG_COUNTERS.s2.sell++;
  return { buySignal: buy, sellSignal: sell };
}

// ================= Strategy 3 – Range Breakout =================
export function strategy3_RangeBreakout(
  candles: Candle[], index: number, indicators: StrategyIndicators, params: ExtendedStocksStrategyParameters
): StrategySignal {
  if (index < params.s3_breakout_len + 1) {
    return { buySignal: false, sellSignal: false };
  }

  const rsi = indicators.rsi[index], adx = indicators.adx[index];
  const vol = candles[index].volume, avgV = indicators.volumeAvg[index];

  if (isNaN(rsi) || isNaN(adx)) return { buySignal: false, sellSignal: false };
  const c = candles[index].close, pc = candles[index - 1].close;

  let rH: number, rL: number;
  if (indicators.s3RangeHigh && indicators.s3RangeLow) {
    rH = indicators.s3RangeHigh[index - 1];
    rL = indicators.s3RangeLow[index - 1];
  } else {
    const h = indicators.highs || candles.map(x => x.high);
    const l = indicators.lows || candles.map(x => x.low);
    rH = highest(h, params.s3_breakout_len, index - 1);
    rL = lowest(l, params.s3_breakout_len, index - 1);
  }

  const aOk = adx >= params.s3_adx_min;
  let vOk = true;
  if (params.s3_use_vol_filter) vOk = vol > avgV * params.s3_vol_mult;

  const buy = c > rH && pc <= rH && rsi >= params.s3_rsi_long_min && aOk && vOk;
  const sell = c < rL && pc >= rL && rsi <= params.s3_rsi_short_max && aOk && vOk;
  if (buy) __SIG_COUNTERS.s3.buy++;
  if (sell) __SIG_COUNTERS.s3.sell++;
  return { buySignal: buy, sellSignal: sell };
}

// ================= Strategy 4 – Inside Bar Breakout =================
export function strategy4_InsideBarBreakout(
  candles: Candle[], index: number, indicators: StrategyIndicators, params: ExtendedStocksStrategyParameters
): StrategySignal {
  if (index < 2) return { buySignal: false, sellSignal: false };

  const rsi = indicators.rsi[index], ema = indicators.ema50[index];
  if (isNaN(rsi) || (params.s4_use_trend_filter && isNaN(ema))) {
    return { buySignal: false, sellSignal: false };
  }

  const c = candles[index].close, pc = candles[index - 1].close;
  const pH = candles[index - 1].high, pL = candles[index - 1].low;
  const mH = candles[index - 2].high, mL = candles[index - 2].low;

  const ib = pH <= mH && pL >= mL;
  const rPc = ib ? (pH - pL) / c * 100 : 0;
  const rOk = rPc >= params.s4_min_inside_range_pc;

  let tL = true, tS = true;
  if (params.s4_use_trend_filter) { tL = c > ema; tS = c < ema; }

  const bU = c > pH && pc <= pH, bD = c < pL && pc >= pL;
  const buy = ib && rOk && bU && rsi >= params.s4_rsi_long_min && tL;
  const sell = ib && rOk && bD && rsi <= params.s4_rsi_short_max && tS;
  if (buy) __SIG_COUNTERS.s4.buy++;
  if (sell) __SIG_COUNTERS.s4.sell++;
  return { buySignal: buy, sellSignal: sell };
}

// ================= Strategy 5 – ATR Squeeze Breakout =================
export function strategy5_ATRSqueezeBreakout(
  candles: Candle[], index: number, indicators: StrategyIndicators, params: ExtendedStocksStrategyParameters
): StrategySignal {
  if (index < params.s5_range_len) {
    return { buySignal: false, sellSignal: false };
  }

  const rsi = indicators.rsi[index], atr = indicators.atr[index], avgAtr = indicators.atrAvg[index];
  const vol = candles[index].volume, avgVol = indicators.volumeAvg[index];

  if (isNaN(rsi) || isNaN(atr) || isNaN(avgAtr)) return { buySignal: false, sellSignal: false };
  const c = candles[index].close, pc = candles[index - 1].close;

  let s5m: number;
  if (indicators.s5AtrMa) {
    s5m = indicators.s5AtrMa[index];
  } else {
    if (index < params.s5_squeeze_len - 1) return { buySignal: false, sellSignal: false };
    let atrSum = 0;
    for (let j = index - params.s5_squeeze_len + 1; j <= index; j++) atrSum += indicators.atr[j];
    s5m = atrSum / params.s5_squeeze_len;
  }

  const th = avgAtr * params.s5_atr_mult_low;
  const sq = atr < th && s5m < th;

  let rH: number, rL: number;
  if (indicators.s5RangeHigh && indicators.s5RangeLow) {
    rH = indicators.s5RangeHigh[index - 1];
    rL = indicators.s5RangeLow[index - 1];
  } else {
    const h = indicators.highs || candles.map(x => x.high);
    const l = indicators.lows || candles.map(x => x.low);
    rH = highest(h, params.s5_range_len, index - 1);
    rL = lowest(l, params.s5_range_len, index - 1);
  }

  let vOk = true;
  if (params.s5_use_vol_filter) vOk = vol > avgVol * params.s5_vol_mult;

  const buy = sq && c > rH && pc <= rH && rsi >= params.s5_rsi_long_min && vOk;
  const sell = sq && c < rL && pc >= rL && rsi <= params.s5_rsi_short_max && vOk;
  if (buy) __SIG_COUNTERS.s5.buy++;
  if (sell) __SIG_COUNTERS.s5.sell++;
  return { buySignal: buy, sellSignal: sell };
}

export function resetS5DebugCounter() {}

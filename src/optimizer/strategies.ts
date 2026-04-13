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

// ================= Strategy 1 – EMA Trend =================
export function strategy1_EMATrend(
  candles: Candle[], index: number, indicators: StrategyIndicators, params: ExtendedStocksStrategyParameters
): StrategySignal {
  const rsiIdx = index - (candles.length - indicators.rsi.length);
  const ema9Idx = index - (candles.length - indicators.ema9.length);
  const ema21Idx = index - (candles.length - indicators.ema21.length);
  const ema50Idx = index - (candles.length - indicators.ema50.length);
  const atrIdx = index - (candles.length - indicators.atr.length);
  const adxIdx = index - (candles.length - indicators.adx.length);
  const bbIdx = index - (candles.length - indicators.bbBasis.length);
  const volIdx = index - (candles.length - indicators.volumeAvg.length);

  if (rsiIdx < 0 || ema9Idx < 1 || ema21Idx < 1 || ema50Idx < 1 || atrIdx < 0 || adxIdx < 0 || bbIdx < 0 || volIdx < 0) {
    return { buySignal: false, sellSignal: false };
  }

  const rsi = indicators.rsi[rsiIdx];
  const e9 = indicators.ema9[ema9Idx], pe9 = indicators.ema9[ema9Idx - 1];
  const e21 = indicators.ema21[ema21Idx], pe21 = indicators.ema21[ema21Idx - 1];
  const e50 = indicators.ema50[ema50Idx], pe50 = indicators.ema50[ema50Idx - 1];
  const atr = indicators.atr[atrIdx], avgAtr = indicators.atrAvg[atrIdx];
  const adx = indicators.adx[adxIdx];
  const bbU = indicators.bbUpper[bbIdx], bbL = indicators.bbLower[bbIdx], bbB = indicators.bbBasis[bbIdx];
  const vol = candles[index].volume, avgVol = indicators.volumeAvg[volIdx];
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
  return {
    buySignal: bb && sf && rsi > params.rsi_long_entry_min,
    sellSignal: bs && sf && rsi < params.rsi_short_entry_max
  };
}

// ================= Strategy 2 – Bollinger Mean Reversion =================
export function strategy2_BollingerMeanReversion(
  candles: Candle[], index: number, indicators: StrategyIndicators, params: ExtendedStocksStrategyParameters
): StrategySignal {
  const adxArr = indicators.s2Adx ?? indicators.adx;
  const bbUA = indicators.s2BbUpper ?? indicators.bbUpper;
  const bbLA = indicators.s2BbLower ?? indicators.bbLower;
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
  const lb = re && up && lo < bbL && pc < pbbL && c > bbL;
  const sb = re && dn && hi > bbU && pc > pbbU && c < bbU;

  return {
    buySignal: lb && rsi <= params.bb2_rsi_long_max,
    sellSignal: sb && rsi >= params.bb2_rsi_short_min
  };
}

// ================= Strategy 3 – Range Breakout =================
export function strategy3_RangeBreakout(
  candles: Candle[], index: number, indicators: StrategyIndicators, params: ExtendedStocksStrategyParameters
): StrategySignal {
  const ri = index - (candles.length - indicators.rsi.length);
  const ai = index - (candles.length - indicators.adx.length);
  const vi = index - (candles.length - indicators.volumeAvg.length);

  if (ri < 0 || ai < 0 || vi < 0 || index < params.s3_breakout_len + 1) {
    return { buySignal: false, sellSignal: false };
  }

  const rsi = indicators.rsi[ri], adx = indicators.adx[ai];
  const vol = candles[index].volume, avgV = indicators.volumeAvg[vi];
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

  return {
    buySignal: c > rH && pc <= rH && rsi >= params.s3_rsi_long_min && aOk && vOk,
    sellSignal: c < rL && pc >= rL && rsi <= params.s3_rsi_short_max && aOk && vOk
  };
}

// ================= Strategy 4 – Inside Bar Breakout =================
export function strategy4_InsideBarBreakout(
  candles: Candle[], index: number, indicators: StrategyIndicators, params: ExtendedStocksStrategyParameters
): StrategySignal {
  const ri = index - (candles.length - indicators.rsi.length);
  const ei = index - (candles.length - indicators.ema50.length);

  if (ri < 0 || ei < 0 || index < 2) return { buySignal: false, sellSignal: false };

  const rsi = indicators.rsi[ri], ema = indicators.ema50[ei];
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
  return {
    buySignal: ib && rOk && bU && rsi >= params.s4_rsi_long_min && tL,
    sellSignal: ib && rOk && bD && rsi <= params.s4_rsi_short_max && tS
  };
}

// ================= Strategy 5 – ATR Squeeze Breakout =================
export function strategy5_ATRSqueezeBreakout(
  candles: Candle[], index: number, indicators: StrategyIndicators, params: ExtendedStocksStrategyParameters
): StrategySignal {
  const ri = index - (candles.length - indicators.rsi.length);
  const ai = index - (candles.length - indicators.atr.length);
  const vi = index - (candles.length - indicators.volumeAvg.length);

  if (ri < 0 || ai < 0 || vi < 0 || index < params.s5_range_len + 1) {
    return { buySignal: false, sellSignal: false };
  }

  const rsi = indicators.rsi[ri], atr = indicators.atr[ai], avgAtr = indicators.atrAvg[ai];
  const vol = candles[index].volume, avgVol = indicators.volumeAvg[vi];
  const c = candles[index].close, pc = candles[index - 1].close;

  let s5m: number;
  if (indicators.s5AtrMa) {
    s5m = indicators.s5AtrMa[ai];
  } else {
    if (ai < params.s5_squeeze_len - 1) return { buySignal: false, sellSignal: false };
    s5m = indicators.atr.slice(ai - params.s5_squeeze_len + 1, ai + 1).reduce((a, b) => a + b, 0) / params.s5_squeeze_len;
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
  if (params.s5_use_vol_filter) {
    if (vol === 0 || !avgVol || avgVol === 0) vOk = true;
    else vOk = vol > avgVol * params.s5_vol_mult;
  }

  return {
    buySignal: sq && c > rH && pc <= rH && rsi >= params.s5_rsi_long_min && vOk,
    sellSignal: sq && c < rL && pc >= rL && rsi <= params.s5_rsi_short_max && vOk
  };
}

export function resetS5DebugCounter() {}

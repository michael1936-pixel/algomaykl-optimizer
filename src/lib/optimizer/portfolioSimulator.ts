/**
 * SimulatorV2 — Full backtest engine from server
 * Commission model: max(1¢/share, $2.50) + slippage + overnight fees
 * Trade management: TP stepping, RSI trailing, breakeven, non-regress stop
 */
import type { Candle, ExtendedStocksStrategyParameters, BacktestResult, Trade, PortfolioBacktestResult, MonthlyPerformance, SymbolData, PeriodSplit } from './types';
import { StrategyIndicators, strategy1_EMATrend, strategy2_BollingerMeanReversion, strategy3_RangeBreakout, strategy4_InsideBarBreakout, strategy5_ATRSqueezeBreakout } from './strategies';
import { IndicatorCacheManager, PrecomputedData, rollingHighest, rollingLowest } from './indicatorCache';

// ---- Simulation Config ----
interface SimulationConfig {
  capital_start: number;
  enable_commissions: boolean;
  commission_per_share_cent: number;
  min_commission_side_usd: number;
  slippage_pct_side: number;
  leverage_mode: string;
  leverage: number;
  enable_overnight_fee: boolean;
  overnight_fee_pct: number;
}

const DEFAULT_CONFIG: SimulationConfig = {
  capital_start: 10000,
  enable_commissions: true,
  commission_per_share_cent: 1.0,
  min_commission_side_usd: 2.5,
  slippage_pct_side: 0.10,
  leverage_mode: 'ללא מינוף',
  leverage: 1,
  enable_overnight_fee: true,
  overnight_fee_pct: 0.0393,
};

function calculateCommission(qty: number, cfg: SimulationConfig): number {
  if (!cfg.enable_commissions) return 0;
  return Math.max((qty * cfg.commission_per_share_cent) / 100, cfg.min_commission_side_usd);
}

function getRoundTripCost(capital: number, entryPrice: number, qty: number, cfg: SimulationConfig) {
  const commEntry = calculateCommission(qty, cfg);
  const commExit = calculateCommission(qty, cfg);
  const slippageEntry = (capital * cfg.slippage_pct_side) / 100;
  const slippageExit = (capital * cfg.slippage_pct_side) / 100;
  const totalCostUsd = commEntry + commExit + slippageEntry + slippageExit;
  const totalCostPct = totalCostUsd / capital;
  return { totalCostUsd, totalCostPct, commEntry, commExit, slippageEntry, slippageExit };
}

function calculateOvernightFee(position: number, nights: number, notional: number, isLev: boolean, cfg: SimulationConfig): number {
  if (!cfg.enable_overnight_fee || !isLev || nights <= 0) return 0;
  return notional * (cfg.overnight_fee_pct / 100) * nights;
}

function qtyFrom(capital: number, price: number, levMult: number): number {
  return Math.floor((capital * levMult) / price);
}

function calculateInitialStopLong(entryPrice: number, entryOpenPrice: number, currentATR: number, use_atr_sl: boolean, eff_sl_pct: number, eff_atr_mult: number) {
  const baseSlPc = eff_sl_pct / 100;
  let slPc = baseSlPc;
  if (use_atr_sl && currentATR > 0) {
    const atrStopPc = (currentATR / entryPrice) * eff_atr_mult;
    slPc = Math.max(baseSlPc, atrStopPc);
  }
  const initialStop = entryOpenPrice * (1 - slPc);
  return { slPcEntry: slPc, initialStop, baseSl: initialStop };
}

function calculateInitialStopShort(entryPrice: number, entryOpenPrice: number, currentATR: number, use_atr_sl: boolean, eff_sl_pct: number, eff_atr_mult: number) {
  const baseSlPc = eff_sl_pct / 100;
  let slPc = baseSlPc;
  if (use_atr_sl && currentATR > 0) {
    const atrStopPc = (currentATR / entryPrice) * eff_atr_mult;
    slPc = Math.max(baseSlPc, atrStopPc);
  }
  const initialStop = entryOpenPrice * (1 + slPc);
  return { slPcEntry: slPc, initialStop, baseSl: initialStop };
}

function checkBreakevenLong(beActive: boolean, high: number, entry: number, pct: number): boolean {
  if (beActive) return true;
  return high >= entry + entry * (pct / 100);
}

function checkBreakevenShort(beActive: boolean, low: number, entry: number, pct: number): boolean {
  if (beActive) return true;
  return low <= entry - entry * (pct / 100);
}

function getStopExecPriceLong(stopAtOpen: number | null, trail: number | null, prefTp: boolean, prevHit: boolean, afterHit: boolean): number | null {
  if (prefTp && afterHit && trail !== null) return trail;
  if (prevHit && stopAtOpen !== null) return stopAtOpen;
  return stopAtOpen ?? trail ?? null;
}

function getStopExecPriceShort(stopAtOpen: number | null, trail: number | null, prefTp: boolean, prevHit: boolean, afterHit: boolean): number | null {
  if (prefTp && afterHit && trail !== null) return trail;
  if (prevHit && stopAtOpen !== null) return stopAtOpen;
  return stopAtOpen ?? trail ?? null;
}

/**
 * Cache for derived indicators (S3/S5 rolling arrays) — avoids recomputation per combination
 * Key: datasetId + s3_breakout_len + s5_range_len + s5_squeeze_len + enable flags
 */
const derivedCache = new Map<string, StrategyIndicators>();

function getDerivedKey(datasetId: string, params: ExtendedStocksStrategyParameters): string {
  return `${datasetId}|${params.enable_strat3 ? params.s3_breakout_len : 0}|${params.enable_strat5 ? params.s5_range_len : 0}|${params.enable_strat5 ? params.s5_squeeze_len : 0}`;
}

/**
 * Build indicators from precomputed data, adding rolling arrays for S3/S5
 * Uses derived cache to avoid recomputing rolling arrays — no eviction
 */
export function buildIndicatorsFromPrecomputed(precomputed: PrecomputedData, params: ExtendedStocksStrategyParameters, datasetId?: string): StrategyIndicators {
  if (datasetId) {
    const dKey = getDerivedKey(datasetId, params);
    const cached = derivedCache.get(dKey);
    if (cached) return cached;
  }

  const ind = { ...precomputed.indicators };
  if (params.enable_strat3 && params.s3_breakout_len > 0) {
    ind.s3RangeHigh = rollingHighest(precomputed.highs, params.s3_breakout_len);
    ind.s3RangeLow = rollingLowest(precomputed.lows, params.s3_breakout_len);
  }
  if (params.enable_strat5) {
    if (params.s5_range_len > 0) {
      ind.s5RangeHigh = rollingHighest(precomputed.highs, params.s5_range_len);
      ind.s5RangeLow = rollingLowest(precomputed.lows, params.s5_range_len);
    }
    const atrSma = new Array(precomputed.atrArr.length).fill(NaN);
    const sqLen = params.s5_squeeze_len;
    if (sqLen > 0) {
      let sum = 0;
      for (let i = 0; i < precomputed.atrArr.length; i++) {
        sum += precomputed.atrArr[i];
        if (i >= sqLen) sum -= precomputed.atrArr[i - sqLen];
        if (i >= sqLen - 1) atrSma[i] = sum / sqLen;
      }
    }
    ind.s5AtrMa = atrSma;
  }

  if (datasetId) {
    const dKey = getDerivedKey(datasetId, params);
    derivedCache.set(dKey, ind);
  }

  return ind;
}

/**
 * Run full backtest — server-identical logic with commissions/TP stepping/RSI trailing
 */
export function runBacktest(
  candles: Candle[],
  params: ExtendedStocksStrategyParameters,
  indicators: StrategyIndicators,
  cfg: SimulationConfig = DEFAULT_CONFIG,
): BacktestResult {
  if (candles.length < 100) return emptyResult(params, cfg.capital_start);

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const rsiArr = indicators.rsi;
  const atrArr = indicators.atr;
  const emaTrendArr = indicators.ema50;
  const ema9Arr = indicators.ema9;
  const ema21Arr = indicators.ema21;

  const s1Min = Math.max(params.s1_ema_trend_len, params.s1_rsi_len, params.s1_atr_len, params.s1_adx_len, params.s1_bb_len) + 5;
  const s2Min = Math.max(params.bb2_bb_len ?? 20, params.bb2_adx_len ?? 11, params.bb2_ma_len ?? 100) + 5;
  const s3Min = (params.s3_breakout_len ?? 10) + 5;
  const s4Min = 5;
  const s5Min = Math.max(params.s5_squeeze_len ?? 1, params.s5_range_len ?? 10) + 5;
  const startBar = Math.max(s1Min, s2Min, s3Min, s4Min, s5Min);

  const startCap = cfg.capital_start;
  const levMult = cfg.leverage_mode !== 'ללא מינוף' ? cfg.leverage : 1;
  const isLev = levMult > 1;

  let capital = startCap;
  let peak = startCap;
  let maxDD = 0;
  let totalFees = 0;
  const trades: Trade[] = [];
  let tradeCount = 0;

  let position = 0;
  let entryPrice: number | null = null;
  let entryOpenPrice: number | null = null;
  let entryQty = 0;
  let entryNotional = 0;
  let entryBarIdx = 0;
  let lastEntryBar = -999;
  let entrySid: number | null = null;
  let barsInTrade = 0;
  let currentTrade: Trade | null = null;

  let trailStop: number | null = null;
  let stopAtBarOpen: number | null = null;
  let baseSL: number | null = null;
  let baseSS: number | null = null;
  let beActive = false;
  let tpSteps = 0;
  let trOnlyL: number | null = null;
  let trOnlyS: number | null = null;
  let stepStopL: number | null = null;
  let stepStopS: number | null = null;

  let prevTrailStop: number | null = null;
  let prevPos = 0;

  for (let i = startBar; i < candles.length; i++) {
    const histStopAtOpen = stopAtBarOpen;
    const isFlat = position === 0;
    const spacingOk = i - lastEntryBar >= params.bars_between_trades;
    const canFlipL = params.allow_flip_S2L && position === -1;
    const canFlipS = params.allow_flip_L2S && position === 1;

    const c = candles[i];
    const cl = closes[i], hi = highs[i], lo = lows[i], op = c.open;
    const rsi = rsiArr[i];
    const atr = !isNaN(atrArr[i]) ? atrArr[i] : 0;
    const ema50 = !isNaN(emaTrendArr[i]) ? emaTrendArr[i] : (i > 0 ? emaTrendArr[i - 1] : NaN);

    let barOk = true;
    if (atr > 0 && params.use_big_bar_filter) {
      barOk = !((hi - lo) > atr * params.big_bar_atr_mult);
    }
    let distOk = true;
    if (params.use_dist_filter && ema50 > 0 && !isNaN(ema50)) {
      distOk = Math.abs((cl - ema50) / ema50) * 100 <= params.max_dist_from_ema50_pc;
    }

    let bS1 = false, sS1 = false, bS2 = false, sS2 = false, bS3 = false, sS3 = false, bS4 = false, sS4 = false, bS5 = false, sS5 = false;
    const simOk = c.timestamp >= (params.simulationStartDate?.getTime() ?? 0);

    if (params.enable_strat1 && i >= s1Min) {
      const s = strategy1_EMATrend(candles, i, indicators, params);
      bS1 = simOk && s.buySignal && barOk && distOk && position !== 1 && ((isFlat && spacingOk) || canFlipL);
      sS1 = simOk && s.sellSignal && barOk && distOk && position !== -1 && ((isFlat && spacingOk) || canFlipS);
    }
    if (params.enable_strat2 && i >= s2Min) {
      const s = strategy2_BollingerMeanReversion(candles, i, indicators, params);
      bS2 = simOk && s.buySignal && position !== 1 && ((isFlat && spacingOk) || canFlipL);
      sS2 = simOk && s.sellSignal && position !== -1 && ((isFlat && spacingOk) || canFlipS);
    }
    if (params.enable_strat3 && i >= s3Min) {
      const s = strategy3_RangeBreakout(candles, i, indicators, params);
      bS3 = simOk && s.buySignal && position !== 1 && ((isFlat && spacingOk) || canFlipL);
      sS3 = simOk && s.sellSignal && position !== -1 && ((isFlat && spacingOk) || canFlipS);
    }
    if (params.enable_strat4 && i >= s4Min) {
      const s = strategy4_InsideBarBreakout(candles, i, indicators, params);
      bS4 = simOk && s.buySignal && position !== 1 && ((isFlat && spacingOk) || canFlipL);
      sS4 = simOk && s.sellSignal && position !== -1 && ((isFlat && spacingOk) || canFlipS);
    }
    if (params.enable_strat5 && i >= s5Min) {
      const s = strategy5_ATRSqueezeBreakout(candles, i, indicators, params);
      bS5 = simOk && s.buySignal && position !== 1 && ((isFlat && spacingOk) || canFlipL);
      sS5 = simOk && s.sellSignal && position !== -1 && ((isFlat && spacingOk) || canFlipS);
    }

    if (!barOk || !distOk) {
      bS1 = bS2 = bS3 = bS4 = bS5 = false;
      sS1 = sS2 = sS3 = sS4 = sS5 = false;
    }
    let buy = bS1 || bS2 || bS3 || bS4 || bS5;
    let sell = sS1 || sS2 || sS3 || sS4 || sS5;
    if (buy && sell) sell = false; // Tie-break: long priority

    // RSI Exit
    let exitL = false, exitS = false;
    const prevRSI = i > 0 && !isNaN(rsiArr[i - 1]) ? rsiArr[i - 1] : rsi;
    if (params.enable_rsi_exit && position === 1 && barsInTrade >= params.min_bars_in_trade_exit) {
      const e9 = ema9Arr[i], e21 = ema21Arr[i];
      exitL = !isNaN(e9) && !isNaN(e21) && e9 < e21 && prevRSI > params.rsi_exit_long && rsi < params.rsi_exit_long;
    }
    if (params.enable_rsi_exit && position === -1 && barsInTrade >= params.min_bars_in_trade_exit) {
      const e9 = ema9Arr[i], e21 = ema21Arr[i];
      exitS = !isNaN(e9) && !isNaN(e21) && e9 > e21 && prevRSI < params.rsi_exit_short && rsi > params.rsi_exit_short;
    }

    // Entry (flat)
    if (!currentTrade && position === 0) {
      if (buy) {
        entrySid = bS1 ? 1 : bS2 ? 2 : bS3 ? 3 : bS4 ? 4 : bS5 ? 5 : 0;
        const ep = cl, eop = op, pc = capital;
        const qty = qtyFrom(pc, ep, levMult);
        entryQty = qty; entryPrice = ep; entryOpenPrice = eop;
        entryNotional = qty * ep; entryBarIdx = i; lastEntryBar = i;
        position = 1;
        currentTrade = { entryTime: c.timestamp, entryPrice: ep, type: 'long', capitalAtEntry: pc, entryBarIndex: i, entryStrategyId: entrySid };
        trailStop = null; stopAtBarOpen = null; barsInTrade = 0;
        tpSteps = 0; beActive = false; trOnlyL = null; stepStopL = null;
      } else if (sell) {
        entrySid = sS1 ? 1 : sS2 ? 2 : sS3 ? 3 : sS4 ? 4 : sS5 ? 5 : 0;
        const ep = cl, eop = op, pc = capital;
        const qty = qtyFrom(pc, ep, levMult);
        entryQty = qty; entryPrice = ep; entryOpenPrice = eop;
        entryNotional = qty * ep; entryBarIdx = i; lastEntryBar = i;
        position = -1;
        currentTrade = { entryTime: c.timestamp, entryPrice: ep, type: 'short', capitalAtEntry: pc, entryBarIndex: i, entryStrategyId: entrySid };
        trailStop = null; stopAtBarOpen = null; barsInTrade = 0;
        tpSteps = 0; beActive = false; trOnlyS = null; stepStopS = null;
      }
    }
    if (position !== 0) barsInTrade++;

    // Trade management
    if (currentTrade && entryPrice !== null) {
      if (!currentTrade.highestPrice) currentTrade.highestPrice = entryPrice;
      if (!currentTrade.lowestPrice) currentTrade.lowestPrice = entryPrice;
      currentTrade.highestPrice = Math.max(currentTrade.highestPrice, hi);
      currentTrade.lowestPrice = Math.min(currentTrade.lowestPrice, lo);

      const exitTrade = (reason: Trade['exitReason'], xp: number, dir: number) => {
        const pc = capital, nights = i - entryBarIdx;
        const qty = entryQty > 0 ? entryQty : qtyFrom(pc, entryPrice!, levMult);
        const pnlG = (xp - entryPrice!) * qty * dir, gpct = pnlG / pc;
        const costs = getRoundTripCost(pc, entryPrice!, qty, cfg);
        const onFee = calculateOvernightFee(position, nights, entryNotional, isLev, cfg);
        const onPct = onFee / pc;
        const net = gpct - costs.totalCostPct - onPct;
        capital = pc * (1 + net);
        totalFees += costs.totalCostUsd + onFee;
        currentTrade!.exitTime = c.timestamp;
        currentTrade!.exitPrice = xp;
        currentTrade!.exitReason = reason;
        currentTrade!.exitBarIndex = i;
        currentTrade!.pnlPct = net * 100;
        currentTrade!.pnl = pc * net;
        trades.push(currentTrade!);
        tradeCount++;
        if (capital > peak) peak = capital;
        const dd = ((peak - capital) / peak) * 100;
        if (dd > maxDD) maxDD = dd;
        currentTrade = null; position = 0; entryPrice = null; entryQty = 0; entryNotional = 0;
        trailStop = null; trOnlyL = null; trOnlyS = null; stepStopL = null; stepStopS = null;
        beActive = false; barsInTrade = 0; tpSteps = 0; stopAtBarOpen = null;
        baseSL = null; baseSS = null; entrySid = null;
      };

      if (position === 1) {
        const bePct = params.be_trigger_pct_long;
        const trPct = params.trail_rsi_pct_input_long / 100;
        const rsiThr = params.rsi_trail_long;
        const isEntry = barsInTrade === 1;
        if (trailStop === null && isEntry) {
          const r = calculateInitialStopLong(entryPrice, entryOpenPrice ?? entryPrice, atr, params.use_atr_sl, params.stop_distance_percent_long, params.atr_mult_long);
          baseSL = r.baseSl; trailStop = r.initialStop;
        }
        const tpPct = params.tp_percent_long / 100;
        const tpTrailDist = params.tp_trail_distance_long;
        const stepsCrossed = tpPct > 0 ? Math.max(0, Math.floor((hi / entryPrice - 1) / tpPct)) : 0;
        const opened = position === 1 && prevPos !== 1;
        stopAtBarOpen = opened ? (baseSL ?? (entryPrice * 0.95)) : (prevTrailStop ?? trailStop ?? baseSL ?? (entryPrice * 0.95));

        if (!beActive) beActive = checkBreakevenLong(beActive, hi, entryPrice, bePct);
        if (rsi >= rsiThr) {
          const tc = currentTrade.highestPrice! * (1 - trPct);
          trOnlyL = Math.max(trOnlyL ?? (baseSL ?? entryPrice * 0.94), tc);
          if (trOnlyL >= entryPrice) trOnlyL = Math.max(trOnlyL, entryPrice);
        }
        let tpR = false;
        if (stepsCrossed > tpSteps) {
          tpR = true; tpSteps = stepsCrossed;
          stepStopL = entryPrice * (1 + tpPct * tpSteps) * (1 - tpTrailDist / 100);
        }
        let pf: number = trailStop ?? stopAtBarOpen ?? (baseSL ?? entryPrice * 0.98);
        let fs: number = pf;
        if (rsi >= rsiThr && trOnlyL !== null) fs = Math.max(fs, trOnlyL);
        else if (tpR && stepStopL !== null) fs = Math.max(fs, stepStopL);
        if (beActive || pf >= entryPrice) fs = Math.max(fs, entryPrice);
        if (params.non_regress_stop) fs = Math.max(fs, pf);
        trailStop = fs;

        const spCheck = histStopAtOpen ?? stopAtBarOpen;
        const sPrev = spCheck !== null && lo <= spCheck;
        const sAfter = trailStop !== null && lo <= trailStop;
        const stopHit = opened ? false : (params.prefer_tp_priority ? (sPrev || sAfter) : sPrev);

        let shouldExit = false, xReason: Trade['exitReason'] = 'signal', xPrice = cl;
        if (params.allow_flip_L2S && sell) { shouldExit = true; xReason = 'flip'; xPrice = cl; }
        else if (stopHit) { shouldExit = true; xReason = 'stop_loss'; xPrice = getStopExecPriceLong(spCheck, trailStop, params.prefer_tp_priority, sPrev, sAfter) ?? cl; }
        else if (exitL) { shouldExit = true; xReason = 'signal'; xPrice = cl; }

        if (shouldExit) {
          exitTrade(xReason, xPrice, 1);
          if (xReason === 'flip') {
            entrySid = sS2 ? 2 : sS1 ? 1 : sS3 ? 3 : sS4 ? 4 : sS5 ? 5 : 0;
            const ep = cl, pc = capital, qty = qtyFrom(pc, ep, levMult);
            entryQty = qty; entryPrice = ep; entryOpenPrice = op; entryNotional = qty * ep;
            entryBarIdx = i; lastEntryBar = i; position = -1;
            currentTrade = { entryTime: c.timestamp, entryPrice: ep, type: 'short', capitalAtEntry: pc, entryBarIndex: i, entryStrategyId: entrySid ?? 0 };
            barsInTrade = 1; tpSteps = 0;
            const r = calculateInitialStopShort(ep, op, atr, params.use_atr_sl, params.stop_distance_percent_short, params.atr_mult_short);
            baseSS = r.baseSl; trailStop = r.initialStop; stopAtBarOpen = baseSS;
            if (!currentTrade.lowestPrice) currentTrade.lowestPrice = ep;
            if (!currentTrade.highestPrice) currentTrade.highestPrice = ep;
            currentTrade.lowestPrice = Math.min(currentTrade.lowestPrice, lo);
            currentTrade.highestPrice = Math.max(currentTrade.highestPrice, hi);
          }
        }
      } else if (position === -1) {
        const bePct = params.be_trigger_pct_short;
        const trPct = params.trail_rsi_pct_input_short / 100;
        const rsiThr = params.rsi_trail_short;
        const isEntry = barsInTrade === 1;
        if (trailStop === null && isEntry) {
          const r = calculateInitialStopShort(entryPrice, entryOpenPrice ?? entryPrice, atr, params.use_atr_sl, params.stop_distance_percent_short, params.atr_mult_short);
          baseSS = r.baseSl; trailStop = r.initialStop;
        }
        const tpPct = params.tp_percent_short / 100;
        const tpTrailDist = params.tp_trail_distance_short;
        const stepsCrossed = tpPct > 0 ? Math.max(0, Math.floor((1 - lo / entryPrice) / tpPct)) : 0;
        const opened = position === -1 && prevPos !== -1;
        stopAtBarOpen = opened ? (baseSS ?? (entryPrice * 1.05)) : (prevTrailStop ?? trailStop ?? baseSS ?? (entryPrice * 1.05));

        if (!beActive) beActive = checkBreakevenShort(beActive, lo, entryPrice, bePct);
        if (rsi <= rsiThr) {
          const tc = currentTrade.lowestPrice! * (1 + trPct);
          trOnlyS = Math.min(trOnlyS ?? (baseSS ?? entryPrice * 1.06), tc);
          if (trOnlyS !== null && trOnlyS <= entryPrice) trOnlyS = Math.min(trOnlyS, entryPrice);
        }
        let tpR = false;
        if (stepsCrossed > tpSteps) {
          tpR = true; tpSteps = stepsCrossed;
          stepStopS = entryPrice * (1 - tpPct * tpSteps) * (1 + tpTrailDist / 100);
        }
        let pf = trailStop ?? stopAtBarOpen ?? (baseSS ?? entryPrice * 1.02);
        let fs: number;
        if (rsi <= rsiThr && trOnlyS !== null) fs = trOnlyS;
        else if (tpR && stepStopS !== null) fs = stepStopS;
        else fs = pf;
        if (beActive || pf <= entryPrice) fs = Math.max(fs, entryPrice);
        if (params.non_regress_stop) fs = Math.min(fs, pf);
        trailStop = fs;

        const spCheck = histStopAtOpen ?? stopAtBarOpen;
        const sPrev = spCheck !== null && hi >= spCheck;
        const sAfter = trailStop !== null && hi >= trailStop;
        const stopHit = opened ? false : (params.prefer_tp_priority ? (sPrev || sAfter) : sPrev);

        let shouldExit = false, xReason: Trade['exitReason'] = 'signal', xPrice = cl;
        if (params.allow_flip_S2L && buy) { shouldExit = true; xReason = 'flip'; xPrice = cl; }
        else if (stopHit) { shouldExit = true; xReason = 'stop_loss'; xPrice = getStopExecPriceShort(spCheck, trailStop, params.prefer_tp_priority, sPrev, sAfter) ?? cl; }
        else if (exitS) { shouldExit = true; xReason = 'signal'; xPrice = cl; }

        if (shouldExit) {
          exitTrade(xReason, xPrice, -1);
          if (xReason === 'flip') {
            entrySid = bS2 ? 2 : bS1 ? 1 : bS3 ? 3 : bS4 ? 4 : bS5 ? 5 : 0;
            const ep = cl, pc = capital, qty = qtyFrom(pc, ep, levMult);
            entryQty = qty; entryPrice = ep; entryOpenPrice = op; entryNotional = qty * ep;
            entryBarIdx = i; lastEntryBar = i; position = 1;
            currentTrade = { entryTime: c.timestamp, entryPrice: ep, type: 'long', capitalAtEntry: pc, entryBarIndex: i, entryStrategyId: entrySid ?? 0 };
            barsInTrade = 1; tpSteps = 0;
            const r = calculateInitialStopLong(ep, op, atr, params.use_atr_sl, params.stop_distance_percent_long, params.atr_mult_long);
            baseSL = r.baseSl; trailStop = r.initialStop; stopAtBarOpen = baseSL;
            if (!currentTrade.lowestPrice) currentTrade.lowestPrice = ep;
            if (!currentTrade.highestPrice) currentTrade.highestPrice = ep;
            currentTrade.highestPrice = Math.max(currentTrade.highestPrice, hi);
            currentTrade.lowestPrice = Math.min(currentTrade.lowestPrice, lo);
          }
        }
      }
    }
    prevTrailStop = trailStop;
    prevPos = position;
  }

  // Close open trade at end of data
  if (currentTrade && entryPrice !== null) {
    const lc = candles[candles.length - 1], xp = lc.close, dir = position === 1 ? 1 : -1;
    const pc = capital, qty = entryQty > 0 ? entryQty : qtyFrom(pc, entryPrice, levMult);
    const pnlG = (xp - entryPrice) * qty * dir, gpct = pnlG / pc;
    const costs = getRoundTripCost(pc, entryPrice, qty, cfg);
    const onFee = calculateOvernightFee(position, candles.length - 1 - entryBarIdx, entryNotional, isLev, cfg);
    const net = gpct - costs.totalCostPct - onFee / pc;
    capital = pc * (1 + net);
    totalFees += costs.totalCostUsd + onFee;
    currentTrade.exitTime = lc.timestamp; currentTrade.exitPrice = xp; currentTrade.exitReason = 'end_of_data';
    currentTrade.exitBarIndex = candles.length - 1; currentTrade.pnlPct = net * 100; currentTrade.pnl = pc * net;
    trades.push(currentTrade);
  }

  // Calc stats
  const wins = trades.filter(t => (t.pnlPct ?? 0) > 0);
  const losses = trades.filter(t => (t.pnlPct ?? 0) <= 0);
  const wr = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
  const avgW = wins.length > 0 ? wins.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / wins.length : 0;
  const avgL = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / losses.length) : 0;
  const gP = wins.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const gL = Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0));
  const pf = gL > 0 ? gP / gL : gP > 0 ? Infinity : 0;
  const tr = ((capital - startCap) / startCap) * 100;
  const avgR = trades.length > 0 ? trades.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / trades.length : 0;
  const stdD = trades.length > 0 ? Math.sqrt(trades.reduce((s, t) => s + Math.pow((t.pnlPct ?? 0) - avgR, 2), 0) / trades.length) : 0;
  const sr = stdD > 0 && trades.length > 0 ? (avgR / stdD) * Math.sqrt(trades.length) : 0;

  return {
    parameters: params, totalReturn: tr, finalCapital: capital, winRate: wr,
    totalTrades: trades.length, longTrades: trades.filter(t => t.type === 'long').length,
    shortTrades: trades.filter(t => t.type === 'short').length,
    winningTrades: wins.length, losingTrades: losses.length,
    sharpeRatio: sr, maxDrawdown: maxDD, profitFactor: pf, avgWin: avgW, avgLoss: avgL,
    totalFeesUsd: totalFees, trades,
  };
}

function emptyResult(params: ExtendedStocksStrategyParameters, capital: number): BacktestResult {
  return {
    parameters: params, totalReturn: 0, finalCapital: capital, winRate: 0,
    totalTrades: 0, longTrades: 0, shortTrades: 0, winningTrades: 0, losingTrades: 0,
    sharpeRatio: 0, maxDrawdown: 0, profitFactor: 0, avgWin: 0, avgLoss: 0, totalFeesUsd: 0, trades: [],
  };
}

// ---- Pre-filter symbols (compute once per optimization run) ----
export interface PreFilteredSymbolData {
  symbol: string;
  trainCandles: Candle[];
  testCandles: Candle[];
}

export function preFilterSymbols(symbolsData: SymbolData[], periodSplit: PeriodSplit): PreFilteredSymbolData[] {
  const trainStart = periodSplit.trainStartDate.getTime();
  const trainEnd = periodSplit.trainEndDate.getTime();
  const testStart = periodSplit.testStartDate.getTime();
  const testEnd = periodSplit.testEndDate.getTime();

  return symbolsData.map(sd => {
    const trainCandles: Candle[] = [];
    const testCandles: Candle[] = [];
    for (const c of sd.candles) {
      const t = typeof c.timestamp === 'number' ? c.timestamp : new Date(c.timestamp).getTime();
      if (t >= trainStart && t <= trainEnd) trainCandles.push(c);
      if (t >= testStart && t <= testEnd) testCandles.push(c);
    }
    return { symbol: sd.symbol, trainCandles, testCandles };
  });
}

// ---- Portfolio backtest with indicator cache ----
export function runPortfolioBacktest(
  symbolsData: SymbolData[],
  params: ExtendedStocksStrategyParameters,
  periodSplit: PeriodSplit,
  _mode: string,
  _simulationConfig: any,
  preFiltered?: PreFilteredSymbolData[],
  indicatorCache?: IndicatorCacheManager,
): { totalTrainReturn: number; totalTestReturn: number; trainResults: PortfolioBacktestResult[]; testResults: PortfolioBacktestResult[]; monthlyPerformance: MonthlyPerformance[] } {
  const pf = preFiltered || preFilterSymbols(symbolsData, periodSplit);
  const cache = indicatorCache || new IndicatorCacheManager();
  const startCap = DEFAULT_CONFIG.capital_start;

  const trainResults: PortfolioBacktestResult[] = [];
  const testResults: PortfolioBacktestResult[] = [];

  for (const sd of pf) {
    // Get or compute indicators from cache — with datasetId for correct scoping
    const trainDatasetId = `${sd.symbol}:train:${sd.trainCandles.length}`;
    const testDatasetId = `${sd.symbol}:test:${sd.testCandles.length}`;
    const trainPre = cache.getOrCompute(sd.trainCandles, params, trainDatasetId);
    const testPre = cache.getOrCompute(sd.testCandles, params, testDatasetId);

    // Build strategy-specific indicators (rolling arrays)
    const trainInd = buildIndicatorsFromPrecomputed(trainPre, params, trainDatasetId);
    const testInd = buildIndicatorsFromPrecomputed(testPre, params, testDatasetId);

    const trainResult = runBacktest(sd.trainCandles, params, trainInd);
    const testResult = runBacktest(sd.testCandles, params, testInd);

    trainResults.push({ symbol: sd.symbol, result: trainResult, capitalAllocated: startCap, contributionToTotal: trainResult.totalReturn });
    testResults.push({ symbol: sd.symbol, result: testResult, capitalAllocated: startCap, contributionToTotal: testResult.totalReturn });
  }

  const totalTrainReturn = trainResults.length > 0 ? trainResults.reduce((s, r) => s + r.result.totalReturn, 0) / trainResults.length : 0;
  const totalTestReturn = testResults.length > 0 ? testResults.reduce((s, r) => s + r.result.totalReturn, 0) / testResults.length : 0;

  return { totalTrainReturn, totalTestReturn, trainResults, testResults, monthlyPerformance: [] };
}

export function calculateMonthlyPerformance(_results: PortfolioBacktestResult[], _phase: 'train' | 'test'): MonthlyPerformance[] {
  return [];
}

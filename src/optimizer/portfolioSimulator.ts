/**
 * SimulatorV2 — Full backtest engine from server
 * Commission model: max(1¢/share, $2.50) + slippage + overnight fees
 * Trade management: TP stepping, RSI trailing, breakeven, non-regress stop
 */
import type { Candle, ExtendedStocksStrategyParameters, BacktestResult, Trade, PortfolioBacktestResult, MonthlyPerformance, SymbolData, PeriodSplit } from './types';
import { StrategyIndicators, strategy1_EMATrend, strategy2_BollingerMeanReversion, strategy3_RangeBreakout, strategy4_InsideBarBreakout, strategy5_ATRSqueezeBreakout, __SIG_COUNTERS, __resetSigCounters } from './strategies';
import { IndicatorCacheManager, PrecomputedData, rollingHighest, rollingLowest } from './indicatorCache';
import { highest, lowest } from './indicators';

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
  risk_percent: number; // fraction of capital to risk per trade (e.g. 0.02 = 2%)
  use_risk_sizing: boolean; // true = risk-based, false = all-in (legacy)
}

const DEFAULT_CONFIG: SimulationConfig = {
  capital_start: 10000,
  enable_commissions: false,
  commission_per_share_cent: 1.0,
  min_commission_side_usd: 2.5,
  slippage_pct_side: 0,
  leverage_mode: 'ללא מינוף',
  leverage: 1,
  enable_overnight_fee: false,
  overnight_fee_pct: 0,
  risk_percent: 0.02,
  use_risk_sizing: false,
};

function calculateCommission(qty: number, cfg: SimulationConfig): number {
  if (!cfg.enable_commissions) return 0;
  return Math.max((qty * cfg.commission_per_share_cent) / 100, cfg.min_commission_side_usd);
}

function getRoundTripCost(capital: number, entryPrice: number, qty: number, cfg: SimulationConfig) {
  const commEntry = calculateCommission(qty, cfg);
  const commExit = calculateCommission(qty, cfg);
  const tradeNotional = entryPrice * qty;
  const slippageEntry = (tradeNotional * cfg.slippage_pct_side) / 100;
  const slippageExit = (tradeNotional * cfg.slippage_pct_side) / 100;
  const totalCostUsd = commEntry + commExit + slippageEntry + slippageExit;
  const totalCostPct = totalCostUsd / capital;
  return { totalCostUsd, totalCostPct, commEntry, commExit, slippageEntry, slippageExit };
}

function calculateOvernightFee(position: number, nights: number, notional: number, isLev: boolean, cfg: SimulationConfig): number {
  if (!cfg.enable_overnight_fee || nights <= 0) return 0;
  // Pine parity: fee applies only to (a) any short, or (b) leveraged long.
  // No-leverage longs do NOT pay overnight fees.
  const isShort = position === -1;
  const isLong = position === 1;
  if (!isShort && !(isLong && isLev)) return 0;
  return notional * (cfg.overnight_fee_pct / 100) * nights;
}

/**
 * Count actual overnight crossings between two timestamps in NY time.
 * An intraday trade returns 0; one that crosses midnight NY once returns 1, etc.
 */
function countNights(entryTs: number, exitTs: number): number {
  if (exitTs <= entryTs) return 0;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const entryDay = fmt.format(new Date(entryTs));
  const exitDay = fmt.format(new Date(exitTs));
  if (entryDay === exitDay) return 0;
  // Compute calendar-day difference in NY by parsing the YYYY-MM-DD strings.
  const [ey, em, ed] = entryDay.split('-').map(Number);
  const [xy, xm, xd] = exitDay.split('-').map(Number);
  const entryUtc = Date.UTC(ey, em - 1, ed);
  const exitUtc = Date.UTC(xy, xm - 1, xd);
  return Math.max(0, Math.round((exitUtc - entryUtc) / 86400000));
}

function qtyFrom(capital: number, price: number, levMult: number): number {
  return Math.floor((capital * levMult) / price);
}

/**
 * Risk-based position sizing: risk a fixed % of capital per trade.
 * qty = riskAmount / riskPerShare, where riskPerShare = |entry - stop|
 */
function qtyFromRisk(capital: number, entryPrice: number, stopPrice: number, direction: 'long' | 'short', riskPercent: number, levMult: number): number {
  const riskAmount = capital * riskPercent;
  const riskPerShare = direction === 'long'
    ? entryPrice - stopPrice
    : stopPrice - entryPrice;
  if (riskPerShare <= 0) {
    // Fallback: stop not protective, use small fixed position
    return Math.max(1, Math.floor((capital * 0.05 * levMult) / entryPrice));
  }
  const qty = Math.floor(riskAmount / riskPerShare);
  // Cap at max affordable shares
  const maxQty = Math.floor((capital * levMult) / entryPrice);
  return Math.max(1, Math.min(qty, maxQty));
}

function calculateInitialStopLong(entryPrice: number, entryOpenPrice: number, currentATR: number, use_atr_sl: boolean, eff_sl_pct: number, eff_atr_mult: number) {
  const baseSlPc = eff_sl_pct / 100;
  let slPc = baseSlPc;
  if (use_atr_sl && currentATR > 0) {
    const atrStopPc = (currentATR / entryPrice) * eff_atr_mult;
    slPc = Math.max(baseSlPc, atrStopPc);
  }
  // Pine parity:
  //   trail_stop (initial)  = baseEntry * (1 - sl_pc)  → baseEntry = close (signal-on-close)
  //   base_sl_long (floor)  = entry_open * (1 - sl_pc)
  const initialStop = entryPrice * (1 - slPc);     // close-based (Pine trail_stop @ entry)
  const baseSl = entryOpenPrice * (1 - slPc);      // open-based (Pine base_sl_long, trail floor)
  return { slPcEntry: slPc, initialStop, baseSl };
}

function calculateInitialStopShort(entryPrice: number, entryOpenPrice: number, currentATR: number, use_atr_sl: boolean, eff_sl_pct: number, eff_atr_mult: number) {
  const baseSlPc = eff_sl_pct / 100;
  let slPc = baseSlPc;
  if (use_atr_sl && currentATR > 0) {
    const atrStopPc = (currentATR / entryPrice) * eff_atr_mult;
    slPc = Math.max(baseSlPc, atrStopPc);
  }
  // Pine parity:
  //   trail_stop (initial)  = baseEntry * (1 + sl_pc)  → baseEntry = close
  //   base_sl_short (floor) = entry_open * (1 + sl_pc)
  const initialStop = entryPrice * (1 + slPc);     // close-based (Pine trail_stop @ entry)
  const baseSl = entryOpenPrice * (1 + slPc);      // open-based (Pine base_sl_short, trail floor)
  return { slPcEntry: slPc, initialStop, baseSl };
}

function checkBreakevenLong(beActive: boolean, high: number, entry: number, pct: number): boolean {
  if (beActive) return true;
  return high >= entry + entry * (pct / 100);
}

function checkBreakevenShort(beActive: boolean, low: number, entry: number, pct: number): boolean {
  if (beActive) return true;
  return low <= entry - entry * (pct / 100);
}

function getStopExecPriceLong(stopAtOpen: number | null, trail: number | null, prefTp: boolean, prevHit: boolean, afterHit: boolean, entryPrice?: number, barOpen?: number, useTvStopPrecedence?: boolean): number | null {
  let stopPrice: number | null;
  if (prefTp && afterHit && trail !== null) stopPrice = trail;
  else if (prevHit && stopAtOpen !== null) stopPrice = stopAtOpen;
  else stopPrice = stopAtOpen ?? trail ?? null;

  // TV stop precedence: profitable stop acts as limit order (fills at better price)
  if (useTvStopPrecedence && stopPrice !== null && entryPrice !== undefined && barOpen !== undefined) {
    if (stopPrice > entryPrice) {
      // Stop is in profit territory — TradingView treats as limit order
      return Math.max(stopPrice, barOpen);
    }
  }
  // Gap-fill: bar opens below stop → fill at worse open price
  if (stopPrice !== null && barOpen !== undefined && barOpen < stopPrice) {
    return barOpen;
  }
  return stopPrice;
}

function getStopExecPriceShort(stopAtOpen: number | null, trail: number | null, prefTp: boolean, prevHit: boolean, afterHit: boolean, entryPrice?: number, barOpen?: number, useTvStopPrecedence?: boolean): number | null {
  let stopPrice: number | null;
  if (prefTp && afterHit && trail !== null) stopPrice = trail;
  else if (prevHit && stopAtOpen !== null) stopPrice = stopAtOpen;
  else stopPrice = stopAtOpen ?? trail ?? null;

  // TV stop precedence: profitable stop acts as limit order (fills at better price)
  if (useTvStopPrecedence && stopPrice !== null && entryPrice !== undefined && barOpen !== undefined) {
    if (stopPrice < entryPrice) {
      // Stop is in profit territory — TradingView treats as limit order
      return Math.min(stopPrice, barOpen);
    }
  }
  // Gap-fill: bar opens above stop → fill at worse open price
  if (stopPrice !== null && barOpen !== undefined && barOpen > stopPrice) {
    return barOpen;
  }
  return stopPrice;
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
  cfgOverride: Partial<SimulationConfig> = {},
): BacktestResult {
  const cfg: SimulationConfig = { ...DEFAULT_CONFIG, ...cfgOverride };
  if (candles.length < 100) return emptyResult(params, cfg.capital_start);

  // ===== [DIAG] Temporary diagnostic logging =====
  const ENABLE_DIAG_LOGS = true;
  if (ENABLE_DIAG_LOGS) {
    __resetSigCounters();
    console.log('[DIAG] runBacktest start — enabled strategies:', {
      S1: !!params.enable_strat1,
      S2: !!params.enable_strat2,
      S3: !!params.enable_strat3,
      S4: !!params.enable_strat4,
      S5: !!params.enable_strat5,
      candles: candles.length,
    });
  }

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
  const s3Min = (params.s3_breakout_len ?? 10) + 1;
  const s4Min = 5;
  const s5Min = Math.max(params.s5_squeeze_len ?? 1, params.s5_range_len ?? 10) + 5;
  const startBar = Math.min(s1Min, s2Min, s3Min, s4Min, s5Min);

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
  // F4: track first bar where trailing was activated (TP-step or RSI-trail)
  let trailStartBarLong: number | null = null;
  let trailStartBarShort: number | null = null;

  // ===== DIAG-S3 (temporary): counters for why S3 raw signals don't enter =====
  const diagS3 = {
    raw_buy: 0, raw_sell: 0,
    entered_buy: 0, entered_sell: 0,
    blocked_sim_window: 0,
    blocked_position_no_flip: 0,
    blocked_spacing: 0,
    blocked_bar_or_dist: 0,
    blocked_tie_break_short: 0, // S3 sell killed by long-priority tie-break
    blocked_other_strategy_won_entry: 0, // signal was true but a different sid took the slot
    blocked_by_trade_time: 0,
    blocked_by_vix_filter: 0,
    // Step 1 — split position blocks
    blocked_in_long_position: 0,
    blocked_in_short_no_flip_S2L: 0,
    blocked_in_short_with_flip_attempted: 0,
    blocked_in_long_no_flip_L2S: 0,
    blocked_in_short_position: 0,
    // Step 2 — spacing histogram (bars_since_last_entry at rejection)
    spacing_hist_0: 0,
    spacing_hist_1_3: 0,
    spacing_hist_4_6: 0,
    spacing_hist_7p: 0,
    // Step 3 — first 5 S3 trades
    first_trades: [] as Array<{ n: number; bar: number; ts: string; type: 'buy' | 'sell'; flip: boolean; bars_since_last_entry: number; lastEntryBar: number }>,
  };

  // ===== F-S3-FILTERS-ORDER: trade_time_ok + VIX gates (Pine parity) =====
  // trade_time_ok: blocks first/last bar of each session when avoid_opening_bar / block_close_bar.
  // Session boundary = NY calendar day change between bars.
  const nyDayFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const nyDay = (ts: number) => nyDayFmt.format(new Date(ts));
  const isOpeningBar = (idx: number) => idx === 0 || nyDay(candles[idx].timestamp) !== nyDay(candles[idx - 1].timestamp);
  const isClosingBar = (idx: number) => idx === candles.length - 1 || nyDay(candles[idx].timestamp) !== nyDay(candles[idx + 1].timestamp);

  // VIX freeze counter (no VIX series wired into portfolioSimulator yet → stays 0).
  // Kept for Pine parity surface; effective only when use_vix_freeze=true AND a VIX series exists.
  let vix_freeze_left = 0;

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

    // F-S3-FILTERS-ORDER: trade_time_ok (Pine parity)
    let trade_time_ok = true;
    if (params.avoid_opening_bar && isOpeningBar(i)) trade_time_ok = false;
    if (params.block_close_bar && isClosingBar(i)) trade_time_ok = false;

    // F-S3-FILTERS-ORDER: vix_above_range — no VIX series here → never blocks.
    // (Tracked only for diag parity; effective implementation requires VIX wiring.)
    const vix_above_range = false;

    // VIX freeze decay (effective only with use_vix_freeze + VIX series; currently inert)
    if (vix_freeze_left > 0) vix_freeze_left--;

    const filtersOk = trade_time_ok && !vix_above_range && vix_freeze_left === 0;

    if (params.enable_strat1 && i >= s1Min) {
      const s = strategy1_EMATrend(candles, i, indicators, params);
      bS1 = simOk && filtersOk && s.buySignal && barOk && distOk && position !== 1 && ((isFlat && spacingOk) || canFlipL);
      sS1 = simOk && filtersOk && s.sellSignal && barOk && distOk && position !== -1 && ((isFlat && spacingOk) || canFlipS);
    }
    if (params.enable_strat2 && i >= s2Min) {
      const s = strategy2_BollingerMeanReversion(candles, i, indicators, params);
      bS2 = simOk && filtersOk && s.buySignal && position !== 1 && ((isFlat && spacingOk) || canFlipL);
      sS2 = simOk && filtersOk && s.sellSignal && position !== -1 && ((isFlat && spacingOk) || canFlipS);
    }
    if (params.enable_strat3 && i >= s3Min) {
      const s = strategy3_RangeBreakout(candles, i, indicators, params);
      bS3 = simOk && filtersOk && s.buySignal && position !== 1 && ((isFlat && spacingOk) || canFlipL);
      sS3 = simOk && filtersOk && s.sellSignal && position !== -1 && ((isFlat && spacingOk) || canFlipS);
      if (ENABLE_DIAG_LOGS) {
        if (s.buySignal) {
          diagS3.raw_buy++;
          if (!simOk) diagS3.blocked_sim_window++;
          else if (!trade_time_ok) diagS3.blocked_by_trade_time++;
          else if (vix_above_range || vix_freeze_left > 0) diagS3.blocked_by_vix_filter++;
          else if (position === 1) { diagS3.blocked_position_no_flip++; diagS3.blocked_in_long_position++; }
          else if (position === -1 && !params.allow_flip_S2L) { diagS3.blocked_position_no_flip++; diagS3.blocked_in_short_no_flip_S2L++; }
          else if (position === -1 && !canFlipL) { diagS3.blocked_position_no_flip++; diagS3.blocked_in_short_with_flip_attempted++; }
          else if (isFlat && !spacingOk) {
            diagS3.blocked_spacing++;
            const d = i - lastEntryBar;
            if (d <= 0) diagS3.spacing_hist_0++;
            else if (d <= 3) diagS3.spacing_hist_1_3++;
            else if (d <= 6) diagS3.spacing_hist_4_6++;
            else diagS3.spacing_hist_7p++;
          }
        }
        if (s.sellSignal) {
          diagS3.raw_sell++;
          if (!simOk) diagS3.blocked_sim_window++;
          else if (!trade_time_ok) diagS3.blocked_by_trade_time++;
          else if (vix_above_range || vix_freeze_left > 0) diagS3.blocked_by_vix_filter++;
          else if (position === -1) { diagS3.blocked_position_no_flip++; diagS3.blocked_in_short_position++; }
          else if (position === 1 && !params.allow_flip_L2S) { diagS3.blocked_position_no_flip++; diagS3.blocked_in_long_no_flip_L2S++; }
          else if (position === 1 && !canFlipS) { diagS3.blocked_position_no_flip++; diagS3.blocked_in_long_no_flip_L2S++; }
          else if (isFlat && !spacingOk) {
            diagS3.blocked_spacing++;
            const d = i - lastEntryBar;
            if (d <= 0) diagS3.spacing_hist_0++;
            else if (d <= 3) diagS3.spacing_hist_1_3++;
            else if (d <= 6) diagS3.spacing_hist_4_6++;
            else diagS3.spacing_hist_7p++;
          }
        }
      }
    }
    if (params.enable_strat4 && i >= s4Min) {
      const s = strategy4_InsideBarBreakout(candles, i, indicators, params);
      bS4 = simOk && filtersOk && s.buySignal && position !== 1 && ((isFlat && spacingOk) || canFlipL);
      sS4 = simOk && filtersOk && s.sellSignal && position !== -1 && ((isFlat && spacingOk) || canFlipS);
    }
    if (params.enable_strat5 && i >= s5Min) {
      const s = strategy5_ATRSqueezeBreakout(candles, i, indicators, params);
      bS5 = simOk && filtersOk && s.buySignal && position !== 1 && ((isFlat && spacingOk) || canFlipL);
      sS5 = simOk && filtersOk && s.sellSignal && position !== -1 && ((isFlat && spacingOk) || canFlipS);
    }

    if (!barOk || !distOk) {
      if (ENABLE_DIAG_LOGS) {
        if (bS3) diagS3.blocked_bar_or_dist++;
        if (sS3) diagS3.blocked_bar_or_dist++;
      }
      bS1 = bS2 = bS3 = bS4 = bS5 = false;
      sS1 = sS2 = sS3 = sS4 = sS5 = false;
    }
    let buy = bS1 || bS2 || bS3 || bS4 || bS5;
    let sell = sS1 || sS2 || sS3 || sS4 || sS5;
    if (buy && sell) {
      if (ENABLE_DIAG_LOGS && sS3) diagS3.blocked_tie_break_short++;
      sell = false; // Tie-break: long priority
    }

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
        if (ENABLE_DIAG_LOGS && bS3) {
          if (entrySid === 3) diagS3.entered_buy++;
          else diagS3.blocked_other_strategy_won_entry++;
        }
        if (ENABLE_DIAG_LOGS && entrySid === 3 && diagS3.first_trades.length < 5) {
          diagS3.first_trades.push({
            n: diagS3.first_trades.length + 1,
            bar: i, ts: new Date(c.timestamp).toISOString(),
            type: 'buy', flip: false,
            bars_since_last_entry: i - lastEntryBar,
            lastEntryBar,
          });
        }
        const ep = cl, eop = op, pc = capital;
        // Calculate stop first for risk-based sizing
        const initStop = calculateInitialStopLong(ep, eop, atr, params.use_atr_sl, params.stop_distance_percent_long, params.atr_mult_long);
        const qty = cfg.use_risk_sizing
          ? qtyFromRisk(pc, ep, initStop.initialStop, 'long', cfg.risk_percent, levMult)
          : qtyFrom(pc, ep, levMult);
        entryQty = qty; entryPrice = ep; entryOpenPrice = eop;
        entryNotional = qty * ep; entryBarIdx = i; lastEntryBar = i;
        position = 1;
        currentTrade = {
          entryTime: c.timestamp, entryPrice: ep, type: 'long',
          capitalAtEntry: pc, entryBarIndex: i, entryStrategyId: entrySid,
          stopPrice: initStop.initialStop,
          tpPrice: params.tp_percent_long > 0 ? ep * (1 + params.tp_percent_long / 100) : undefined,
        };
        trailStop = null; stopAtBarOpen = null; barsInTrade = 0;
        tpSteps = 0; beActive = false; trOnlyL = null; stepStopL = null;
      } else if (sell) {
        entrySid = sS1 ? 1 : sS2 ? 2 : sS3 ? 3 : sS4 ? 4 : sS5 ? 5 : 0;
        if (ENABLE_DIAG_LOGS && sS3) {
          if (entrySid === 3) diagS3.entered_sell++;
          else diagS3.blocked_other_strategy_won_entry++;
        }
        if (ENABLE_DIAG_LOGS && entrySid === 3 && diagS3.first_trades.length < 5) {
          diagS3.first_trades.push({
            n: diagS3.first_trades.length + 1,
            bar: i, ts: new Date(c.timestamp).toISOString(),
            type: 'sell', flip: false,
            bars_since_last_entry: i - lastEntryBar,
            lastEntryBar,
          });
        }
        const ep = cl, eop = op, pc = capital;
        // Calculate stop first for risk-based sizing
        const initStopS = calculateInitialStopShort(ep, eop, atr, params.use_atr_sl, params.stop_distance_percent_short, params.atr_mult_short);
        const qty = cfg.use_risk_sizing
          ? qtyFromRisk(pc, ep, initStopS.initialStop, 'short', cfg.risk_percent, levMult)
          : qtyFrom(pc, ep, levMult);
        entryQty = qty; entryPrice = ep; entryOpenPrice = eop;
        entryNotional = qty * ep; entryBarIdx = i; lastEntryBar = i;
        position = -1;
        currentTrade = {
          entryTime: c.timestamp, entryPrice: ep, type: 'short',
          capitalAtEntry: pc, entryBarIndex: i, entryStrategyId: entrySid,
          stopPrice: initStopS.initialStop,
          tpPrice: params.tp_percent_short > 0 ? ep * (1 - params.tp_percent_short / 100) : undefined,
        };
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
        const pc = capital, nights = countNights(candles[entryBarIdx].timestamp, c.timestamp);
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
        trailStartBarLong = null; trailStartBarShort = null;
      };

      if (position === 1) {
        const bePct = params.be_trigger_pct_long;
        const trPct = params.trail_rsi_pct_input_long / 100;
        const rsiThr = params.rsi_trail_long;
        const isEntry = barsInTrade === 1;
        if (trailStop === null && isEntry) {
          const r = calculateInitialStopLong(entryPrice, entryOpenPrice ?? entryPrice, atr, params.use_atr_sl, params.stop_distance_percent_long, params.atr_mult_long);
          // Pine parity: trail_stop @ entry = close-based; base_sl_long (floor) = open-based
          baseSL = r.baseSl; trailStop = r.initialStop;
        }
        const tpPct = params.tp_percent_long / 100;
        const tpTrailDist = params.tp_trail_distance_long;
        const stepsCrossed = tpPct > 0 ? Math.max(0, Math.floor((hi / entryPrice - 1) / tpPct)) : 0;
        const opened = position === 1 && prevPos !== 1;
        // Pine parity:
        //   stop_at_bar_open := position == position[1] ? nz(trail_stop[1], trail_stop) : trail_stop
        //   → entry bar: stop_at_bar_open = trail_stop (close-based initial)
        //   → bar 2+   : stop_at_bar_open = previous bar's trail_stop (carries BE/RSI/step updates)
        if (opened) {
          stopAtBarOpen = trailStop ?? (entryPrice * 0.95);
        } else {
          stopAtBarOpen = prevTrailStop ?? stopAtBarOpen ?? trailStop ?? (entryPrice * 0.95);
        }

        if (!beActive) beActive = checkBreakevenLong(beActive, hi, entryPrice, bePct);
        // Rolling highest over barsInTrade bars (Pine: ta.highest(high, bars_in_trade))
        const rollingHigh = highest(highs, barsInTrade, i);
        if (rsi >= rsiThr && barsInTrade > 1) {
          const tc = rollingHigh * (1 - trPct);
          trOnlyL = Math.max(trOnlyL ?? (baseSL ?? entryPrice * 0.94), tc);
          if (trOnlyL >= entryPrice) trOnlyL = Math.max(trOnlyL, entryPrice);
        }
        let tpR = false;
        if (stepsCrossed > tpSteps) {
          tpR = true; tpSteps = stepsCrossed;
          stepStopL = entryPrice * (1 + tpPct * tpSteps) * (1 - tpTrailDist / 100);
        }
        // Pine 2651: prev_final = position == position[1] ? nz(trail_stop[1], base_sl_long) : base_sl_long
        // Entry bar uses open-based base_sl_long; bar 2+ uses previous trail_stop.
        let pf: number = opened
          ? (baseSL ?? trailStop ?? entryPrice * 0.98)
          : (prevTrailStop ?? trailStop ?? baseSL ?? entryPrice * 0.98);
        let fs: number = pf;
        if (rsi >= rsiThr && trOnlyL !== null) fs = Math.max(fs, trOnlyL);
        else if (tpR && stepStopL !== null) fs = Math.max(fs, stepStopL);
        if (beActive || pf >= entryPrice) fs = Math.max(fs, entryPrice);
        // F5: Pine applies non_regress only when position == position[1] (i.e. not on entry bar)
        if (params.non_regress_stop && !opened) fs = Math.max(fs, pf);
        // F3: post_trail_tighten — extra tighten once trail is active
        if ((params as any).use_post_trail_tighten && (tpR || (rsi >= rsiThr && trOnlyL !== null))) {
          const tightenPct = (params as any).post_trail_tighten_pct ?? 0;
          if (tightenPct > 0) fs = Math.max(fs, cl * (1 - tightenPct / 100));
        }
        trailStop = fs;
        // F4: mark trail activation bar
        if (trailStartBarLong === null && (tpR || (rsi >= rsiThr && trOnlyL !== null))) {
          trailStartBarLong = i;
        }

        const spCheck = histStopAtOpen ?? stopAtBarOpen;
        // F2: stop_on_close_only — use close instead of low for trigger
        const useCloseOnly = (params as any).stop_on_close_only === true;
        const sPrev = spCheck !== null && (useCloseOnly ? cl <= spCheck : lo <= spCheck);
        const sAfter = trailStop !== null && (useCloseOnly ? cl <= trailStop : lo <= trailStop);
        // Pine parity: block stop on entry bar unless explicitly allowed.
        const blockSameBar = opened && (params as any).allow_same_bar_exit !== true;
        let stopHit = blockSameBar ? false : (params.prefer_tp_priority ? (sPrev || sAfter) : sPrev);
        // F4: min_bars_post_trail — block trail-based exits for N bars after trail activated
        if (stopHit && (params as any).use_min_bars_post_trail && trailStartBarLong !== null) {
          const minBars = (params as any).min_bars_post_trail ?? 0;
          if (i - trailStartBarLong < minBars) stopHit = false;
        }

        let shouldExit = false, xReason: Trade['exitReason'] = 'signal', xPrice = cl;
        if (stopHit) {
          shouldExit = true;
          const execStop = getStopExecPriceLong(spCheck, trailStop, params.prefer_tp_priority, sPrev, sAfter, entryPrice, op, params.use_tv_stop_precedence) ?? cl;
          xPrice = execStop;
          xReason = (params.use_tv_stop_precedence && execStop > entryPrice) ? 'trailing_stop' : 'stop_loss';
        }
        else if (params.allow_flip_L2S && sell) { shouldExit = true; xReason = 'flip'; xPrice = cl; }
        else if (exitL) { shouldExit = true; xReason = 'signal'; xPrice = cl; }

        if (shouldExit) {
          exitTrade(xReason, xPrice, 1);
          if (xReason === 'flip') {
            entrySid = sS2 ? 2 : sS1 ? 1 : sS3 ? 3 : sS4 ? 4 : sS5 ? 5 : 0;
            if (ENABLE_DIAG_LOGS && entrySid === 3 && diagS3.first_trades.length < 5) {
              diagS3.first_trades.push({
                n: diagS3.first_trades.length + 1,
                bar: i, ts: new Date(c.timestamp).toISOString(),
                type: 'sell', flip: true,
                bars_since_last_entry: i - lastEntryBar,
                lastEntryBar,
              });
            }
            const ep = cl, pc = capital;
            const r = calculateInitialStopShort(ep, op, atr, params.use_atr_sl, params.stop_distance_percent_short, params.atr_mult_short);
            const qty = cfg.use_risk_sizing
              ? qtyFromRisk(pc, ep, r.initialStop, 'short', cfg.risk_percent, levMult)
              : qtyFrom(pc, ep, levMult);
            entryQty = qty; entryPrice = ep; entryOpenPrice = op; entryNotional = qty * ep;
            entryBarIdx = i; lastEntryBar = i; position = -1;
            currentTrade = {
              entryTime: c.timestamp, entryPrice: ep, type: 'short',
              capitalAtEntry: pc, entryBarIndex: i, entryStrategyId: entrySid ?? 0,
              stopPrice: r.initialStop,
              tpPrice: params.tp_percent_short > 0 ? ep * (1 - params.tp_percent_short / 100) : undefined,
            };
            barsInTrade = 1; tpSteps = 0;
            // Pine parity: at entry trail_stop=close-based; base_sl floor=open-based; stop_at_bar_open=trail_stop
            baseSS = r.baseSl; trailStop = r.initialStop; stopAtBarOpen = trailStop;
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
          // Pine parity: trail_stop @ entry = close-based; base_sl_short (floor) = open-based
          baseSS = r.baseSl; trailStop = r.initialStop;
        }
        const tpPct = params.tp_percent_short / 100;
        const tpTrailDist = params.tp_trail_distance_short;
        const stepsCrossed = tpPct > 0 ? Math.max(0, Math.floor((1 - lo / entryPrice) / tpPct)) : 0;
        const opened = position === -1 && prevPos !== -1;
        // Pine parity:
        //   stop_at_bar_open := position == position[1] ? nz(trail_stop[1], trail_stop) : trail_stop
        if (opened) {
          stopAtBarOpen = trailStop ?? (entryPrice * 1.05);
        } else {
          stopAtBarOpen = prevTrailStop ?? stopAtBarOpen ?? trailStop ?? (entryPrice * 1.05);
        }

        if (!beActive) beActive = checkBreakevenShort(beActive, lo, entryPrice, bePct);
        // Rolling lowest over barsInTrade bars (Pine: ta.lowest(low, bars_in_trade))
        const rollingLow = lowest(lows, barsInTrade, i);
        if (rsi <= rsiThr && barsInTrade > 1) {
          const tc = rollingLow * (1 + trPct);
          trOnlyS = Math.min(trOnlyS ?? (baseSS ?? entryPrice * 1.06), tc);
          if (trOnlyS !== null && trOnlyS <= entryPrice) trOnlyS = Math.min(trOnlyS, entryPrice);
        }
        let tpR = false;
        if (stepsCrossed > tpSteps) {
          tpR = true; tpSteps = stepsCrossed;
          stepStopS = entryPrice * (1 - tpPct * tpSteps) * (1 + tpTrailDist / 100);
        }
        // Pine 2685: prev_final_s = position == position[1] ? nz(trail_stop[1], base_sl_short) : base_sl_short
        let pf = opened
          ? (baseSS ?? trailStop ?? entryPrice * 1.02)
          : (prevTrailStop ?? trailStop ?? baseSS ?? entryPrice * 1.02);
        // F6: Pine precedence — final_stop = min(prev_final, trail). Start from pf, tighten with min.
        let fs: number = pf;
        if (rsi <= rsiThr && trOnlyS !== null) fs = Math.min(fs, trOnlyS);
        else if (tpR && stepStopS !== null) fs = Math.min(fs, stepStopS);
        if (beActive || pf <= entryPrice) fs = Math.max(fs, entryPrice);
        // F5: non_regress only on bar 2+
        if (params.non_regress_stop && !opened) fs = Math.min(fs, pf);
        // F3: post_trail_tighten — extra tighten once trail is active (short: lower stop)
        if ((params as any).use_post_trail_tighten && (tpR || (rsi <= rsiThr && trOnlyS !== null))) {
          const tightenPct = (params as any).post_trail_tighten_pct ?? 0;
          if (tightenPct > 0) fs = Math.min(fs, cl * (1 + tightenPct / 100));
        }
        trailStop = fs;
        // F4: mark trail activation bar
        if (trailStartBarShort === null && (tpR || (rsi <= rsiThr && trOnlyS !== null))) {
          trailStartBarShort = i;
        }

        const spCheck = histStopAtOpen ?? stopAtBarOpen;
        // F2: stop_on_close_only
        const useCloseOnly = (params as any).stop_on_close_only === true;
        const sPrev = spCheck !== null && (useCloseOnly ? cl >= spCheck : hi >= spCheck);
        const sAfter = trailStop !== null && (useCloseOnly ? cl >= trailStop : hi >= trailStop);
        // Pine parity: block stop on entry bar unless explicitly allowed.
        const blockSameBar = opened && (params as any).allow_same_bar_exit !== true;
        let stopHit = blockSameBar ? false : (params.prefer_tp_priority ? (sPrev || sAfter) : sPrev);
        // F4: min_bars_post_trail
        if (stopHit && (params as any).use_min_bars_post_trail && trailStartBarShort !== null) {
          const minBars = (params as any).min_bars_post_trail ?? 0;
          if (i - trailStartBarShort < minBars) stopHit = false;
        }

        let shouldExit = false, xReason: Trade['exitReason'] = 'signal', xPrice = cl;
        if (stopHit) {
          shouldExit = true;
          const execStop = getStopExecPriceShort(spCheck, trailStop, params.prefer_tp_priority, sPrev, sAfter, entryPrice, op, params.use_tv_stop_precedence) ?? cl;
          xPrice = execStop;
          xReason = (params.use_tv_stop_precedence && execStop < entryPrice) ? 'trailing_stop' : 'stop_loss';
        }
        else if (params.allow_flip_S2L && buy) { shouldExit = true; xReason = 'flip'; xPrice = cl; }
        else if (exitS) { shouldExit = true; xReason = 'signal'; xPrice = cl; }

        if (shouldExit) {
          exitTrade(xReason, xPrice, -1);
          if (xReason === 'flip') {
            entrySid = bS2 ? 2 : bS1 ? 1 : bS3 ? 3 : bS4 ? 4 : bS5 ? 5 : 0;
            if (ENABLE_DIAG_LOGS && entrySid === 3 && diagS3.first_trades.length < 5) {
              diagS3.first_trades.push({
                n: diagS3.first_trades.length + 1,
                bar: i, ts: new Date(c.timestamp).toISOString(),
                type: 'buy', flip: true,
                bars_since_last_entry: i - lastEntryBar,
                lastEntryBar,
              });
            }
            const ep = cl, pc = capital;
            const r = calculateInitialStopLong(ep, op, atr, params.use_atr_sl, params.stop_distance_percent_long, params.atr_mult_long);
            const qty = cfg.use_risk_sizing
              ? qtyFromRisk(pc, ep, r.initialStop, 'long', cfg.risk_percent, levMult)
              : qtyFrom(pc, ep, levMult);
            entryQty = qty; entryPrice = ep; entryOpenPrice = op; entryNotional = qty * ep;
            entryBarIdx = i; lastEntryBar = i; position = 1;
            currentTrade = {
              entryTime: c.timestamp, entryPrice: ep, type: 'long',
              capitalAtEntry: pc, entryBarIndex: i, entryStrategyId: entrySid ?? 0,
              stopPrice: r.initialStop,
              tpPrice: params.tp_percent_long > 0 ? ep * (1 + params.tp_percent_long / 100) : undefined,
            };
            barsInTrade = 1; tpSteps = 0;
            // Pine parity: at entry trail_stop=close-based; base_sl floor=open-based; stop_at_bar_open=trail_stop
            baseSL = r.baseSl; trailStop = r.initialStop; stopAtBarOpen = trailStop;
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
    const onFee = calculateOvernightFee(position, countNights(candles[entryBarIdx].timestamp, lc.timestamp), entryNotional, isLev, cfg);
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

  if (ENABLE_DIAG_LOGS) {
    const tradeBreakdown: Record<string, number> = { S1: 0, S2: 0, S3: 0, S4: 0, S5: 0, unknown: 0 };
    for (const t of trades) {
      const sid = (t as any).entryStrategyId;
      const key = sid >= 1 && sid <= 5 ? `S${sid}` : 'unknown';
      tradeBreakdown[key]++;
    }
    console.log('[DIAG] Signal counts:', { ...__SIG_COUNTERS });
    console.log('[DIAG] Actual trades by entry strategy:', tradeBreakdown);
    console.log('[DIAG] Totals:', {
      totalTrades: trades.length,
      totalReturnPct: tr.toFixed(2),
      finalCapital: capital.toFixed(2),
      winRate: wr.toFixed(2),
    });
    console.log('[DIAG-S3] block-reason breakdown:', diagS3);
    // ===== GAP-DIAG: per-call summary for Optimizer↔Local comparison =====
    const compoundViaTrades = trades.length > 0
      ? (trades.reduce((cap, t) => cap * (1 + ((t.pnlPct ?? 0) / 100)), 1) - 1) * 100
      : 0;
    const sumPnlPct = trades.reduce((s, t) => s + (t.pnlPct ?? 0), 0);
    const firstTs = candles.length > 0 ? new Date(candles[0].timestamp).toISOString() : 'n/a';
    const lastTs = candles.length > 0 ? new Date(candles[candles.length - 1].timestamp).toISOString() : 'n/a';
    console.log('[GAP-DIAG] runBacktest summary:', {
      bars: candles.length,
      first_bar: firstTs,
      last_bar: lastTs,
      trades: trades.length,
      capital_start: startCap,
      capital_end: Number(capital.toFixed(2)),
      totalReturn_capital_based: Number(tr.toFixed(4)),
      compound_via_trades: Number(compoundViaTrades.toFixed(4)),
      sum_pnl_pct: Number(sumPnlPct.toFixed(4)),
    });
  }

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
  _simulationConfig: Partial<SimulationConfig> | undefined,
  preFiltered?: PreFilteredSymbolData[],
  indicatorCache?: IndicatorCacheManager,
): { totalTrainReturn: number; totalTestReturn: number; trainResults: PortfolioBacktestResult[]; testResults: PortfolioBacktestResult[]; monthlyPerformance: MonthlyPerformance[] } {
  const pf = preFiltered || preFilterSymbols(symbolsData, periodSplit);
  const cache = indicatorCache || new IndicatorCacheManager();
  const cfg: SimulationConfig = { ...DEFAULT_CONFIG, ...(_simulationConfig || {}) };
  const startCap = cfg.capital_start;

  // ===== DIAGNOSTIC (temporary) =====
  __resetSigCounters();
  const enabled = {
    s1: !!params.enable_strat1, s2: !!params.enable_strat2,
    s3: !!params.enable_strat3, s4: !!params.enable_strat4, s5: !!params.enable_strat5,
  };
  console.log('[DIAG] runPortfolioBacktest start — enabled strategies:', enabled);

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

    const trainResult = runBacktest(sd.trainCandles, params, trainInd, cfg);
    const testResult = runBacktest(sd.testCandles, params, testInd, cfg);

    trainResults.push({ symbol: sd.symbol, result: trainResult, capitalAllocated: startCap, contributionToTotal: trainResult.totalReturn });
    testResults.push({ symbol: sd.symbol, result: testResult, capitalAllocated: startCap, contributionToTotal: testResult.totalReturn });
  }

  const totalTrainReturn = trainResults.length > 0 ? trainResults.reduce((s, r) => s + r.result.totalReturn, 0) / trainResults.length : 0;
  const totalTestReturn = testResults.length > 0 ? testResults.reduce((s, r) => s + r.result.totalReturn, 0) / testResults.length : 0;

  // ===== DIAGNOSTIC (temporary) =====
  const allTrades: Trade[] = [
    ...trainResults.flatMap(r => r.result.trades || []),
    ...testResults.flatMap(r => r.result.trades || []),
  ];
  const tradeBreakdown: Record<string, number> = { s1: 0, s2: 0, s3: 0, s4: 0, s5: 0, unknown: 0 };
  for (const t of allTrades) {
    const sid = t.entryStrategyId;
    if (sid === 1) tradeBreakdown.s1++;
    else if (sid === 2) tradeBreakdown.s2++;
    else if (sid === 3) tradeBreakdown.s3++;
    else if (sid === 4) tradeBreakdown.s4++;
    else if (sid === 5) tradeBreakdown.s5++;
    else tradeBreakdown.unknown++;
  }
  console.log('[DIAG] Signal counts (raw, pre-filter):', JSON.parse(JSON.stringify(__SIG_COUNTERS)));
  console.log('[DIAG] Actual trades by entry strategy:', tradeBreakdown);
  console.log('[DIAG] Totals — trades:', allTrades.length, 'trainReturn:', totalTrainReturn.toFixed(2) + '%', 'testReturn:', totalTestReturn.toFixed(2) + '%');

  // ===== GAP-DIAG: how Optimizer aggregates train+test vs continuous compound =====
  const trainR = totalTrainReturn;
  const testR = totalTestReturn;
  const arithMean = (trainR + testR) / 2;
  const compoundCombined = ((1 + trainR / 100) * (1 + testR / 100) - 1) * 100;
  console.log('[GAP-DIAG] runPortfolioBacktest aggregation:', {
    train_bars: pf.reduce((s, p) => s + p.trainCandles.length, 0),
    test_bars: pf.reduce((s, p) => s + p.testCandles.length, 0),
    train_return_pct: Number(trainR.toFixed(4)),
    test_return_pct: Number(testR.toFixed(4)),
    reported_avg_for_objective: Number(arithMean.toFixed(4)),
    compound_combined_if_chained: Number(compoundCombined.toFixed(4)),
    note: 'Optimizer best-for-profit uses (train+test)/2; Local PineRunner runs continuous compound on full bar set.',
  });

  return { totalTrainReturn, totalTestReturn, trainResults, testResults, monthlyPerformance: [] };
}

export function calculateMonthlyPerformance(_results: PortfolioBacktestResult[], _phase: 'train' | 'test'): MonthlyPerformance[] {
  return [];
}

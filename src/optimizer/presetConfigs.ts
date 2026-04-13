/**
 * Preset configs — from server (96 parameters with ranges)
 */
import type { ExtendedStocksOptimizationConfig } from './types';

export const NNE_PRESET_CONFIG = {
  strategyType: 'stocks' as const,
  bars_between_trades: { min: 0, max: 0, step: 1 },
  cooldown_after_loss_bars: { min: 0, max: 0, step: 1 },
  allow_flip_L2S: true, allow_flip_S2L: true, signals_on_close: true,

  // Long management
  stop_distance_percent_long: { min: 1, max: 10, step: 1 },
  be_trigger_pct_long: { min: 35, max: 35, step: 1 },
  trail_rsi_pct_input_long: { min: 1, max: 35, step: 1 },
  tp_percent_long: { min: 1, max: 15, step: 0.5 },
  tp_trail_distance_long: { min: 1, max: 10, step: 0.5 },
  rsi_long_entry_min: { min: 45, max: 62, step: 1 },
  rsi_trail_long: { min: 66, max: 90, step: 1 },

  // Short management
  stop_distance_percent_short: { min: 1, max: 15, step: 1 },
  be_trigger_pct_short: { min: 35, max: 35, step: 1 },
  trail_rsi_pct_input_short: { min: 1, max: 35, step: 1 },
  tp_percent_short: { min: 1, max: 15, step: 0.5 },
  tp_trail_distance_short: { min: 1, max: 10, step: 0.5 },
  rsi_short_entry_max: { min: 22, max: 40, step: 1 },
  rsi_trail_short: { min: 22, max: 40, step: 1 },

  // General
  ma_len: { min: 50, max: 50, step: 1 },
  non_regress_stop: false, prefer_tp_priority: true, close_only_trail: false,
  stop_on_close_only: false,
  avoid_opening_bar: false, block_close_bar: false,

  // Advanced filters
  use_big_bar_filter: false, big_bar_atr_mult: { min: 2, max: 8, step: 0.1 },
  use_dist_filter: false, max_dist_from_ema50_pc: { min: 13, max: 25, step: 0.5 },
  use_post_trail_tighten: false, post_trail_tighten_pct: { min: 4, max: 4, step: 0.1 },
  use_min_bars_post_trail: false, min_bars_post_trail: { min: 12, max: 12, step: 1 },
  exit_all_now: false, block_new_entries: false,

  // VIX
  use_vix_range_filter: false, vix_normal_min: { min: 10, max: 10, step: 1 }, vix_normal_max: { min: 30, max: 30, step: 1 },
  use_vix_exit_long: false, use_vix_exit_short: false,
  use_vix_freeze: false, vix_lookback_bars: { min: 1, max: 1, step: 1 }, vix_spike_pct: { min: 8, max: 8, step: 1 }, vix_freeze_bars: { min: 1, max: 1, step: 1 },

  // ATR Stop
  use_atr_sl: false, atr_mult_long: { min: 0.2, max: 3, step: 0.1 }, atr_mult_short: { min: 0.2, max: 3, step: 0.1 },

  // Strategy 1 - EMA Trend (fixed values — single combination)
  enable_strat1: true, enable_rsi_exit: false,
  rsi_exit_long: { min: 40, max: 75, step: 1 }, rsi_exit_short: { min: 20, max: 60, step: 1 },
  min_bars_in_trade_exit: { min: 2, max: 12, step: 1 },
  s1_ema_fast_len: { min: 9, max: 9, step: 1 },
  s1_ema_mid_len: { min: 21, max: 21, step: 1 },
  s1_ema_trend_len: { min: 50, max: 50, step: 1 },
  s1_rsi_len: { min: 14, max: 14, step: 1 },
  s1_atr_len: { min: 16, max: 16, step: 1 },
  s1_atr_ma_len: { min: 12, max: 12, step: 1 },
  s1_atr_hi_mult: { min: 0.85, max: 0.85, step: 0.01 },
  s1_adx_len: { min: 11, max: 11, step: 1 },
  s1_adx_strong: { min: 18, max: 18, step: 1 },
  s1_bb_len: { min: 20, max: 20, step: 1 },
  s1_bb_mult: { min: 2.2, max: 2.2, step: 0.1 },
  s1_far_from_bb_pc: { min: 2, max: 2, step: 1 },
  s1_vol_len: { min: 16, max: 16, step: 1 },
  s1_hi_vol_mult: { min: 1, max: 1, step: 0.1 },
  s1_min_conds: { min: 3, max: 3, step: 1 },

  // Strategy 2 - Bollinger
  enable_strat2: false, bb2_use_trend_filter: false,
  bb2_ma_len: { min: 20, max: 150, step: 20 }, bb2_adx_max: { min: 14, max: 30, step: 1 },
  bb2_adx_len: { min: 11, max: 11, step: 1 },
  bb2_rsi_long_max: { min: 45, max: 62, step: 1 }, bb2_rsi_short_min: { min: 25, max: 40, step: 1 },
  bb2_bb_len: { min: 20, max: 20, step: 1 }, bb2_bb_mult: { min: 2.2, max: 2.2, step: 0.1 },

  // Strategy 3 - Breakout
  enable_strat3: false,
  s3_breakout_len: { min: 10, max: 35, step: 1 }, s3_adx_min: { min: 3, max: 25, step: 1 },
  s3_use_vol_filter: false, s3_vol_mult: { min: 1, max: 5, step: 0.1 },
  s3_rsi_long_min: { min: 45, max: 62, step: 1 }, s3_rsi_short_max: { min: 25, max: 40, step: 1 },

  // Strategy 4 - Inside Bar
  enable_strat4: false, s4_use_trend_filter: false,
  s4_min_inside_range_pc: { min: 0.1, max: 3, step: 0.1 },
  s4_rsi_long_min: { min: 45, max: 62, step: 1 }, s4_rsi_short_max: { min: 25, max: 40, step: 1 },

  // Strategy 5 - ATR Squeeze
  enable_strat5: false,
  s5_squeeze_len: { min: 1, max: 15, step: 1 }, s5_atr_mult_low: { min: 0.5, max: 4, step: 0.1 },
  s5_range_len: { min: 2, max: 20, step: 1 },
  s5_use_vol_filter: false, s5_vol_mult: { min: 0.5, max: 3, step: 0.1 },
  s5_rsi_long_min: { min: 45, max: 62, step: 1 }, s5_rsi_short_max: { min: 25, max: 40, step: 1 },
} as any as ExtendedStocksOptimizationConfig;

export const PRESET_CONFIGS = { NNE: NNE_PRESET_CONFIG };
export const EXTENDED_OPTIMIZATION_CONFIG = NNE_PRESET_CONFIG;

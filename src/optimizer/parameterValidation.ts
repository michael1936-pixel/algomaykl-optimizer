/**
 * Parameter validation — minimum constraints
 */

const MIN_CONSTRAINTS: Record<string, number> = {
  stop_distance_percent_long: 1,
  stop_distance_percent_short: 1,
  tp_percent_long: 0.5,
  tp_percent_short: 0.5,
  tp_trail_distance_long: 0.5,
  tp_trail_distance_short: 0.5,
  trail_rsi_pct_input_long: 1,
  trail_rsi_pct_input_short: 1,
  s4_min_inside_range_pc: 0.1,
  s5_atr_mult_low: 0.5,
  s5_vol_mult: 0.5,
  s3_vol_mult: 0.5,
  big_bar_atr_mult: 1,
  atr_mult_long: 0.2,
  atr_mult_short: 0.2,
  bars_between_trades: 0,

  // Length params — must be >= 1 for Pine Script ta.* functions
  ma_len: 1,
  s1_ema_fast_len: 1,
  s1_ema_mid_len: 1,
  s1_ema_trend_len: 1,
  s1_rsi_len: 1,
  s1_atr_len: 1,
  s1_atr_ma_len: 1,
  s1_adx_len: 1,
  s1_bb_len: 1,
  s1_vol_len: 1,
  s1_min_conds: 1,
  bb2_ma_len: 1,
  bb2_adx_len: 1,
  bb2_adx_max: 1,
  bb2_bb_len: 1,
  bb2_bb_mult: 0.1,
  s3_breakout_len: 1,
  s5_squeeze_len: 1,
  s5_range_len: 1,
  vix_lookback_bars: 1,
  min_bars_post_trail: 1,
  min_bars_in_trade_exit: 1,
};

export function getMinConstraint(paramKey: string): number {
  return MIN_CONSTRAINTS[paramKey] ?? 0;
}

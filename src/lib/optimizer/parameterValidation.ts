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
};

export function getMinConstraint(paramKey: string): number {
  return MIN_CONSTRAINTS[paramKey] ?? 0;
}

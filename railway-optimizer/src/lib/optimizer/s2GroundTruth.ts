// Stub for s2GroundTruth - no parity data needed in this project
export const S2_GT_BARS: ReadonlyArray<{ time_ms: number; close: number }> = [];
export const S2_GT_TIME_MS: ReadonlySet<number> = new Set();
export function isS2GroundTruthBar(_timestamp: number): boolean {
  return false;
}

import type { PeriodSplit } from './types';

export async function suggestTrainTestSplit(
  _symbol: string,
  _totalBars: number,
  defaultSplit: PeriodSplit,
): Promise<PeriodSplit> {
  return defaultSplit;
}

import type { ExtendedStocksStrategyParameters, SymbolData, PeriodSplit, ExtendedStocksOptimizationConfig } from './types';

export interface TestThresholdResult {
  shouldContinue: boolean;
  reason: string;
  testReturn?: number;
  trainReturn?: number;
}

export async function evaluateTestThreshold(
  _params: ExtendedStocksStrategyParameters,
  _symbolsData: SymbolData[],
  _periodSplit: PeriodSplit,
  _config: ExtendedStocksOptimizationConfig,
): Promise<TestThresholdResult> {
  return { shouldContinue: true, reason: 'Server mode - no threshold agent DB access' };
}

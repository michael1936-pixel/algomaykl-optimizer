/**
 * Optimizer Worker Thread — runs backtests for a chunk of parameter combinations
 * Each worker has its own IndicatorCacheManager instance
 */
import { workerData, parentPort } from 'worker_threads';
import type { ExtendedStocksStrategyParameters, SymbolData, PeriodSplit, Candle } from './types';
import { runPortfolioBacktest, preFilterSymbols, PreFilteredSymbolData } from './portfolioSimulator';
import { IndicatorCacheManager } from './indicatorCache';

interface WorkerInput {
  combos: Array<{
    params: ExtendedStocksStrategyParameters;
    key: string;
  }>;
  symbolsData: SymbolData[];
  periodSplit: {
    trainStartDate: number;
    trainEndDate: number;
    testStartDate: number;
    testEndDate: number;
    trainPercent: number;
  };
  mode: string;
  simConfig: any;
  preFilteredData: Array<{
    symbol: string;
    trainCandles: Candle[];
    testCandles: Candle[];
  }>;
}

function run() {
  if (!parentPort || !workerData) return;

  const input = workerData as WorkerInput;

  // Reconstruct Date objects from serialized timestamps
  const periodSplit: PeriodSplit = {
    trainStartDate: new Date(input.periodSplit.trainStartDate),
    trainEndDate: new Date(input.periodSplit.trainEndDate),
    testStartDate: new Date(input.periodSplit.testStartDate),
    testEndDate: new Date(input.periodSplit.testEndDate),
    trainPercent: input.periodSplit.trainPercent,
  };

  // Use preFiltered data directly (already split by main thread)
  const preFiltered: PreFilteredSymbolData[] = input.preFilteredData;

  // Each worker gets its own indicator cache
  const indicatorCache = new IndicatorCacheManager();

  const PROGRESS_INTERVAL = 100;
  let processed = 0;

  for (const combo of input.combos) {
    try {
      const result = runPortfolioBacktest(
        input.symbolsData,
        combo.params,
        periodSplit,
        input.mode,
        input.simConfig,
        preFiltered,
        indicatorCache,
      );

      const valid = typeof result.totalTrainReturn === 'number' && !isNaN(result.totalTrainReturn);

      parentPort!.postMessage({
        type: 'result',
        data: {
          key: combo.key,
          params: combo.params,
          trainReturn: result.totalTrainReturn,
          testReturn: result.totalTestReturn,
          valid,
          portfolioResult: valid ? {
            trainResults: result.trainResults.map((r: any) => ({
              ...r,
              result: { ...r.result, trades: [] },
            })),
            testResults: result.testResults.map((r: any) => ({
              ...r,
              result: { ...r.result, trades: [] },
            })),
            totalTrainReturn: result.totalTrainReturn,
            totalTestReturn: result.totalTestReturn,
            monthlyPerformance: [],
          } : undefined,
        },
      });
    } catch (err) {
      // Skip failed combos silently
      parentPort!.postMessage({
        type: 'result',
        data: {
          key: combo.key,
          params: combo.params,
          trainReturn: -Infinity,
          testReturn: -Infinity,
          valid: false,
        },
      });
    }

    processed++;
    if (processed % PROGRESS_INTERVAL === 0) {
      parentPort!.postMessage({ type: 'progress', count: PROGRESS_INTERVAL });
    }
  }

  // Report remaining progress
  const remaining = processed % PROGRESS_INTERVAL;
  if (remaining > 0) {
    parentPort!.postMessage({ type: 'progress', count: remaining });
  }

  parentPort!.postMessage({ type: 'done' });
}

run();

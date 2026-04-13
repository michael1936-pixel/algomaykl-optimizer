/**
 * Worker Pool Manager — distributes optimization work across CPU cores
 * Uses Node.js worker_threads for true parallel execution
 */
import { Worker } from 'worker_threads';
import * as os from 'os';
import * as path from 'path';
import type { ExtendedStocksStrategyParameters, SymbolData, PeriodSplit } from './types';
import type { CombinationCacheEntry } from './portfolioOptimizer';
import type { PreFilteredSymbolData } from './portfolioSimulator';

export interface WorkerTask {
  combos: Array<{
    params: ExtendedStocksStrategyParameters;
    key: string;
  }>;
  symbolsData: SymbolData[];
  periodSplit: PeriodSplit;
  mode: string;
  simConfig: any;
  preFilteredData: PreFilteredSymbolData[];
}

export interface WorkerResult {
  key: string;
  params: ExtendedStocksStrategyParameters;
  trainReturn: number;
  testReturn: number;
  valid: boolean;
  portfolioResult?: {
    trainResults: any[];
    testResults: any[];
    totalTrainReturn: number;
    totalTestReturn: number;
    monthlyPerformance: any[];
  };
}

export interface BatchResult {
  results: WorkerResult[];
  totalProcessed: number;
}

export class WorkerPool {
  private workers: Worker[] = [];
  private workerCount: number;
  private workerPath: string;
  private busy: Set<number> = new Set();

  constructor(workerCount?: number) {
    this.workerCount = workerCount || Math.max(1, os.cpus().length - 1);
    // Resolve worker path — works with compiled JS
    const ext = __filename.endsWith('.ts') ? '.ts' : '.js';
    this.workerPath = path.join(path.dirname(__filename), `optimizerWorker${ext}`);
  }

  /**
   * Run a batch of combinations in parallel across workers.
   * Returns all results after all workers finish.
   */
  async runBatch(
    combos: Array<{ params: ExtendedStocksStrategyParameters; key: string }>,
    symbolsData: SymbolData[],
    periodSplit: PeriodSplit,
    mode: string,
    simConfig: any,
    preFilteredData: PreFilteredSymbolData[],
    onProgress?: (processed: number) => void,
  ): Promise<WorkerResult[]> {
    if (combos.length === 0) return [];

    // For very small batches, don't bother with workers
    if (combos.length < this.workerCount * 2) {
      return this.runInMainThread(combos, symbolsData, periodSplit, mode, simConfig, preFilteredData);
    }

    const chunkSize = Math.ceil(combos.length / this.workerCount);
    const chunks: Array<Array<{ params: ExtendedStocksStrategyParameters; key: string }>> = [];
    for (let i = 0; i < combos.length; i += chunkSize) {
      chunks.push(combos.slice(i, i + chunkSize));
    }

    // Serialize dates in periodSplit for transfer
    const serializedPeriodSplit = {
      trainStartDate: periodSplit.trainStartDate.getTime(),
      trainEndDate: periodSplit.trainEndDate.getTime(),
      testStartDate: periodSplit.testStartDate.getTime(),
      testEndDate: periodSplit.testEndDate.getTime(),
      trainPercent: periodSplit.trainPercent,
    };

    // Serialize preFiltered data (already plain objects)
    const serializedPreFiltered = preFilteredData.map(pf => ({
      symbol: pf.symbol,
      trainCandles: pf.trainCandles,
      testCandles: pf.testCandles,
    }));

    const allResults: WorkerResult[] = [];
    let totalProcessed = 0;

    const promises = chunks.map((chunk, idx) => {
      return new Promise<WorkerResult[]>((resolve, reject) => {
        const worker = new Worker(this.workerPath, {
          workerData: {
            combos: chunk,
            symbolsData,
            periodSplit: serializedPeriodSplit,
            mode,
            simConfig,
            preFilteredData: serializedPreFiltered,
          },
        });

        const results: WorkerResult[] = [];

        worker.on('message', (msg: any) => {
          if (msg.type === 'result') {
            results.push(msg.data);
          } else if (msg.type === 'progress') {
            totalProcessed += msg.count;
            onProgress?.(totalProcessed);
          } else if (msg.type === 'done') {
            resolve(results);
          }
        });

        worker.on('error', (err) => {
          console.error(`Worker ${idx} error:`, err);
          resolve([]); // Don't fail the whole batch
        });

        worker.on('exit', (code) => {
          if (code !== 0) {
            console.error(`Worker ${idx} exited with code ${code}`);
            resolve(results); // Return what we got
          }
        });
      });
    });

    const chunkResults = await Promise.all(promises);
    for (const cr of chunkResults) {
      allResults.push(...cr);
    }

    return allResults;
  }

  /**
   * Fallback: run in main thread for small batches or when workers fail
   */
  private async runInMainThread(
    combos: Array<{ params: ExtendedStocksStrategyParameters; key: string }>,
    symbolsData: SymbolData[],
    periodSplit: PeriodSplit,
    mode: string,
    simConfig: any,
    preFilteredData: PreFilteredSymbolData[],
  ): Promise<WorkerResult[]> {
    // Lazy import to avoid circular deps at module level
    const { runPortfolioBacktest } = await import('./portfolioSimulator');
    const { IndicatorCacheManager } = await import('./indicatorCache');

    const cache = new IndicatorCacheManager();
    const results: WorkerResult[] = [];

    for (const combo of combos) {
      const result = runPortfolioBacktest(
        symbolsData, combo.params, periodSplit, mode, simConfig, preFilteredData, cache
      );

      const valid = typeof result.totalTrainReturn === 'number' && !isNaN(result.totalTrainReturn);
      results.push({
        key: combo.key,
        params: combo.params,
        trainReturn: result.totalTrainReturn,
        testReturn: result.totalTestReturn,
        valid,
        portfolioResult: valid ? {
          trainResults: result.trainResults.map((r: any) => ({ ...r, result: { ...r.result, trades: [] } })),
          testResults: result.testResults.map((r: any) => ({ ...r, result: { ...r.result, trades: [] } })),
          totalTrainReturn: result.totalTrainReturn,
          totalTestReturn: result.totalTestReturn,
          monthlyPerformance: [],
        } : undefined,
      });
    }

    return results;
  }

  getWorkerCount(): number {
    return this.workerCount;
  }

  terminate(): void {
    for (const w of this.workers) {
      try { w.terminate(); } catch {}
    }
    this.workers = [];
  }
}

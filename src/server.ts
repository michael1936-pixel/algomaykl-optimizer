/**
 * AlgoMaykl Optimizer Server v2
 * Runs smartOptimizer v16 — identical logic to local (browser) optimization
 * Receives data from Supabase edge function, updates optimization_runs in real-time
 */
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { runSmartOptimization, OPTIMIZER_BUILD } from './lib/optimizer/smartOptimizer.js';
import type { SymbolData, PeriodSplit, ExtendedStocksOptimizationConfig } from './lib/optimizer/types.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '200mb' }));

const PORT = parseInt(process.env.PORT || '3000');

// Supabase client for updating progress
function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key);
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', build: OPTIMIZER_BUILD, timestamp: new Date().toISOString() });
});

app.post('/api/optimize', async (req, res) => {
  const { symbolsData, config, periodSplit, runId, mode, enabled_stages } = req.body;

  if (!symbolsData || !config || !periodSplit || !runId) {
    return res.status(400).json({ error: 'Missing required fields: symbolsData, config, periodSplit, runId' });
  }

  console.log(`[${OPTIMIZER_BUILD}] Starting optimization runId=${runId}, symbols=${symbolsData.map((s: any) => s.symbol).join(',')}, bars=${symbolsData[0]?.candles?.length}`);

  // Return immediately — optimization runs in background
  res.json({ accepted: true, runId, build: OPTIMIZER_BUILD });

  // Run optimization in background
  runOptimizationInBackground(symbolsData, config, periodSplit, runId, enabled_stages).catch(err => {
    console.error(`[runId=${runId}] Background optimization crashed:`, err);
  });
});

async function runOptimizationInBackground(
  symbolsData: SymbolData[],
  config: ExtendedStocksOptimizationConfig,
  periodSplit: PeriodSplit,
  runId: number,
  enabled_stages?: number[] | null,
) {
  const supabase = getSupabase();
  let stopRequested = false;

  try {
    // Update status to running
    await supabase.from('optimization_runs').update({ status: 'running' }).eq('id', runId);

    const result = await runSmartOptimization(
      symbolsData,
      config,
      periodSplit,
      // Progress callback — update DB every call
      async (progress) => {
        try {
          await supabase.from('optimization_runs').update({
            current_stage: progress.currentStage,
            total_stages: progress.totalStages,
            current_combo: progress.current,
            total_combos: progress.total,
            best_train: progress.bestReturn ?? null,
            best_test: progress.bestTestReturn ?? null,
          }).eq('id', runId);

          // Log to optimization_run_logs
          await supabase.from('optimization_run_logs').insert({
            run_id: runId,
            symbol: symbolsData[0]?.symbol ?? null,
            stage_number: progress.currentStage,
            stage_name: progress.stageName,
            current_combo: progress.current,
            total_combos: progress.total,
            message: `Stage ${progress.currentStage}/${progress.totalStages}: ${progress.stageName} — combo ${progress.current}/${progress.total}`,
            heap_used_mb: process.memoryUsage ? Math.round(process.memoryUsage().heapUsed / 1048576 * 10) / 10 : null,
            heap_total_mb: process.memoryUsage ? Math.round(process.memoryUsage().heapTotal / 1048576 * 10) / 10 : null,
          });
        } catch (e: any) {
          console.warn(`[runId=${runId}] Progress update failed:`, e.message);
        }
      },
      // shouldStop callback
      async () => {
        if (stopRequested) return true;
        try {
          const { data } = await supabase.from('optimization_runs').select('status').eq('id', runId).single();
          if (data?.status === 'cancelled') {
            stopRequested = true;
            return true;
          }
        } catch { /* ignore */ }
        return false;
      },
      enabled_stages ?? undefined,
    );

    // Save final result
    const bestResult = result.finalResult.bestForProfit;
    if (bestResult) {
      // Insert optimization_results
      const { data: resultRow } = await supabase.from('optimization_results').insert({
        symbol: symbolsData[0].symbol,
        parameters: bestResult.parameters as any,
        train_return: bestResult.totalTrainReturn,
        test_return: bestResult.totalTestReturn,
        win_rate: bestResult.trainResults?.[0]?.result?.winRate ?? 0,
        total_trades: bestResult.trainResults?.[0]?.result?.totalTrades ?? 0,
        sharpe_ratio: bestResult.trainResults?.[0]?.result?.sharpeRatio ?? 0,
        max_drawdown: bestResult.trainResults?.[0]?.result?.maxDrawdown ?? 0,
        is_active: true,
      }).select('id').single();

      // Insert trades if result row was created
      if (resultRow?.id) {
        const allTrades = [
          ...(bestResult.trainResults?.[0]?.result?.trades ?? []),
          ...(bestResult.testResults?.[0]?.result?.trades ?? []),
        ];
        if (allTrades.length > 0) {
          const tradeBatch = allTrades.map(t => ({
            optimization_result_id: resultRow.id,
            symbol: symbolsData[0].symbol,
            direction: t.direction || 'long',
            entry_price: t.entryPrice,
            entry_time: new Date(t.entryTime).toISOString(),
            exit_price: t.exitPrice ?? null,
            exit_time: t.exitTime ? new Date(t.exitTime).toISOString() : null,
            pnl_pct: t.pnlPct ?? 0,
            bars_held: t.barsHeld ?? 0,
            exit_reason: t.exitReason ?? null,
            strategy: t.strategy ?? null,
          }));
          // Insert in batches of 500
          for (let i = 0; i < tradeBatch.length; i += 500) {
            await supabase.from('optimization_trades').insert(tradeBatch.slice(i, i + 500));
          }
        }
      }

      await supabase.from('optimization_runs').update({
        status: 'completed',
        best_train: bestResult.totalTrainReturn,
        best_test: bestResult.totalTestReturn,
      }).eq('id', runId);

      console.log(`[runId=${runId}] Completed! Train=${bestResult.totalTrainReturn?.toFixed(2)}% Test=${bestResult.totalTestReturn?.toFixed(2)}%`);
    } else {
      await supabase.from('optimization_runs').update({
        status: 'completed',
        error_message: 'No valid result found',
      }).eq('id', runId);
    }
  } catch (err: any) {
    console.error(`[runId=${runId}] Optimization failed:`, err);
    await supabase.from('optimization_runs').update({
      status: 'failed',
      error_message: err.message?.slice(0, 500) ?? 'Unknown error',
    }).eq('id', runId);
  }
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[${OPTIMIZER_BUILD}] Optimizer server listening on port ${PORT}`);
});

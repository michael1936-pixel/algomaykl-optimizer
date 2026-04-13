import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { runSmartOptimization, SmartProgressInfo, OPTIMIZER_BUILD } from './lib/optimizer/smartOptimizer';
import { NNE_PRESET_CONFIG } from './lib/optimizer/presetConfigs';
import type { SymbolData, PeriodSplit, ExtendedStocksOptimizationConfig, Trade } from './lib/optimizer/types';

const app = express();
app.use(express.json({ limit: '200mb' }));

const PORT = Number(process.env.PORT) || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', build: OPTIMIZER_BUILD, timestamp: new Date().toISOString() });
});

app.post('/api/optimize', async (req, res) => {
  const { runId, symbolsData, periodSplit: rawSplit, enabledStages } = req.body;

  if (!runId || !symbolsData || !rawSplit) {
    return res.status(400).json({ error: 'Missing runId, symbolsData, or periodSplit' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const periodSplit: PeriodSplit = {
    trainStartDate: new Date(rawSplit.trainStartDate),
    trainEndDate: new Date(rawSplit.trainEndDate),
    testStartDate: new Date(rawSplit.testStartDate),
    testEndDate: new Date(rawSplit.testEndDate),
    trainPercent: rawSplit.trainPercent,
  };

  // Mark run as running
  await supabase.from('optimization_runs').update({
    status: 'running',
    updated_at: new Date().toISOString(),
  }).eq('id', runId);

  res.json({ status: 'started', runId, build: OPTIMIZER_BUILD });

  // Run optimization in background
  try {
    const config = NNE_PRESET_CONFIG as ExtendedStocksOptimizationConfig;
    let lastProgressUpdate = 0;

    const result = await runSmartOptimization(
      symbolsData,
      config,
      periodSplit,
      'single',
      {},
      async (info: SmartProgressInfo) => {
        const now = Date.now();
        if (now - lastProgressUpdate < 3000 && info.current < info.total) return;
        lastProgressUpdate = now;

        await supabase.from('optimization_runs').update({
          current_stage: info.currentStage,
          total_stages: info.totalStages,
          current_combo: info.current,
          total_combos: info.total,
          best_train: info.bestReturn ?? null,
          best_test: info.bestTestReturn ?? null,
          updated_at: new Date().toISOString(),
        }).eq('id', runId);
      },
      undefined, // abortSignal
      false,
      'profit',
      true,
      true,
      enabledStages,
      undefined, undefined, undefined,
      4, 10, 1,
      async () => {
        const { data } = await supabase
          .from('optimization_runs')
          .select('status')
          .eq('id', runId)
          .single();
        return data?.status === 'cancelled';
      },
    );

    // Save final result
    const finalResult = result.finalResult?.bestForProfit;
    if (finalResult) {
      const params = finalResult.parameters;
      const trainResult = finalResult.trainResults?.[0]?.result;
      const testResult = finalResult.testResults?.[0]?.result;

      const { data: optResult } = await supabase.from('optimization_results').insert({
        symbol: symbolsData[0]?.symbol || 'UNKNOWN',
        parameters: params as any,
        train_return: finalResult.totalTrainReturn,
        test_return: finalResult.totalTestReturn,
        win_rate: trainResult?.winRate ?? null,
        max_drawdown: trainResult?.maxDrawdown ?? null,
        sharpe_ratio: trainResult?.sharpeRatio ?? null,
        total_trades: trainResult?.totalTrades ?? null,
        is_active: true,
        optimized_at: new Date().toISOString(),
      }).select('id').single();

      // Save trades
      if (optResult?.id && trainResult?.trades) {
        const allTrades = [
          ...trainResult.trades.map((t: Trade) => ({ ...t, phase: 'train' })),
          ...(testResult?.trades || []).map((t: Trade) => ({ ...t, phase: 'test' })),
        ];

        const tradeBatch = allTrades.slice(0, 500).map((t: Trade & { phase: string }) => ({
          optimization_result_id: optResult.id,
          symbol: symbolsData[0]?.symbol || 'UNKNOWN',
          direction: t.type,
          entry_price: t.entryPrice,
          entry_time: new Date(t.entryTime).toISOString(),
          exit_price: t.exitPrice ?? null,
          exit_time: t.exitTime ? new Date(t.exitTime).toISOString() : null,
          exit_reason: t.exitReason ?? null,
          pnl_pct: t.pnlPct ?? null,
          bars_held: t.barsInTrade ?? null,
          strategy: t.entryStrategyId != null ? `S${t.entryStrategyId}` : null,
        }));

        if (tradeBatch.length > 0) {
          await supabase.from('optimization_trades').insert(tradeBatch);
        }
      }
    }

    await supabase.from('optimization_runs').update({
      status: result.wasStopped ? 'cancelled' : 'completed',
      updated_at: new Date().toISOString(),
    }).eq('id', runId);

    console.log(`✅ Optimization ${runId} completed. Build: ${OPTIMIZER_BUILD}`);
  } catch (error: any) {
    console.error(`❌ Optimization ${runId} failed:`, error.message);
    await supabase.from('optimization_runs').update({
      status: 'failed',
      error_message: error.message?.slice(0, 500),
      updated_at: new Date().toISOString(),
    }).eq('id', runId);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Railway Optimizer listening on port ${PORT} | Build: ${OPTIMIZER_BUILD}`);
});

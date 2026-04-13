import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { runSmartOptimization, OPTIMIZER_BUILD } from './lib/optimizer/smartOptimizer';
import type { SymbolData, PeriodSplit, ExtendedStocksOptimizationConfig } from './lib/optimizer/types';

const app = express();
app.use(cors());
app.use(express.json({ limit: '200mb' }));

const PORT = parseInt(process.env.PORT || '3000', 10);
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('Supabase not configured — progress updates disabled');
    return null;
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

// ─── Health ───
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    build: OPTIMIZER_BUILD,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString(),
  });
});

// ─── Optimize ───
app.post('/api/optimize', async (req, res) => {
  const { symbolsData, config, periodSplit, runId, simulationConfig, mode } = req.body;

  if (!symbolsData || !config || !periodSplit) {
    return res.status(400).json({ error: 'Missing symbolsData, config, or periodSplit' });
  }

  console.log(`\n════ Optimization request ════`);
  console.log(`Build: ${OPTIMIZER_BUILD}`);
  console.log(`RunID: ${runId || 'none'}`);
  console.log(`Symbols: ${(symbolsData as SymbolData[]).map((s: SymbolData) => `${s.symbol}(${s.candles.length})`).join(', ')}`);

  const supabase = getSupabase();
  let lastUpdateTime = 0;

  // Reconstruct Date objects from ISO strings
  const ps: PeriodSplit = {
    ...periodSplit,
    trainStartDate: new Date(periodSplit.trainStartDate),
    trainEndDate: new Date(periodSplit.trainEndDate),
    testStartDate: new Date(periodSplit.testStartDate),
    testEndDate: new Date(periodSplit.testEndDate),
  };

  // Set run to running
  if (supabase && runId) {
    await supabase.from('optimization_runs').update({
      status: 'running',
      current_stage: 1,
    }).eq('id', runId);
  }

  // Abort check: query DB for cancellation
  const abortCheckFn = supabase && runId ? async (): Promise<boolean> => {
    try {
      const { data } = await supabase.from('optimization_runs').select('status').eq('id', runId).single();
      return data?.status === 'cancelled';
    } catch { return false; }
  } : undefined;

  try {
    const result = await runSmartOptimization(
      symbolsData as SymbolData[],
      config as ExtendedStocksOptimizationConfig,
      ps,
      mode || 'single',
      simulationConfig || {},
      // onProgress
      async (info) => {
        const now = Date.now();
        if (now - lastUpdateTime < 3000) return; // throttle to 3s
        lastUpdateTime = now;

        if (supabase && runId) {
          await supabase.from('optimization_runs').update({
            current_stage: info.currentStage || 1,
            total_stages: info.totalStages || 30,
            current_combo: info.current || 0,
            total_combos: info.total || 0,
            best_train: info.bestReturn ?? null,
            best_test: info.bestTestReturn ?? null,
          }).eq('id', runId);
        }
      },
      undefined, // abortSignal (not used server-side)
      false, // useMemory
      'profit',
      true, // enableRound2
      true, // enableRound3
      undefined, // enabledStages
      undefined, // onSkipStageCallback
      undefined, // onSaveState
      undefined, // savedState
      4, // round1StepMultiplier
      10, // numGoodZones
      1, // zoneExpansionSteps
      abortCheckFn,
    );

    // Save final result
    if (supabase && runId) {
      const best = result.finalResult.bestForProfit;
      await supabase.from('optimization_runs').update({
        status: 'completed',
        best_train: best?.totalTrainReturn ?? null,
        best_test: best?.totalTestReturn ?? null,
      }).eq('id', runId);

      // Save to optimization_results
      if (best) {
        const params = best.parameters;
        const trainResult = best.trainResults?.[0]?.result;
        await supabase.from('optimization_results').insert({
          symbol: (symbolsData as SymbolData[])[0]?.symbol || 'UNKNOWN',
          parameters: params as any,
          train_return: best.totalTrainReturn,
          test_return: best.totalTestReturn,
          win_rate: trainResult?.winRate ?? null,
          max_drawdown: trainResult?.maxDrawdown ?? null,
          sharpe_ratio: trainResult?.sharpeRatio ?? null,
          total_trades: trainResult?.totalTrades ?? null,
          is_active: true,
          optimized_at: new Date().toISOString(),
        });
      }
    }

    console.log(`✓ Optimization complete. Train: ${result.finalResult.bestForProfit?.totalTrainReturn?.toFixed(2)}% Test: ${result.finalResult.bestForProfit?.totalTestReturn?.toFixed(2)}%`);
    res.json({ success: true, result: result.finalResult, stageResults: result.stageResults });
  } catch (error: any) {
    console.error('Optimization error:', error.message);
    if (supabase && runId) {
      await supabase.from('optimization_runs').update({
        status: 'failed',
        error_message: error.message?.slice(0, 500),
      }).eq('id', runId);
    }
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Optimizer server running on port ${PORT}`);
  console.log(`   Build: ${OPTIMIZER_BUILD}`);
  console.log(`   Supabase: ${SUPABASE_URL ? 'configured' : 'NOT configured'}`);
});

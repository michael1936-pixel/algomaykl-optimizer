import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { runSmartOptimization, OPTIMIZER_BUILD } from './optimizer/smartOptimizer';
import type { SmartProgressInfo } from './optimizer/smartOptimizer';
import { NNE_PRESET_CONFIG } from './optimizer/presetConfigs';
import type { SymbolData, PeriodSplit, ExtendedStocksOptimizationConfig } from './optimizer/types';

const app = express();
app.use(cors());
app.use(express.json({ limit: '200mb' }));

const PORT = Number(process.env.PORT) || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', build: OPTIMIZER_BUILD, timestamp: new Date().toISOString() });
});

app.post('/api/optimize', async (req, res) => {
  const { runId, symbolsData: rawSymbolsData, periodSplit: rawSplit, config: userConfig, mode, enabled_stages } = req.body;

  if (!runId || !rawSymbolsData || !rawSplit) {
    return res.status(400).json({ error: 'Missing runId, symbolsData, or periodSplit' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  await supabase.from('optimization_runs').update({ status: 'running' }).eq('id', runId);
  res.json({ accepted: true, runId, build: OPTIMIZER_BUILD });

  try {
    // Edge function already sends parsed candles with timestamps as numbers
    const symbolsData: SymbolData[] = rawSymbolsData.map((raw: any) => {
      const candles = raw.candles || [];
      const timestamps = candles.map((c: any) => c.timestamp);
      const minTs = Math.min(...timestamps);
      const maxTs = Math.max(...timestamps);
      return {
        symbol: raw.symbol,
        candles,
        startDate: new Date(minTs),
        endDate: new Date(maxTs),
      };
    });

    const periodSplit: PeriodSplit = {
      trainStartDate: new Date(rawSplit.trainStartDate),
      trainEndDate: new Date(rawSplit.trainEndDate),
      testStartDate: new Date(rawSplit.testStartDate),
      testEndDate: new Date(rawSplit.testEndDate),
      trainPercent: rawSplit.trainPercent,
    };

    const config = (userConfig || NNE_PRESET_CONFIG) as ExtendedStocksOptimizationConfig;
    let lastUpdate = 0;

    const result = await runSmartOptimization(
      symbolsData,
      config,
      periodSplit,
      mode || 'single',
      {},
      async (info: SmartProgressInfo) => {
        const now = Date.now();
        if (now - lastUpdate < 2000 && info.current < info.total) return;
        lastUpdate = now;
        await supabase.from('optimization_runs').update({
          current_stage: info.currentStage,
          total_stages: info.totalStages,
          current_combo: info.current,
          total_combos: info.total,
          best_train: info.bestReturn ?? null,
          best_test: info.bestTestReturn ?? null,
        }).eq('id', runId);
      },
      undefined,
      false,
      'profit',
      true,
      true,
      enabled_stages,
    );

    const best = result.finalResult?.bestForProfit;
    await supabase.from('optimization_runs').update({
      status: 'completed',
      best_train: best?.totalTrainReturn ?? null,
      best_test: best?.totalTestReturn ?? null,
      current_stage: result.stageResults?.length ?? 0,
      total_stages: result.stageResults?.length ?? 0,
      current_combo: 1,
      total_combos: 1,
    }).eq('id', runId);

    if (best) {
      const symbols = symbolsData.map((s: SymbolData) => s.symbol);
      await supabase.from('optimization_results').insert({
        symbol: symbols.join(','),
        parameters: best.parameters as any,
        train_return: best.totalTrainReturn,
        test_return: best.totalTestReturn,
        is_active: true,
      });
    }

    console.log(`✅ [Run ${runId}] Done. Train: ${best?.totalTrainReturn?.toFixed(2)}% Test: ${best?.totalTestReturn?.toFixed(2)}%`);
  } catch (err: any) {
    console.error(`🔴 [Run ${runId}] Error:`, err);
    await supabase.from('optimization_runs').update({
      status: 'failed',
      error_message: err.message || String(err),
    }).eq('id', runId);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Optimizer server v${OPTIMIZER_BUILD} listening on port ${PORT}`);
});

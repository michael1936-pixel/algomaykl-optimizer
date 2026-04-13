import express from 'express';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = parseInt(process.env.PORT || '3000');
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Health check
app.get('/health', (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: 'ok',
    version: 'v14-no-cleanup',
    heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
    rssMB: Math.round(mem.rss / 1024 / 1024),
  });
});

// Import optimizer
import { runSmartOptimization, getOptimizationStages } from './optimizer/smartOptimizer';
import { NNE_PRESET_CONFIG } from './optimizer/presetConfigs';
import type { SymbolData, PeriodSplit, Candle } from './optimizer/types';

app.get('/api/stages', (_req, res) => {
  res.json(getOptimizationStages());
});

interface OptimizeRequest {
  symbols: string[];
  run_ids: number[];
  enabled_stages?: boolean[];
  round1_step_multiplier?: number;
  num_good_zones?: number;
  zone_expansion_steps?: number;
  train_pct?: number;
}

app.post('/api/optimize', async (req, res) => {
  const body = req.body as OptimizeRequest;
  const { symbols, run_ids, enabled_stages, round1_step_multiplier, num_good_zones, zone_expansion_steps, train_pct } = body;

  if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
    return res.status(400).json({ error: 'symbols array required' });
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`OPTIMIZE REQUEST: ${symbols.join(', ')}`);
  console.log(`Run IDs: ${run_ids?.join(', ') || 'none'}`);
  console.log(`${'='.repeat(60)}\n`);

  // Respond immediately — run in background
  res.json({ status: 'started', symbols, run_ids });

  // Run optimization for each symbol
  for (let si = 0; si < symbols.length; si++) {
    const symbol = symbols[si];
    const runId = run_ids?.[si];

    try {
      if (runId) {
        await supabase.from('optimization_runs').update({ status: 'running', current_stage: 0 }).eq('id', runId);
      }

      // Download market data
      console.log(`📥 Downloading data for ${symbol}...`);
      const { data: marketData, error: mdError } = await supabase
        .from('market_data')
        .select('*')
        .eq('symbol', symbol)
        .order('timestamp', { ascending: true })
        .limit(10000);

      if (mdError || !marketData || marketData.length === 0) {
        console.error(`No data for ${symbol}: ${mdError?.message || 'empty'}`);
        if (runId) await supabase.from('optimization_runs').update({ status: 'failed', error_message: `No market data: ${mdError?.message || 'empty'}` }).eq('id', runId);
        continue;
      }

      console.log(`📊 ${symbol}: ${marketData.length} candles loaded`);

      const candles: Candle[] = marketData.map((d: any) => ({
        timestamp: new Date(d.timestamp).getTime(),
        open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume || 0,
      }));

      const symbolData: SymbolData[] = [{
        symbol,
        candles,
        startDate: new Date(candles[0].timestamp),
        endDate: new Date(candles[candles.length - 1].timestamp),
      }];

      // Train/test split
      const trainPct = train_pct || 70;
      const totalBars = candles.length;
      const trainEnd = Math.floor(totalBars * trainPct / 100);
      const periodSplit: PeriodSplit = {
        trainStartDate: new Date(candles[0].timestamp),
        trainEndDate: new Date(candles[trainEnd - 1].timestamp),
        testStartDate: new Date(candles[trainEnd].timestamp),
        testEndDate: new Date(candles[candles.length - 1].timestamp),
        trainPercent: trainPct,
      };

      const simConfig = {
        capital_start: 10000,
        enable_commissions: true,
        commission_per_share_cent: 1.0,
        min_commission_side_usd: 2.5,
        slippage_pct_side: 0.10,
        leverage_mode: 'ללא מינוף',
        leverage: 1,
        enable_overnight_fee: true,
        overnight_fee_pct: 0.0393,
      };

      // Progress updater — throttled
      let lastProgressUpdate = 0;
      const PROGRESS_INTERVAL = 3000;

      const onProgress = async (info: any) => {
        const now = Date.now();
        if (now - lastProgressUpdate < PROGRESS_INTERVAL) return;
        lastProgressUpdate = now;

        if (runId) {
          const mem = process.memoryUsage();
          await supabase.from('optimization_runs').update({
            current_stage: info.currentStage || 0,
            total_stages: info.totalStages || 30,
            current_combo: info.current || 0,
            total_combos: info.total || 0,
            best_train: info.bestReturn || null,
            best_test: info.bestTestReturn || null,
          }).eq('id', runId);

          // Log entry
          await supabase.from('optimization_run_logs').insert({
            run_id: runId,
            symbol,
            stage_number: info.currentStage || 0,
            stage_name: info.stageName || '',
            current_combo: info.current || 0,
            total_combos: info.total || 0,
            message: `Stage ${info.currentStage}/${info.totalStages}: ${info.stageName} - ${info.current}/${info.total} combos`,
            heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
            heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
          });
        }
      };

      console.log(`🚀 Starting optimization for ${symbol}...`);
      const startTime = Date.now();

      const result = await runSmartOptimization(
        symbolData,
        NNE_PRESET_CONFIG,
        periodSplit,
        'single',
        simConfig,
        onProgress,
        undefined,
        false,
        'profit',
        true,
        true,
        enabled_stages,
        undefined, undefined, undefined,
        round1_step_multiplier || 4,
        num_good_zones || 10,
        zone_expansion_steps || 1,
      );

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`\n✅ ${symbol} completed in ${elapsed}s`);

      // Save results
      if (result.finalResult.bestForProfit) {
        const best = result.finalResult.bestForProfit;
        const params = best.parameters;

        const { data: savedResult, error: saveErr } = await supabase.from('optimization_results').insert({
          symbol,
          parameters: params as any,
          train_return: best.totalTrainReturn,
          test_return: best.totalTestReturn,
          max_drawdown: best.trainResults?.[0]?.result?.maxDrawdown || null,
          win_rate: best.trainResults?.[0]?.result?.winRate || null,
          total_trades: best.trainResults?.[0]?.result?.totalTrades || null,
          sharpe_ratio: best.trainResults?.[0]?.result?.sharpeRatio || null,
          overfit_risk: best.overfit > 50 ? 'high' : best.overfit > 25 ? 'medium' : 'low',
          is_active: true,
          optimized_at: new Date().toISOString(),
        }).select('id').single();

        if (saveErr) {
          console.error(`Failed to save results for ${symbol}:`, saveErr.message);
        } else {
          console.log(`💾 Saved optimization result #${savedResult?.id} for ${symbol}`);

          // Save trades
          const trades = best.trainResults?.[0]?.result?.trades || [];
          if (trades.length > 0 && savedResult?.id) {
            const tradesToInsert = trades.slice(0, 500).map((t: any) => ({
              optimization_result_id: savedResult.id,
              symbol,
              direction: t.type || 'long',
              entry_price: t.entryPrice,
              entry_time: new Date(t.entryTime).toISOString(),
              exit_price: t.exitPrice || null,
              exit_time: t.exitTime ? new Date(t.exitTime).toISOString() : null,
              pnl_pct: t.pnlPct || null,
              exit_reason: t.exitReason || null,
              bars_held: t.barsInTrade || (t.exitBarIndex && t.entryBarIndex ? t.exitBarIndex - t.entryBarIndex : null),
              strategy: t.entryStrategyId ? `S${t.entryStrategyId}` : null,
            }));

            const { error: tradeErr } = await supabase.from('optimization_trades').insert(tradesToInsert);
            if (tradeErr) console.error(`Failed to save trades:`, tradeErr.message);
            else console.log(`💾 Saved ${tradesToInsert.length} trades`);
          }
        }
      }

      if (runId) {
        await supabase.from('optimization_runs').update({
          status: 'completed',
          current_stage: 30,
          best_train: result.finalResult.bestForProfit?.totalTrainReturn || null,
          best_test: result.finalResult.bestForProfit?.totalTestReturn || null,
        }).eq('id', runId);
      }

    } catch (err: any) {
      console.error(`❌ ${symbol} failed:`, err.message);
      if (runId) {
        await supabase.from('optimization_runs').update({
          status: 'failed',
          error_message: err.message?.slice(0, 500),
        }).eq('id', runId);
      }
    }
  }
});

app.listen(PORT, () => {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  AlgoMaykl Optimizer Server v14`);
  console.log(`  Port: ${PORT}`);
  console.log(`  Node: ${process.version}`);
  console.log(`  Memory limit: ${process.env.NODE_OPTIONS || 'default'}`);
  const mem = process.memoryUsage();
  console.log(`  Heap: ${Math.round(mem.heapUsed / 1024 / 1024)}MB / ${Math.round(mem.heapTotal / 1024 / 1024)}MB`);
  console.log(`${'═'.repeat(50)}\n`);
});

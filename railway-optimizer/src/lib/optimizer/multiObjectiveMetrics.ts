import type {
  PortfolioOptimizationResult,
  MultiObjectiveResult,
  ObjectiveType,
  ConsistencyMetrics,
  MonthlyPerformance
} from './types';

function calculateLinearRegression(returns: number[]): { slope: number; intercept: number } {
  const n = returns.length;
  if (n === 0) return { slope: 0, intercept: 0 };
  const xMean = (n - 1) / 2;
  const yMean = returns.reduce((sum, r) => sum + r, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    const xDiff = i - xMean;
    numerator += xDiff * (returns[i] - yMean);
    denominator += xDiff * xDiff;
  }
  const slope = denominator !== 0 ? numerator / denominator : 0;
  const intercept = yMean - slope * xMean;
  return { slope, intercept };
}

function calculateRSquared(returns: number[], slope: number, intercept: number): number {
  const n = returns.length;
  if (n === 0) return 0;
  const yMean = returns.reduce((sum, r) => sum + r, 0) / n;
  let ssTotal = 0;
  let ssResidual = 0;
  for (let i = 0; i < n; i++) {
    const yPredicted = slope * i + intercept;
    ssTotal += Math.pow(returns[i] - yMean, 2);
    ssResidual += Math.pow(returns[i] - yPredicted, 2);
  }
  return ssTotal !== 0 ? 1 - (ssResidual / ssTotal) : 0;
}

export function calculateConsistencyMetrics(monthlyPerformance: MonthlyPerformance[]): ConsistencyMetrics {
  if (!monthlyPerformance || monthlyPerformance.length === 0) {
    return { monthlyReturnStdDev: 0, monthlyReturnMean: 0, coefficientOfVariation: 0, consistencyScore: 0, slope: 0, rSquared: 0, positiveMonthsRatio: 0 };
  }
  const returns = monthlyPerformance.map(m => m.returnPct);
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  const coefficientOfVariation = mean !== 0 ? Math.abs(stdDev / mean) : 999;
  const { slope, intercept } = calculateLinearRegression(returns);
  const rSquared = calculateRSquared(returns, slope, intercept);
  const positiveMonths = returns.filter(r => r > 0).length;
  const positiveMonthsRatio = returns.length > 0 ? positiveMonths / returns.length : 0;
  const consistencyScore = slope > 0 ? slope * rSquared * positiveMonthsRatio : 0;
  return { monthlyReturnStdDev: stdDev, monthlyReturnMean: mean, coefficientOfVariation, consistencyScore, slope, rSquared, positiveMonthsRatio };
}

export function getMaxDrawdown(result: PortfolioOptimizationResult): number {
  let maxDrawdown = 0;
  for (const sr of result.trainResults) { if (sr.result.maxDrawdown > maxDrawdown) maxDrawdown = sr.result.maxDrawdown; }
  for (const sr of result.testResults) { if (sr.result.maxDrawdown > maxDrawdown) maxDrawdown = sr.result.maxDrawdown; }
  return maxDrawdown;
}

export function compareForProfit(current: PortfolioOptimizationResult | null, candidate: PortfolioOptimizationResult): boolean {
  if (!current) return true;
  return ((candidate.totalTrainReturn + candidate.totalTestReturn) / 2) > ((current.totalTrainReturn + current.totalTestReturn) / 2);
}

export function compareForConsistency(current: PortfolioOptimizationResult | null, _candidate: PortfolioOptimizationResult, currentMetrics?: ConsistencyMetrics, candidateMetrics?: ConsistencyMetrics): boolean {
  if (!current) return true;
  return (candidateMetrics?.consistencyScore || 0) > (currentMetrics?.consistencyScore || 0);
}

export function compareForLowDrawdown(current: PortfolioOptimizationResult | null, candidate: PortfolioOptimizationResult): boolean {
  if (!current) return true;
  return getMaxDrawdown(candidate) < getMaxDrawdown(current);
}

export function compareForTestPeriod(current: PortfolioOptimizationResult | null, candidate: PortfolioOptimizationResult): boolean {
  if (!current) return true;
  return candidate.totalTestReturn > current.totalTestReturn;
}

export function createEmptyMultiObjectiveResult(selectedObjective: ObjectiveType = 'profit'): MultiObjectiveResult {
  return { bestForProfit: null, bestForConsistency: null, bestForLowDrawdown: null, bestForTestPeriod: null, selectedObjective, consistencyMetrics: {} };
}

export function updateMultiObjectiveResult(multiResult: MultiObjectiveResult, candidate: PortfolioOptimizationResult): MultiObjectiveResult {
  const candidateConsistencyMetrics = calculateConsistencyMetrics(candidate.monthlyPerformance);
  const updated: MultiObjectiveResult = { ...multiResult, consistencyMetrics: multiResult.consistencyMetrics || {} };
  if (compareForProfit(multiResult.bestForProfit, candidate)) { updated.bestForProfit = candidate; updated.consistencyMetrics!.profit = candidateConsistencyMetrics; }
  if (compareForConsistency(multiResult.bestForConsistency, candidate, multiResult.consistencyMetrics?.consistency, candidateConsistencyMetrics)) { updated.bestForConsistency = candidate; updated.consistencyMetrics!.consistency = candidateConsistencyMetrics; }
  if (compareForLowDrawdown(multiResult.bestForLowDrawdown, candidate)) { updated.bestForLowDrawdown = candidate; updated.consistencyMetrics!.lowDrawdown = candidateConsistencyMetrics; }
  if (compareForTestPeriod(multiResult.bestForTestPeriod, candidate)) { updated.bestForTestPeriod = candidate; updated.consistencyMetrics!.testPeriod = candidateConsistencyMetrics; }
  return updated;
}

export function evaluateObjective(result: PortfolioOptimizationResult, objective: ObjectiveType): number {
  switch (objective) {
    case 'profit': return (result.totalTrainReturn + result.totalTestReturn) / 2;
    case 'consistency': return calculateConsistencyMetrics(result.monthlyPerformance).consistencyScore;
    case 'lowDrawdown': return -Math.abs(getMaxDrawdown(result));
    case 'testPeriod': return result.totalTestReturn;
    default: return (result.totalTrainReturn + result.totalTestReturn) / 2;
  }
}

export function compareByObjective(current: PortfolioOptimizationResult | null, candidate: PortfolioOptimizationResult, objective: ObjectiveType): boolean {
  if (!current) return true;
  return evaluateObjective(candidate, objective) > evaluateObjective(current, objective);
}

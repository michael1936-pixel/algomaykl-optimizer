export function calculateSMA(data: number[], period: number): number[] {
  const sma: number[] = [];
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += data[j];
    }
    sma.push(sum / period);
  }
  return sma;
}

export function calculateEMA(data: number[], period: number): number[] {
  const ema: number[] = [];
  if (data.length < period) return ema;
  const multiplier = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) { sum += data[i]; }
  ema.push(sum / period);
  for (let i = period; i < data.length; i++) {
    ema.push((data[i] - ema[ema.length - 1]) * multiplier + ema[ema.length - 1]);
  }
  return ema;
}

export function calculateATR(highs: number[], lows: number[], closes: number[], period: number = 14): number[] {
  const atr: number[] = [];
  if (highs.length < period + 1) return atr;
  const tr: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const highLow = highs[i] - lows[i];
    const highClose = Math.abs(highs[i] - closes[i - 1]);
    const lowClose = Math.abs(lows[i] - closes[i - 1]);
    tr.push(Math.max(highLow, highClose, lowClose));
  }
  let sum = 0;
  for (let i = 0; i < period; i++) { sum += tr[i]; }
  atr.push(sum / period);
  for (let i = period; i < tr.length; i++) {
    atr.push((atr[atr.length - 1] * (period - 1) + tr[i]) / period);
  }
  return atr;
}

export function calculateBB(data: number[], period: number = 20, stdDev: number = 2): { basis: number[], upper: number[], lower: number[] } {
  const basis = calculateSMA(data, period);
  const upper: number[] = [];
  const lower: number[] = [];
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += Math.pow(data[j] - basis[i - period + 1], 2);
    }
    const std = Math.sqrt(sum / period);
    upper.push(basis[i - period + 1] + stdDev * std);
    lower.push(basis[i - period + 1] - stdDev * std);
  }
  return { basis, upper, lower };
}

export function calculateBBPine(data: number[], period: number = 20, mult: number = 2): { basis: number[], upper: number[], lower: number[] } {
  const basis: number[] = [];
  const upper: number[] = [];
  const lower: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { basis.push(NaN); upper.push(NaN); lower.push(NaN); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) { sum += data[j]; }
    const sma = sum / period;
    basis.push(sma);
    let sqSum = 0;
    for (let j = i - period + 1; j <= i; j++) { sqSum += Math.pow(data[j] - sma, 2); }
    const stdev = Math.sqrt(sqSum / period);
    upper.push(sma + mult * stdev);
    lower.push(sma - mult * stdev);
  }
  return { basis, upper, lower };
}

export function calculateADX(highs: number[], lows: number[], closes: number[], period: number = 14): number[] {
  if (highs.length < period + 1) return [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const tr: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    const highLow = highs[i] - lows[i];
    const highClose = Math.abs(highs[i] - closes[i - 1]);
    const lowClose = Math.abs(lows[i] - closes[i - 1]);
    tr.push(Math.max(highLow, highClose, lowClose));
  }
  let smoothPlusDM = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothMinusDM = minusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothTR = tr.slice(0, period).reduce((a, b) => a + b, 0);
  const plusDI: number[] = [100 * smoothPlusDM / smoothTR];
  const minusDI: number[] = [100 * smoothMinusDM / smoothTR];
  const adx: number[] = [];
  for (let i = period; i < plusDM.length; i++) {
    smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDM[i];
    smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDM[i];
    smoothTR = smoothTR - smoothTR / period + tr[i];
    const pdi = 100 * smoothPlusDM / smoothTR;
    const mdi = 100 * smoothMinusDM / smoothTR;
    plusDI.push(pdi);
    minusDI.push(mdi);
  }
  const dx: number[] = [];
  for (let i = 0; i < plusDI.length; i++) {
    const sum = plusDI[i] + minusDI[i];
    dx.push(sum === 0 ? 0 : 100 * Math.abs(plusDI[i] - minusDI[i]) / sum);
  }
  let adxSum = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  adx.push(adxSum);
  for (let i = period; i < dx.length; i++) {
    adxSum = (adxSum * (period - 1) + dx[i]) / period;
    adx.push(adxSum);
  }
  return adx;
}

export function calculateRMA(data: number[], period: number): number[] {
  const rma: number[] = [];
  if (data.length < period) return rma;
  let sum = 0;
  for (let i = 0; i < period; i++) { sum += data[i]; }
  rma.push(sum / period);
  for (let i = period; i < data.length; i++) {
    rma.push((rma[rma.length - 1] * (period - 1) + data[i]) / period);
  }
  return rma;
}

export function calculateRSI(closes: number[], period: number = 14): number[] {
  const rsi: number[] = [];
  if (closes.length < period + 1) return rsi;
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? -change : 0);
  }
  const rmaGains = calculateRMA(gains, period);
  const rmaLosses = calculateRMA(losses, period);
  for (let i = 0; i < rmaGains.length; i++) {
    if (rmaLosses[i] === 0) { rsi.push(100); }
    else { const rs = rmaGains[i] / rmaLosses[i]; rsi.push(100 - (100 / (1 + rs))); }
  }
  return rsi;
}

export function calculateVolumeAverage(volumes: number[], period: number): number[] {
  return calculateSMA(volumes, period);
}

export function highest(data: number[], period: number, endIndex: number): number {
  const startIndex = Math.max(0, endIndex - period + 1);
  let max = data[startIndex];
  for (let i = startIndex + 1; i <= endIndex; i++) { if (data[i] > max) max = data[i]; }
  return max;
}

export function lowest(data: number[], period: number, endIndex: number): number {
  const startIndex = Math.max(0, endIndex - period + 1);
  let min = data[startIndex];
  for (let i = startIndex + 1; i <= endIndex; i++) { if (data[i] < min) min = data[i]; }
  return min;
}

export function calculateRMAPine(data: number[], period: number): number[] {
  const result: number[] = new Array(data.length).fill(NaN);
  const alpha = 1 / period;
  let start = 0;
  while (start < data.length && isNaN(data[start])) { start++; }
  if (start + period > data.length) return result;
  let sum = 0;
  for (let i = start; i < start + period; i++) { sum += data[i]; }
  const seedIndex = start + period - 1;
  result[seedIndex] = sum / period;
  for (let i = seedIndex + 1; i < data.length; i++) {
    result[i] = result[i - 1] * (1 - alpha) + data[i] * alpha;
  }
  return result;
}

export function calculateADXPine(highs: number[], lows: number[], closes: number[], period: number = 14): number[] {
  const len = highs.length;
  if (len < period + 1) return new Array(len).fill(NaN);
  const plusDM: number[] = [NaN];
  const minusDM: number[] = [NaN];
  const tr: number[] = [NaN];
  for (let i = 1; i < len; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  const trRma = calculateRMAPine(tr, period);
  const plusDmRma = calculateRMAPine(plusDM, period);
  const minusDmRma = calculateRMAPine(minusDM, period);
  const dx: number[] = new Array(len).fill(NaN);
  for (let i = 0; i < len; i++) {
    if (isNaN(trRma[i]) || trRma[i] === 0) continue;
    const plusDI = 100 * plusDmRma[i] / trRma[i];
    const minusDI = 100 * minusDmRma[i] / trRma[i];
    const sumDI = plusDI + minusDI;
    dx[i] = sumDI === 0 ? 0 : 100 * Math.abs(plusDI - minusDI) / sumDI;
  }
  return calculateRMAPine(dx, period);
}

export function calculateEMAPine(data: number[], period: number): number[] {
  const result: number[] = new Array(data.length).fill(NaN);
  if (data.length < period) return result;
  const multiplier = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) { sum += data[i]; }
  result[period - 1] = sum / period;
  for (let i = period; i < data.length; i++) {
    result[i] = (data[i] - result[i - 1]) * multiplier + result[i - 1];
  }
  return result;
}

export function calculateBBS2(data: number[], period: number = 20, mult: number = 2): { basis: number[], upper: number[], lower: number[] } {
  return calculateBBPine(data, period, mult);
}

export function calculateADXS2(highs: number[], lows: number[], closes: number[], period: number = 14): number[] {
  return calculateADXPine(highs, lows, closes, period);
}

export function calculateEMA100S2(data: number[], period: number = 100): number[] {
  return calculateEMAPine(data, period);
}

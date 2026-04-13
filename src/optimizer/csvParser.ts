import type { Candle } from './types';

export function parseCSV(csvText: string): Candle[] {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return [];
  const headerLine = lines[0].toLowerCase();
  const hasHeader = headerLine.includes('time') || headerLine.includes('open') || headerLine.includes('close');
  const headers = hasHeader ? lines[0].split(',').map(h => h.trim().toLowerCase()) : [];
  const dataLines = hasHeader ? lines.slice(1) : lines;
  const candles: Candle[] = [];
  for (const line of dataLines) {
    if (!line.trim()) continue;
    const values = parseCSVLine(line);
    if (values.length < 5) continue;
    const candle = hasHeader ? parseCandleWithHeaders(headers, values) : parseCandleByPosition(values);
    if (candle) candles.push(candle);
  }
  candles.sort((a, b) => a.timestamp - b.timestamp);
  return candles;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') { inQuotes = !inQuotes; }
    else if (char === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
    else { current += char; }
  }
  result.push(current.trim());
  return result;
}

function parseCandleWithHeaders(headers: string[], values: string[]): Candle | null {
  const getValue = (name: string): string | undefined => { const idx = headers.indexOf(name); return idx >= 0 ? values[idx] : undefined; };
  const getNumericValue = (name: string): number | undefined => { const val = getValue(name); if (val === undefined || val === '') return undefined; const num = parseFloat(val); return isNaN(num) ? undefined : num; };
  const timestamp = parseTimestamp(getValue('time'));
  const open = getNumericValue('open');
  const high = getNumericValue('high');
  const low = getNumericValue('low');
  const close = getNumericValue('close');
  const volume = getNumericValue('volume') ?? 0;
  if (timestamp === null || open === undefined || high === undefined || low === undefined || close === undefined) return null;
  const candle: Candle = { timestamp, open, high, low, close, volume };
  const optionals: [string, keyof Candle][] = [
    ['ema9','ema9'],['ema21','ema21'],['ema50','ema50'],['ma_val','ma_val'],['rsi','rsi'],['atr','atr'],['avg_atr','avg_atr'],['vol_ma','vol_ma'],
    ['bb_basis','bb_basis'],['bb_upper','bb_upper'],['bb_lower','bb_lower'],['adx','adx'],['plusdi','plusDI'],['minusdi','minusDI'],
    ['swing_filter','swing_filter'],['ok_bar','ok_bar'],['ok_dist','ok_dist']
  ];
  for (const [csvName, candleKey] of optionals) { const val = getNumericValue(csvName); if (val !== undefined) (candle as any)[candleKey] = val; }
  const slPcLong = getNumericValue('sl_pc_long') ?? getNumericValue('sl_pc_long_entry'); if (slPcLong !== undefined) candle.sl_pc_long_entry = slPcLong;
  const slPcShort = getNumericValue('sl_pc_short') ?? getNumericValue('sl_pc_short_entry'); if (slPcShort !== undefined) candle.sl_pc_short_entry = slPcShort;
  const tradeParams: [string, keyof Candle][] = [['be_pc_long','be_pc_long'],['be_pc_short','be_pc_short'],['trail_pc_long','trail_pc_long'],['trail_pc_short','trail_pc_short'],['tp_pc_long','tp_pc_long'],['tp_pc_short','tp_pc_short'],['tp_trail_pc_long','tp_trail_pc_long'],['tp_trail_pc_short','tp_trail_pc_short']];
  for (const [csvName, candleKey] of tradeParams) { const val = getNumericValue(csvName); if (val !== undefined) (candle as any)[candleKey] = val; }
  const signalColumns = ['s1_can_enter_long','s1_can_enter_short','s2_can_enter_long','s2_can_enter_short','s3_can_enter_long','s3_can_enter_short','s4_can_enter_long','s4_can_enter_short','s5_can_enter_long','s5_can_enter_short'] as const;
  for (const col of signalColumns) { const val = getNumericValue(col); if (val !== undefined) (candle as any)[col] = val; }
  return candle;
}

function parseCandleByPosition(values: string[]): Candle | null {
  const timestamp = parseTimestamp(values[0]);
  const open = parseFloat(values[1]);
  const high = parseFloat(values[2]);
  const low = parseFloat(values[3]);
  const close = parseFloat(values[4]);
  const volume = values.length > 5 ? parseFloat(values[5]) : 0;
  if (timestamp === null || isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close)) return null;
  return { timestamp, open, high, low, close, volume: isNaN(volume) ? 0 : volume };
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const num = parseFloat(value);
  if (!isNaN(num)) { return num < 1e12 ? num * 1000 : num; }
  let normalized = value.trim();
  if (!/[Zz]|[+-]\d{2}:?\d{2}$/.test(normalized)) { normalized = normalized.replace(' ', 'T'); if (!normalized.endsWith('Z')) normalized += 'Z'; }
  const date = new Date(normalized);
  return !isNaN(date.getTime()) ? date.getTime() : null;
}

export function readCSVFile(file: File): Promise<Candle[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => { try { resolve(parseCSV(event.target?.result as string)); } catch (error) { reject(error); } };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

export function detectTickerFromCSV(csvText: string, fileName: string): string {
  const nameWithoutExt = fileName.replace(/\.(csv|txt)$/i, '');
  const tickerMatch = nameWithoutExt.match(/^([A-Z]{1,5})/i);
  if (tickerMatch) return tickerMatch[1].toUpperCase();
  return nameWithoutExt.toUpperCase().slice(0, 5);
}

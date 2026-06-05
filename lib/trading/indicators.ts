/**
 * Minimal hand-rolled implementations of the technical indicators we
 * actually use. Avoiding `technicalindicators` (the npm lib) keeps the
 * dependency surface small and makes the math auditable here.
 *
 * All functions return arrays where `result[result.length - 1]` is the
 * indicator value at the *latest* price point in the input.
 */

/** Simple moving average. Output length = values.length - period + 1. */
export function sma(values: number[], period: number): number[] {
  if (period <= 0 || values.length < period) return [];
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  out.push(sum / period);
  for (let i = period; i < values.length; i++) {
    sum += values[i] - values[i - period];
    out.push(sum / period);
  }
  return out;
}

/**
 * Exponential moving average. Seeded with the SMA of the first `period`
 * values; thereafter EMA_t = (price_t - EMA_{t-1}) * k + EMA_{t-1}
 * where k = 2 / (period + 1). Output length = values.length - period + 1.
 */
export function ema(values: number[], period: number): number[] {
  if (period <= 0 || values.length < period) return [];
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  const out: number[] = [prev];
  for (let i = period; i < values.length; i++) {
    prev = (values[i] - prev) * k + prev;
    out.push(prev);
  }
  return out;
}

/**
 * Wilder's RSI(14) by default. Output length = closes.length - period.
 * Standard interpretation: > 70 overbought, < 30 oversold.
 */
export function rsi(closes: number[], period = 14): number[] {
  if (closes.length <= period) return [];
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    avgGain += gains[i];
    avgLoss += losses[i];
  }
  avgGain /= period;
  avgLoss /= period;
  const out: number[] = [];
  out.push(100 - 100 / (1 + avgGain / (avgLoss || 1e-10)));
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    out.push(100 - 100 / (1 + avgGain / (avgLoss || 1e-10)));
  }
  return out;
}

export interface MacdResult {
  /** MACD line = EMA(fast) - EMA(slow). Length = closes.length - slowPeriod + 1. */
  macd: number[];
  /** Signal line = EMA(MACD, signalPeriod). Length = macd.length - signalPeriod + 1. */
  signal: number[];
  /** Histogram = MACD - signal (aligned to signal length). */
  histogram: number[];
}

export function macd(
  closes: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdResult {
  const fast = ema(closes, fastPeriod);
  const slow = ema(closes, slowPeriod);
  if (slow.length === 0) return { macd: [], signal: [], histogram: [] };
  // fast is longer than slow; trim its head so the tails align.
  const fastAligned = fast.slice(fast.length - slow.length);
  const macdLine = slow.map((s, i) => fastAligned[i] - s);
  const signalLine = ema(macdLine, signalPeriod);
  if (signalLine.length === 0)
    return { macd: macdLine, signal: [], histogram: [] };
  const macdAligned = macdLine.slice(macdLine.length - signalLine.length);
  const histogram = signalLine.map((s, i) => macdAligned[i] - s);
  return { macd: macdLine, signal: signalLine, histogram };
}

/**
 * Detect a most-recent crossover of `fast` over `slow` within `lookback`
 * data points. Returns null if no crossover happened in that window.
 *
 * `daysAgo: 0` = crossover landed on the latest data point;
 * `direction: "up"` = fast crossed up through slow (typical bullish);
 * `direction: "down"` = fast crossed down through slow (typical bearish).
 */
export function detectRecentCross(
  fast: number[],
  slow: number[],
  lookback = 5,
): { daysAgo: number; direction: "up" | "down" } | null {
  const n = Math.min(fast.length, slow.length);
  if (n < 2) return null;
  for (let i = 0; i < lookback && i < n - 1; i++) {
    const idx = n - 1 - i;
    const today = fast[idx] - slow[idx];
    const yesterday = fast[idx - 1] - slow[idx - 1];
    if (yesterday <= 0 && today > 0) return { daysAgo: i, direction: "up" };
    if (yesterday >= 0 && today < 0) return { daysAgo: i, direction: "down" };
  }
  return null;
}

/** Pick the most recent (last) element of an array, or undefined if empty. */
export function last<T>(arr: T[]): T | undefined {
  return arr.length ? arr[arr.length - 1] : undefined;
}

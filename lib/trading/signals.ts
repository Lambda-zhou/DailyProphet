import {
  detectRecentCross,
  ema,
  last,
  macd as macdFn,
  rsi as rsiFn,
  sma,
} from "./indicators";
import type { TickerRawData } from "./yahoo";
import { getDisplayName, type TickerDef } from "./watchlist";
import { REPORT_LOCALE } from "../sources/registry";

export type SignalType =
  | "golden-cross" // SMA50 crosses above SMA200 — bullish trend confirmation
  | "death-cross" // SMA50 crosses below SMA200 — bearish trend confirmation
  | "macd-bull-cross" // MACD crosses above signal — momentum turning up
  | "macd-bear-cross" // MACD crosses below signal — momentum turning down
  | "rsi-overbought" // RSI > 70
  | "rsi-oversold" // RSI < 30
  | "near-52w-high" // within 3% of 52-week high
  | "near-52w-low" // within 3% of 52-week low
  | "above-sma50-sma200" // price > both SMAs, classic uptrend
  | "below-sma50-sma200"; // price < both SMAs, classic downtrend

export interface Signal {
  type: SignalType;
  label: string; // human-friendly Chinese
  daysAgo?: number; // for cross signals
}

export interface TickerAnalysis {
  symbol: string;
  displayName: string;
  group: string;
  currency: string;
  exchangeName: string;
  currentPrice: number;
  pct1Day: number;
  pct5Day: number;
  pct52WeekHigh: number; // negative = below high, e.g. -2.3 means 2.3% below 52w high
  pct52WeekLow: number; // positive = above low
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  rsi14: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  trend: "bullish" | "bearish" | "neutral";
  rsiState: "overbought" | "oversold" | "normal";
  signals: Signal[];
}

const SIGNAL_LABELS: Record<SignalType, string> = {
  "golden-cross": "金叉(SMA50↑SMA200)",
  "death-cross": "死叉(SMA50↓SMA200)",
  "macd-bull-cross": "MACD 金叉",
  "macd-bear-cross": "MACD 死叉",
  "rsi-overbought": "RSI 超买",
  "rsi-oversold": "RSI 超卖",
  "near-52w-high": "接近 52 周高",
  "near-52w-low": "接近 52 周低",
  "above-sma50-sma200": "多头排列",
  "below-sma50-sma200": "空头排列",
};

export function analyzeTicker(
  def: TickerDef,
  raw: TickerRawData,
): TickerAnalysis {
  const closes = raw.candles.map((c) => c.close);
  const n = closes.length;

  const currentPrice = raw.regularMarketPrice;
  const prev1 = closes[n - 2];
  const prev5 = closes[n - 6];
  const pct1Day = prev1 ? ((currentPrice - prev1) / prev1) * 100 : 0;
  const pct5Day = prev5 ? ((currentPrice - prev5) / prev5) * 100 : 0;
  const pct52WeekHigh = raw.fiftyTwoWeekHigh
    ? ((currentPrice - raw.fiftyTwoWeekHigh) / raw.fiftyTwoWeekHigh) * 100
    : 0;
  const pct52WeekLow = raw.fiftyTwoWeekLow
    ? ((currentPrice - raw.fiftyTwoWeekLow) / raw.fiftyTwoWeekLow) * 100
    : 0;

  const sma20arr = sma(closes, 20);
  const sma50arr = sma(closes, 50);
  const sma200arr = sma(closes, 200);
  const rsiArr = rsiFn(closes, 14);
  const m = macdFn(closes);

  const sma20Val = last(sma20arr) ?? null;
  const sma50Val = last(sma50arr) ?? null;
  const sma200Val = last(sma200arr) ?? null;
  const rsi14 = last(rsiArr) ?? null;
  const macdVal = last(m.macd) ?? null;
  const macdSignal = last(m.signal) ?? null;
  const macdHistogram = last(m.histogram) ?? null;

  const trend: TickerAnalysis["trend"] =
    sma50Val && sma200Val
      ? currentPrice > sma50Val && sma50Val > sma200Val
        ? "bullish"
        : currentPrice < sma50Val && sma50Val < sma200Val
          ? "bearish"
          : "neutral"
      : "neutral";

  const rsiState: TickerAnalysis["rsiState"] =
    rsi14 != null
      ? rsi14 > 70
        ? "overbought"
        : rsi14 < 30
          ? "oversold"
          : "normal"
      : "normal";

  const signals: Signal[] = [];

  // SMA50 / SMA200 cross (golden / death)
  if (sma50arr.length && sma200arr.length) {
    const aligned50 = sma50arr.slice(sma50arr.length - sma200arr.length);
    const cross = detectRecentCross(aligned50, sma200arr, 10);
    if (cross) {
      signals.push({
        type: cross.direction === "up" ? "golden-cross" : "death-cross",
        label: SIGNAL_LABELS[
          cross.direction === "up" ? "golden-cross" : "death-cross"
        ],
        daysAgo: cross.daysAgo,
      });
    }
  }

  // MACD cross
  if (m.macd.length && m.signal.length) {
    const alignedMacd = m.macd.slice(m.macd.length - m.signal.length);
    const cross = detectRecentCross(alignedMacd, m.signal, 5);
    if (cross) {
      signals.push({
        type: cross.direction === "up" ? "macd-bull-cross" : "macd-bear-cross",
        label: SIGNAL_LABELS[
          cross.direction === "up" ? "macd-bull-cross" : "macd-bear-cross"
        ],
        daysAgo: cross.daysAgo,
      });
    }
  }

  // RSI extremes
  if (rsiState === "overbought") {
    signals.push({
      type: "rsi-overbought",
      label: SIGNAL_LABELS["rsi-overbought"],
    });
  } else if (rsiState === "oversold") {
    signals.push({
      type: "rsi-oversold",
      label: SIGNAL_LABELS["rsi-oversold"],
    });
  }

  // 52-week extremes
  if (pct52WeekHigh >= -3) {
    signals.push({
      type: "near-52w-high",
      label: SIGNAL_LABELS["near-52w-high"],
    });
  } else if (pct52WeekLow <= 3) {
    signals.push({
      type: "near-52w-low",
      label: SIGNAL_LABELS["near-52w-low"],
    });
  }

  // Trend alignment
  if (trend === "bullish") {
    signals.push({
      type: "above-sma50-sma200",
      label: SIGNAL_LABELS["above-sma50-sma200"],
    });
  } else if (trend === "bearish") {
    signals.push({
      type: "below-sma50-sma200",
      label: SIGNAL_LABELS["below-sma50-sma200"],
    });
  }

  return {
    symbol: def.symbol,
    displayName: getDisplayName(def, REPORT_LOCALE),
    group: def.group,
    currency: raw.currency,
    exchangeName: raw.exchangeName,
    currentPrice,
    pct1Day,
    pct5Day,
    pct52WeekHigh,
    pct52WeekLow,
    sma20: sma20Val,
    sma50: sma50Val,
    sma200: sma200Val,
    rsi14,
    macd: macdVal,
    macdSignal,
    macdHistogram,
    trend,
    rsiState,
    signals,
  };
}

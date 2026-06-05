export interface OHLC {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TickerRawData {
  symbol: string;
  currency: string;
  exchangeName: string;
  regularMarketPrice: number;
  fiftyTwoWeekHigh: number;
  fiftyTwoWeekLow: number;
  /** Daily OHLCV for the last ~1 year, oldest first. */
  candles: OHLC[];
}

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json",
} as const;

interface YahooChartResp {
  chart?: {
    result?: Array<{
      meta?: {
        symbol?: string;
        currency?: string;
        exchangeName?: string;
        regularMarketPrice?: number;
        fiftyTwoWeekHigh?: number;
        fiftyTwoWeekLow?: number;
      };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: (number | null)[];
          high?: (number | null)[];
          low?: (number | null)[];
          close?: (number | null)[];
          volume?: (number | null)[];
        }>;
      };
    }>;
    error?: { code?: string; description?: string } | null;
  };
}

/**
 * Fetch daily OHLCV + meta from Yahoo Finance public chart API.
 * No key required. Works for stocks, ETFs, indices, crypto (BTC-USD),
 * forex (USDCNY=X), commodities (GC=F), Hong Kong equities (0700.HK).
 *
 * Null-day candles (e.g. forex non-trading day) are filtered out.
 */
export async function fetchTickerData(
  symbol: string,
): Promise<TickerRawData | null> {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) return null;
  const data = (await res.json()) as YahooChartResp;
  const r = data.chart?.result?.[0];
  if (!r || !r.meta || !r.timestamp || !r.indicators?.quote?.[0]) return null;

  const ts = r.timestamp;
  const q = r.indicators.quote[0];
  const candles: OHLC[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    const v = q.volume?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    candles.push({
      date: new Date(ts[i] * 1000),
      open: o,
      high: h,
      low: l,
      close: c,
      volume: v ?? 0,
    });
  }

  return {
    symbol: r.meta.symbol ?? symbol,
    currency: r.meta.currency ?? "",
    exchangeName: r.meta.exchangeName ?? "",
    regularMarketPrice:
      r.meta.regularMarketPrice ?? candles[candles.length - 1]?.close ?? 0,
    fiftyTwoWeekHigh: r.meta.fiftyTwoWeekHigh ?? 0,
    fiftyTwoWeekLow: r.meta.fiftyTwoWeekLow ?? 0,
    candles,
  };
}

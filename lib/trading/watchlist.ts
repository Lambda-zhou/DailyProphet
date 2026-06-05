export type AssetGroup =
  | "us-equity" // 美股蓝筹 + ETF
  | "crypto" // 加密货币
  | "china-equity" // 中概股 / 港股
  | "commodity-fx" // 商品 + 外汇
  | "macro"; // 宏观信号（恐慌指数 / 利率 / 美元指数）

export interface TickerDef {
  symbol: string; // Yahoo Finance symbol
  displayName: string; // 中文展示名
  displayNameEn?: string; // English display name (falls back to displayName if absent)
  group: AssetGroup;
}

export function getDisplayName(t: TickerDef, locale: "zh" | "en"): string {
  return locale === "en" ? (t.displayNameEn ?? t.displayName) : t.displayName;
}

const ASSET_GROUP_LABELS_ZH: Record<AssetGroup, string> = {
  "us-equity": "美股 / ETF",
  crypto: "加密货币",
  "china-equity": "中概 / 港股",
  "commodity-fx": "商品 / 外汇",
  macro: "宏观信号",
};

const ASSET_GROUP_LABELS_EN: Record<AssetGroup, string> = {
  "us-equity": "US Stocks / ETF",
  crypto: "Crypto",
  "china-equity": "China / HK",
  "commodity-fx": "Commodities / FX",
  macro: "Macro",
};

export function getAssetGroupLabels(
  locale: "zh" | "en",
): Record<AssetGroup, string> {
  return locale === "en" ? ASSET_GROUP_LABELS_EN : ASSET_GROUP_LABELS_ZH;
}

export const ASSET_GROUP_ORDER: AssetGroup[] = [
  "macro",
  "us-equity",
  "crypto",
  "china-equity",
  "commodity-fx",
];

export const WATCHLIST: TickerDef[] = [
  // === 美股蓝筹 + 大盘 ETF ===
  { symbol: "SPY", displayName: "S&P 500 ETF", group: "us-equity" },
  { symbol: "QQQ", displayName: "Nasdaq 100 ETF", group: "us-equity" },
  { symbol: "AAPL", displayName: "Apple", group: "us-equity" },
  { symbol: "MSFT", displayName: "Microsoft", group: "us-equity" },
  { symbol: "NVDA", displayName: "Nvidia", group: "us-equity" },
  { symbol: "GOOGL", displayName: "Alphabet", group: "us-equity" },
  { symbol: "TSLA", displayName: "Tesla", group: "us-equity" },
  { symbol: "META", displayName: "Meta", group: "us-equity" },
  // === 加密货币 ===
  { symbol: "BTC-USD", displayName: "Bitcoin", group: "crypto" },
  { symbol: "ETH-USD", displayName: "Ethereum", group: "crypto" },
  { symbol: "SOL-USD", displayName: "Solana", group: "crypto" },
  // === 中概 / 港股 ===
  { symbol: "BABA", displayName: "阿里巴巴 (BABA)", displayNameEn: "Alibaba (BABA)", group: "china-equity" },
  { symbol: "PDD", displayName: "拼多多 (PDD)", displayNameEn: "Pinduoduo (PDD)", group: "china-equity" },
  { symbol: "JD", displayName: "京东 (JD)", displayNameEn: "JD.com (JD)", group: "china-equity" },
  { symbol: "0700.HK", displayName: "腾讯控股 (0700.HK)", displayNameEn: "Tencent (0700.HK)", group: "china-equity" },
  // === 商品 + 外汇 ===
  { symbol: "GC=F", displayName: "黄金期货", displayNameEn: "Gold Futures", group: "commodity-fx" },
  { symbol: "CL=F", displayName: "WTI 原油期货", displayNameEn: "WTI Crude Futures", group: "commodity-fx" },
  { symbol: "USDCNY=X", displayName: "美元 / 人民币", displayNameEn: "USD / CNY", group: "commodity-fx" },
  // === 宏观信号（恐慌指数 / 利率 / 美元）===
  { symbol: "^VIX", displayName: "VIX 恐慌指数", displayNameEn: "VIX (Volatility)", group: "macro" },
  { symbol: "^TNX", displayName: "10Y 美债收益率 (%)", displayNameEn: "10Y Treasury Yield (%)", group: "macro" },
  { symbol: "DX-Y.NYB", displayName: "美元指数 DXY", displayNameEn: "DXY (US Dollar Index)", group: "macro" },
];

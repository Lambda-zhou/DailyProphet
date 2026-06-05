export interface CryptoGlobalStats {
  totalMarketCapUsd: number;
  total24hVolumeUsd: number;
  marketCapChangePct24h: number;
  btcDominance: number; // %
  ethDominance: number; // %
  activeCryptocurrencies: number;
}

/**
 * Fetch global crypto market statistics from CoinGecko's free public
 * API — no key required. Returns null on failure.
 * https://api.coingecko.com/api/v3/global
 */
export async function fetchCryptoGlobal(): Promise<CryptoGlobalStats | null> {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/global", {
      headers: { "User-Agent": "Mozilla/5.0 (DailyBriefBot)" },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: {
        active_cryptocurrencies?: number;
        total_market_cap?: { usd?: number };
        total_volume?: { usd?: number };
        market_cap_percentage?: { btc?: number; eth?: number };
        market_cap_change_percentage_24h_usd?: number;
      };
    };
    const d = json?.data;
    if (!d) return null;
    return {
      totalMarketCapUsd: d.total_market_cap?.usd ?? 0,
      total24hVolumeUsd: d.total_volume?.usd ?? 0,
      marketCapChangePct24h: d.market_cap_change_percentage_24h_usd ?? 0,
      btcDominance: d.market_cap_percentage?.btc ?? 0,
      ethDominance: d.market_cap_percentage?.eth ?? 0,
      activeCryptocurrencies: d.active_cryptocurrencies ?? 0,
    };
  } catch {
    return null;
  }
}

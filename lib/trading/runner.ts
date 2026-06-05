import { analyzeTicker, type TickerAnalysis } from "./signals";
import { WATCHLIST } from "./watchlist";
import { fetchTickerData } from "./yahoo";

/**
 * Fetch + analyze the entire watchlist in parallel. Failures are
 * non-fatal — the affected ticker is silently dropped from the output.
 *
 * Order in the returned array follows WATCHLIST so the renderer can
 * group by AssetGroup without further sorting.
 */
export async function analyzeWatchlist(): Promise<TickerAnalysis[]> {
  const results = await Promise.all(
    WATCHLIST.map(async (def) => {
      try {
        const raw = await fetchTickerData(def.symbol);
        if (!raw) {
          console.warn(`[trading] ${def.symbol} returned no data`);
          return null;
        }
        return analyzeTicker(def, raw);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[trading] ${def.symbol} failed: ${msg}`);
        return null;
      }
    }),
  );
  return results.filter((x): x is TickerAnalysis => x !== null);
}

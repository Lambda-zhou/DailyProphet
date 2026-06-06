import "./_env";

import fs from "node:fs";
import path from "node:path";

import { sources, REPORT_LOCALE } from "../lib/sources/registry";
import { fetchAllArticles } from "../lib/sources/fetch-all";
import {
  generateDailyReport,
  type ArticleInput,
  type DailyReport,
} from "../lib/ai/pipeline";
import { getBackend, getModelTag, validateBackendCredentials } from "../lib/ai/llm";
import {
  enrichFinanceNewsSummaries,
  enrichGithubTrendingSummaries,
  enrichTrendingPapersSummaries,
  enrichXViralSummaries,
} from "../lib/ai/enrich";
import {
  groupRaw,
  isSportsArticle,
  MERGED_SUBGROUP_LIMITS,
  renderHtml,
  renderMarkdown,
} from "../lib/output/render";
import { analyzeWatchlist } from "../lib/trading/runner";
import { fetchCryptoFearGreed } from "../lib/trading/fear-greed";
import { fetchCryptoGlobal } from "../lib/trading/coingecko";
import { generateTradingCommentary } from "../lib/ai/trading-commentary";
import type { TradingSection } from "../lib/ai/pipeline";
import { todayKey } from "../lib/utils";

const OUTPUT_DIR = "daily_reports";
const BPC_ENRICH_LIMIT_PER_SOURCE = 12;
function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function runWithConcurrency(
  tasks: Array<{ name: string; run: () => Promise<void> }>,
  concurrency: number,
): Promise<void> {
  if (tasks.length === 0) return;
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    async () => {
      while (next < tasks.length) {
        const task = tasks[next++];
        await task.run();
      }
    },
  );
  await Promise.all(workers);
}

async function fetchAll(): Promise<ArticleInput[]> {
  return fetchAllArticles(sources);
}

async function enrichGhTrending(articles: ArticleInput[]): Promise<void> {
  const gh = articles.filter((a) => a.sourceId === "github-trending");
  if (gh.length === 0) return;
  console.log(
    `[daily] enriching ${gh.length} GitHub Trending repos with ${REPORT_LOCALE} summaries…`,
  );
  const t0 = Date.now();
  const summaries = await enrichGithubTrendingSummaries(gh);
  for (const a of gh) {
    const s = summaries.get(a.url);
    if (s) a.summary = s;
  }
  console.log(
    `[daily] enrichment done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${summaries.size}/${gh.length}`,
  );
}

/**
 * finance:news is rendered as a merged time-sorted list (see
 * MERGED_SUBGROUP_LIMITS in render.ts). Enrich exactly the items that
 * will be displayed: take all enabled finance:news articles, sort by
 * publishedAt desc, slice to the merge limit, ask Sonnet for Chinese
 * factual summaries.
 */
async function enrichFinanceNews(articles: ArticleInput[]): Promise<void> {
  await enrichMergedSubgroup(articles, "finance", "news");
}

/**
 * bpc/paywall-aware sources deserve their own summary pass because they may be
 * rendered again in the dedicated "Foreign Media" tab even when they don't
 * survive the finance:news merged top-N cut. Reuse the finance-news factual
 * summarizer so the page shows localized summaries for every visible bpc item.
 */
async function enrichBpcArticles(articles: ArticleInput[]): Promise<void> {
  const bpcSources = sources.filter((s) => s.type === "bpc" && s.enabled !== false);
  if (bpcSources.length === 0) return;

  const bpcIds = new Set(bpcSources.map((s) => s.id));
  const sameLocaleIds = new Set(
    bpcSources.filter((s) => (s.lang ?? "en") === REPORT_LOCALE).map((s) => s.id),
  );

  const bpcCandidates = articles
    .filter((a) => bpcIds.has(a.sourceId))
    .filter((a) => !sameLocaleIds.has(a.sourceId))
    .filter((a) => !a.summary)
    .sort(
      (a, b) =>
        (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0),
    );
  const perSourceCount = new Map<string, number>();
  const targets: ArticleInput[] = [];
  for (const article of bpcCandidates) {
    const count = perSourceCount.get(article.sourceId) ?? 0;
    if (count >= BPC_ENRICH_LIMIT_PER_SOURCE) continue;
    perSourceCount.set(article.sourceId, count + 1);
    targets.push(article);
  }

  if (targets.length === 0) return;
  console.log(
    `[daily] enriching ${targets.length} bpc items with ${REPORT_LOCALE} summaries…`,
  );
  const t0 = Date.now();
  const summaries = await enrichFinanceNewsSummaries(targets);
  for (const a of targets) {
    const s = summaries.get(a.url);
    if (s) a.summary = s;
  }
  console.log(
    `[daily] bpc enrichment done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${summaries.size}/${targets.length}`,
  );
}

async function enrichPolitics(articles: ArticleInput[]): Promise<void> {
  await enrichMergedSubgroup(articles, "politics", "world");
}

async function enrichAiNews(articles: ArticleInput[]): Promise<void> {
  await enrichMergedSubgroup(articles, "tech", "ai-news");
}

/**
 * X 热帖 enrichment is different from merged subgroups — we preserve the
 * AttentionVC API's heat-rank order (do NOT sort by date) and cap to the
 * displayed limit (matches SOURCE_DISPLAY_LIMITS["tech:x-viral"]).
 *
 * The Sonnet prompt also differs (XVIRAL_SYSTEM_PROMPT in enrich.ts) — X
 * tweet titles are clickbait, the previewText holds the actual claim.
 */
async function enrichXViral(articles: ArticleInput[]): Promise<void> {
  const xPosts = articles
    .filter((a) => a.sourceId === "attentionvc-ai")
    .slice(0, 20);
  if (xPosts.length === 0) return;
  console.log(`[daily] enriching ${xPosts.length} X posts with ${REPORT_LOCALE} summaries…`);
  const t0 = Date.now();
  // Author handle is encoded in the URL (https://x.com/{handle}/status/{id})
  // — extract it to help the model identify whose claim it is.
  const summaries = await enrichXViralSummaries(
    xPosts.map((a) => ({
      url: a.url,
      title: a.title,
      excerpt: a.excerpt,
      author: a.url.match(/x\.com\/([^/]+)\//)?.[1] ?? "",
    })),
  );
  for (const a of xPosts) {
    const s = summaries.get(a.url);
    if (s) a.summary = s;
  }
  console.log(
    `[daily] enrichment done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${summaries.size}/${xPosts.length}`,
  );
}

/**
 * Trending papers enrichment — preserves the fetcher's upvote-desc order
 * (huggingface-papers is in PRESERVE_FETCH_ORDER_SOURCES) and caps to the
 * displayed limit (matches SOURCE_DISPLAY_LIMITS["tech:trending-papers"]).
 */
async function enrichTrendingPapers(articles: ArticleInput[]): Promise<void> {
  const papers = articles
    .filter((a) => a.sourceId === "huggingface-papers")
    .slice(0, 20);
  if (papers.length === 0) return;
  console.log(
    `[daily] enriching ${papers.length} trending papers with ${REPORT_LOCALE} summaries…`,
  );
  const t0 = Date.now();
  const summaries = await enrichTrendingPapersSummaries(
    papers.map((a) => ({ url: a.url, title: a.title, excerpt: a.excerpt })),
  );
  for (const a of papers) {
    const s = summaries.get(a.url);
    if (s) a.summary = s;
  }
  console.log(
    `[daily] enrichment done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${summaries.size}/${papers.length}`,
  );
}

/**
 * Shared implementation for "merged subgroup" enrichment: collect all
 * enabled articles in (category, subcategory), sort by date desc, take
 * the display cap (from MERGED_SUBGROUP_LIMITS), and ask the LLM to
 * summarize them into REPORT_LOCALE in a single batch. Symmetric to the
 * merge logic in render.ts groupRaw, so display and enrichment stay aligned.
 *
 * Sources whose `lang` already matches REPORT_LOCALE are skipped — no
 * point translating English to English (en mode) or Chinese to Chinese
 * (zh mode).
 */
async function enrichMergedSubgroup(
  articles: ArticleInput[],
  category: "tech" | "finance" | "politics",
  subcategory: string,
): Promise<void> {
  const subSources = sources.filter(
    (s) =>
      s.category === category &&
      s.subcategory === subcategory &&
      s.enabled !== false,
  );
  const enabledIds = new Set(subSources.map((s) => s.id));
  const sameLocaleIds = new Set(
    subSources.filter((s) => (s.lang ?? "en") === REPORT_LOCALE).map((s) => s.id),
  );
  // The dedicated Foreign Media tab has its own bpc summary pass. Skipping
  // bpc sources here avoids summarizing the same FT items twice when
  // enrichment tasks run concurrently.
  const bpcIds =
    category === "finance" && subcategory === "news"
      ? new Set(
          subSources
            .filter((s) => s.type === "bpc")
            .map((s) => s.id),
        )
      : new Set<string>();
  const limit = MERGED_SUBGROUP_LIMITS[`${category}:${subcategory}`] ?? 12;
  // Top-N respects all enabled sources (so we don't reshape the merged
  // timeline). Enrichment only targets items NOT already in the target
  // language within that slice.
  const top = articles
    .filter((a) => enabledIds.has(a.sourceId))
    .filter((a) => category !== "politics" || !isSportsArticle(a.title))
    .sort(
      (a, b) =>
        (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0),
    )
    .slice(0, limit);
  const toEnrich = top.filter(
    (a) => !sameLocaleIds.has(a.sourceId) && !bpcIds.has(a.sourceId),
  );
  if (toEnrich.length === 0) return;
  console.log(
    `[daily] enriching ${toEnrich.length}/${top.length} ${category}:${subcategory} items with ${REPORT_LOCALE} summaries…`,
  );
  const t0 = Date.now();
  const summaries = await enrichFinanceNewsSummaries(toEnrich);
  for (const a of toEnrich) {
    const s = summaries.get(a.url);
    if (s) a.summary = s;
  }
  console.log(
    `[daily] enrichment done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${summaries.size}/${toEnrich.length}`,
  );
}

/**
 * Pull daily OHLCV from Yahoo for every ticker in the watchlist, compute
 * indicators + signals, then ask Sonnet for a market overview + a
 * picks-to-watch list. Returns null if no ticker came back.
 */
async function runTrading(): Promise<TradingSection | null> {
  console.log(`[daily] analyzing watchlist + crypto context (Yahoo / alt.me / CoinGecko)…`);
  const t0 = Date.now();
  const [tickers, cryptoFearGreed, cryptoGlobal] = await Promise.all([
    analyzeWatchlist(),
    fetchCryptoFearGreed(),
    fetchCryptoGlobal(),
  ]);
  console.log(
    `[daily] indicators ready in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${tickers.length} tickers` +
      (cryptoFearGreed ? `, F&G ${cryptoFearGreed.value}` : ", F&G ✗") +
      (cryptoGlobal
        ? `, BTC dom ${cryptoGlobal.btcDominance.toFixed(1)}%`
        : ", CG ✗"),
  );
  if (tickers.length === 0) return null;
  console.log(`[daily] generating trading commentary with ${getModelTag()}…`);
  const t1 = Date.now();
  const commentary = await generateTradingCommentary({
    tickers,
    cryptoFearGreed: cryptoFearGreed ?? undefined,
    cryptoGlobal: cryptoGlobal ?? undefined,
  });
  console.log(
    `[daily] trading commentary ready in ${((Date.now() - t1) / 1000).toFixed(1)}s`,
  );
  return {
    ...commentary,
    tickers,
    crypto_fear_greed: cryptoFearGreed ?? undefined,
    crypto_global: cryptoGlobal ?? undefined,
    generated_at: new Date().toISOString(),
  };
}

async function main() {
  // Fail fast on misconfigured backend before we spend 30s fetching
  // 500+ articles only to discover the LLM has no credentials.
  validateBackendCredentials();

  const date = todayKey();
  const skipDigestEnv = process.env.SKIP_DIGEST?.trim().toLowerCase();
  const skipDigest =
    skipDigestEnv !== undefined
      ? ["1", "true", "yes"].includes(skipDigestEnv)
      : process.env.WEB_MODE === "true" && process.env.OUTPUT_MARKDOWN !== "true";
  console.log(`[daily] ${date} — fetching sources…\n`);
  const articles = await fetchAll();
  console.log(`\n[daily] total articles: ${articles.length}`);
  if (articles.length === 0) {
    throw new Error("no articles fetched — aborting");
  }

  // Trading signals are independent from article enrichment. Start them early
  // so the market LLM call overlaps with summary enrichment instead of adding
  // ~1 minute after the article pipeline.
  const tradingPromise: Promise<TradingSection | null> = (async () => {
    try {
      return await runTrading();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[daily] trading section failed: ${msg}`);
      return null;
    }
  })();

  // Enrich visible raw-panel items with localized summaries. API backends can
  // handle a small amount of parallelism; the CLI backend stays serial by
  // default to avoid multiple local Claude Code processes competing.
  const enrichConcurrency = envPositiveInt(
    "DAILY_ENRICH_CONCURRENCY",
    getBackend() === "claude-cli" ? 1 : 3,
  );
  console.log(`[daily] running enrichment tasks with concurrency=${enrichConcurrency}`);
  await runWithConcurrency(
    [
      { name: "github-trending", run: () => enrichGhTrending(articles) },
      { name: "trending-papers", run: () => enrichTrendingPapers(articles) },
      { name: "finance-news", run: () => enrichFinanceNews(articles) },
      { name: "bpc", run: () => enrichBpcArticles(articles) },
      { name: "politics", run: () => enrichPolitics(articles) },
      { name: "ai-news", run: () => enrichAiNews(articles) },
      { name: "x-viral", run: () => enrichXViral(articles) },
    ],
    enrichConcurrency,
  );

  const report: DailyReport = {
    hero_headline: "",
    daily_overview: "",
    tech_briefs: [],
    finance_briefs: [],
    politics_briefs: [],
    editor_note: "",
    keywords: [],
  };

  const t0 = Date.now();
  let trading: TradingSection | null;
  if (skipDigest) {
    console.log(
      `[daily] skipping final digest (web HTML renders raw tabs; set OUTPUT_MARKDOWN=true or SKIP_DIGEST=false to enable markdown digest)…`,
    );
    trading = await tradingPromise;
  } else {
    console.log(`[daily] generating digest with ${getModelTag()}…`);
    const [digestResult, tradingResult] = await Promise.all([
      generateDailyReport(articles),
      tradingPromise,
    ]);
    Object.assign(report, digestResult.report);
    trading = tradingResult;
  }
  if (trading) report.trading = trading;
  console.log(
    `[daily] ${skipDigest ? "post-enrichment AI sections" : "digest"} ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );

  const dateDir = path.join(OUTPUT_DIR, date);
  fs.mkdirSync(dateDir, { recursive: true });
  const base = path.join(dateDir, date);
  const raw = groupRaw(articles, sources);
  fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2), "utf8");
  // Sidecar with all fetched articles + LLM-attached summary, so
  // scripts/render.ts can rebuild HTML/MD for UI iteration without
  // re-fetching or re-calling the LLM.
  fs.writeFileSync(
    `${base}-articles.json`,
    JSON.stringify({ date, articles }, null, 2),
    "utf8",
  );
  fs.writeFileSync(`${base}.html`, renderHtml(report, raw, date, articles), "utf8");
  if (process.env.OUTPUT_MARKDOWN === "true") {
    fs.writeFileSync(`${base}.md`, renderMarkdown(report, date), "utf8");
    console.log(`[daily] wrote ${base}.{json,html,md,articles.json}`);
  } else {
    console.log(`[daily] wrote ${base}.{json,html,articles.json}`);
  }

  console.log(`[daily] done.`);
}

main().catch((e) => {
  console.error(`[daily] FAILED:`, e);
  process.exit(1);
});

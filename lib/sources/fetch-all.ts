import { fetchSource } from "./dispatch";
import type { SourceDef } from "./types";
import type { ArticleInput } from "../ai/pipeline";

const DEFAULT_CONCURRENCY = 6;

export async function fetchAllArticles(
  allSources: SourceDef[],
  logPrefix = "",
): Promise<ArticleInput[]> {
  const enabled = allSources.filter((source) => source.enabled !== false);
  const concurrency = parseConcurrency(process.env.SOURCE_FETCH_CONCURRENCY);
  const buckets: ArticleInput[][] = Array.from({ length: enabled.length }, () => []);

  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= enabled.length) return;
      const source = enabled[index];
      try {
        const items = await fetchSource(source);
        console.log(`${logPrefix}  ${source.id.padEnd(20)} ${items.length}`);
        buckets[index] = items.map((item) => ({ ...item, source: source.name }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`${logPrefix}  ${source.id.padEnd(20)} FAILED — ${message}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, enabled.length) }, () => worker()),
  );
  return dedupeArticles(buckets.flat());
}

function parseConcurrency(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONCURRENCY;
}

function dedupeArticles(articles: ArticleInput[]): ArticleInput[] {
  const seen = new Set<string>();
  const deduped: ArticleInput[] = [];
  for (const article of articles) {
    const key = canonicalArticleKey(article.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(article);
  }
  return deduped;
}

function canonicalArticleKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|ftcamp|ftag|shareType|segmentId)/i.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    return parsed.toString();
  } catch {
    return url.trim();
  }
}

import { curlFetch } from "./curl-fetch";
import type { RawArticle } from "./types";

interface HfPaper {
  paper: {
    id: string;
    title: string;
    summary: string;
    upvotes: number;
    publishedAt: string;
    ai_keywords?: string[];
  };
}

export async function fetchHuggingfacePapers(
  sourceId: string,
  keywords?: string[],
  limit = 30,
): Promise<RawArticle[]> {
  const raw = await curlFetch("https://huggingface.co/api/daily_papers", {
    "User-Agent": "DailyBriefBot/1.0",
    Accept: "application/json",
  });
  const papers = JSON.parse(raw) as HfPaper[];

  const keywordList = (keywords ?? []).map((k) => k.toLowerCase());

  return papers
    .filter((p) => {
      if (keywordList.length === 0) return true;
      const haystack = [
        p.paper.title ?? "",
        p.paper.summary ?? "",
        ...(p.paper.ai_keywords ?? []),
      ]
        .join(" ")
        .toLowerCase();
      return keywordList.some((kw) => haystack.includes(kw));
    })
    // Rank by upvotes desc so the displayed top-N is "most liked", not
    // the API's default order. groupRaw preserves this (huggingface-papers
    // is in PRESERVE_FETCH_ORDER_SOURCES) instead of re-sorting by date.
    .sort((a, b) => (b.paper.upvotes ?? 0) - (a.paper.upvotes ?? 0))
    .slice(0, limit)
    .map((p) => ({
      sourceId,
      title: p.paper.title,
      url: `https://huggingface.co/papers/${p.paper.id}`,
      excerpt: (p.paper.summary ?? "").slice(0, 300),
      publishedAt: p.paper.publishedAt
        ? new Date(p.paper.publishedAt)
        : undefined,
      meta: `👍 ${p.paper.upvotes}`,
      category: "tech" as const,
    }));
}

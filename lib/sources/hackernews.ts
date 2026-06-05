import type { RawArticle } from "./types";

const HN_BASE = "https://hacker-news.firebaseio.com/v0";

interface HnItem {
  id: number;
  title?: string;
  url?: string;
  text?: string;
  score?: number;
  descendants?: number;
  time?: number;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

export async function fetchHackerNews(
  sourceId: string,
  limit = 30,
): Promise<RawArticle[]> {
  const ids = (await fetch(`${HN_BASE}/topstories.json`).then((r) =>
    r.json(),
  )) as number[];
  const slice = ids.slice(0, limit);
  const items = await Promise.all(
    slice.map((id) =>
      fetch(`${HN_BASE}/item/${id}.json`)
        .then((r) => r.json() as Promise<HnItem>)
        .catch(() => null),
    ),
  );
  return items
    .filter((it): it is HnItem => Boolean(it && it.title))
    .map((it) => ({
      sourceId,
      title: it.title ?? "",
      url: it.url ?? `https://news.ycombinator.com/item?id=${it.id}`,
      excerpt: it.text
        ? stripHtml(it.text).slice(0, 300)
        : `${it.score ?? 0} points · ${it.descendants ?? 0} comments`,
      publishedAt: it.time ? new Date(it.time * 1000) : undefined,
      category: "tech" as const,
    }));
}

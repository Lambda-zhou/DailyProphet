import Parser from "rss-parser";
import { curlFetch } from "./curl-fetch";
import type { RawArticle } from "./types";
import { V2EX_OFF_TOPIC_RE } from "./v2ex";

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (compatible; DailyBriefBot/1.0; +https://github.com/leiting-eric/DailyBrief)",
  Accept:
    "application/atom+xml, application/rss+xml, application/xml, text/xml, */*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};

const parser = new Parser({ timeout: 15000 });

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function isCloudflareChallenge(text: string): boolean {
  const head = text.slice(0, 500).toLowerCase();
  return (
    head.includes("just a moment") ||
    head.includes("cf-chl") ||
    (head.startsWith("<!doctype html") && head.includes("cloudflare"))
  );
}

async function fetchFeed(url: string) {
  const xml = await curlFetch(url, HEADERS);
  if (isCloudflareChallenge(xml)) {
    throw new Error("cloudflare challenge page");
  }
  return parser.parseString(xml);
}

/**
 * LinuxDo data source.
 *
 * Uses LinuxDo's public Discourse RSS feeds — the same URLs that any RSS
 * reader subscribes to. RSS is the syndication protocol the site exposes
 * to third-party aggregators, so this fetcher identifies itself honestly
 * as `DailyBriefBot/1.0` (no UA spoofing).
 *
 * Strategy: try /top.rss?period=daily first (matches "today's hot"
 * semantics), fall back to /latest.rss when /top fails.
 *
 * Cloudflare still TLS-fingerprints Node's undici on linux.do, so we
 * shell out to curl (see lib/sources/curl-fetch.ts). RSS endpoints sit
 * on Cloudflare's syndication-friendly path and rarely trigger the
 * "Just a moment…" interstitial.
 */
export async function fetchLinuxDo(
  sourceId: string,
  limit = 25,
): Promise<RawArticle[]> {
  let feed;
  try {
    feed = await fetchFeed("https://linux.do/top.rss?period=daily");
  } catch {
    feed = await fetchFeed("https://linux.do/latest.rss");
  }

  return (feed.items ?? [])
    .filter(
      (item) =>
        item.title && item.link && !V2EX_OFF_TOPIC_RE.test(item.title),
    )
    .slice(0, limit)
    .map((item) => ({
      sourceId,
      title: (item.title ?? "").trim(),
      url: (item.link ?? "").trim(),
      excerpt: stripHtml(item.contentSnippet ?? item.content ?? "").slice(
        0,
        300,
      ),
      publishedAt: item.isoDate ? new Date(item.isoDate) : undefined,
      category: "tech" as const,
    }));
}

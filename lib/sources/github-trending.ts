import * as cheerio from "cheerio";
import type { RawArticle } from "./types";

/**
 * GitHub Trending page (https://github.com/trending) HTML scrape.
 *
 * Notes:
 *  - The page order is the trending ranking. We deliberately do NOT set
 *    publishedAt — every item would get a slightly-different `new Date()`
 *    and downstream sort-by-date would reverse the trending order. With
 *    publishedAt undefined the stable sort keeps insertion order.
 *  - `meta` holds the inline metadata strip (language · total stars ·
 *    forks · stars today) that the renderer shows above the description.
 */
export async function fetchGithubTrending(
  sourceId: string,
  limit = 25,
): Promise<RawArticle[]> {
  const html = await fetch("https://github.com/trending?since=daily", {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
  }).then((r) => r.text());

  const $ = cheerio.load(html);
  const items: RawArticle[] = [];

  $("article.Box-row").each((i, el) => {
    if (i >= limit) return false;
    const a = $(el).find("h2 a").first();
    const repo = (a.attr("href") ?? "").trim().replace(/^\//, "");
    if (!repo) return;

    const description = $(el).find("p").first().text().replace(/\s+/g, " ").trim();
    const f6 = $(el).find(".f6").first();
    const language = f6.find("[itemprop=programmingLanguage]").text().trim();
    const totalStars = f6
      .find("a")
      .filter((_, n) => ($(n).attr("href") ?? "").endsWith("/stargazers"))
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim();
    const forks = f6
      .find("a")
      .filter((_, n) => ($(n).attr("href") ?? "").endsWith("/forks"))
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim();
    const starsToday = f6
      .find("span")
      .filter((_, n) => /stars?\s+today/.test($(n).text()))
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim();

    const metaParts: string[] = [];
    if (language) metaParts.push(language);
    if (totalStars) metaParts.push(`★ ${totalStars}`);
    if (forks) metaParts.push(`🍴 ${forks}`);
    if (starsToday) metaParts.push(`📈 ${starsToday}`);
    const meta = metaParts.join(" · ");

    items.push({
      sourceId,
      title: repo,
      url: `https://github.com/${repo}`,
      excerpt: description.slice(0, 300),
      meta,
      // intentionally no publishedAt — see file header.
      category: "tech",
    });
  });

  return items;
}

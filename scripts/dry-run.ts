import "./_env";

import { sources } from "../lib/sources/registry";
import { fetchAllArticles } from "../lib/sources/fetch-all";
import type { ArticleInput } from "../lib/ai/pipeline";

// Source-fetch sanity check only — does NOT call the LLM. For the full
// ingest → digest → write-to-disk pipeline use `npm run daily` instead.
async function main() {
  console.log("Fetching from sources…\n");
  const articles: ArticleInput[] = await fetchAllArticles(sources);

  console.log(`\nTotal articles: ${articles.length}`);
  console.log("\nTop 10 articles:");
  articles.slice(0, 10).forEach((a, i) => {
    console.log(`  ${i + 1}. [${a.category}] ${a.title}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

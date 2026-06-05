/**
 * Source-config CLI. Two jobs:
 *
 *   npm run sources           - list all sources, grouped by status, with
 *                               per-locale filtering info; also validates
 *                               sources.config.json shape
 *   npm run sources:check     - validation only, exit 1 on schema errors
 *                               (suitable for CI / pre-commit hook)
 *
 * Adding / removing / disabling sources is done by editing
 * sources.config.json directly — JSON is the canonical store.
 */
import "./_env";

import { loadAllSources, REPORT_LOCALE } from "../lib/sources/registry";
import type { SourceDef } from "../lib/sources/types";

const arg = process.argv[2];

function pad(s: string | undefined, n: number): string {
  const v = s ?? "";
  if (v.length >= n) return v.slice(0, n);
  return v + " ".repeat(n - v.length);
}

function localesLabel(s: SourceDef): string {
  const ls = s.locales ?? ["zh", "en"];
  if (ls.length === 2) return "zh+en";
  return ls[0];
}

function statusIcon(s: SourceDef): string {
  if (s.enabled === false) return "✗";
  const ls = s.locales ?? ["zh", "en"];
  return ls.includes(REPORT_LOCALE) ? "✓" : "·";
}

function list(all: SourceDef[]): void {
  console.log("");
  console.log(`Source registry  (REPORT_LOCALE=${REPORT_LOCALE})`);
  console.log("");
  console.log(`  ✓ = active in current locale       ✗ = disabled`);
  console.log(`  · = enabled but filtered out by REPORT_LOCALE\n`);

  const byCat = new Map<string, SourceDef[]>();
  for (const s of all) {
    const arr = byCat.get(s.category) ?? [];
    arr.push(s);
    byCat.set(s.category, arr);
  }

  for (const [cat, list] of [...byCat.entries()].sort()) {
    console.log(`── ${cat} ─────────────────────────────────────`);
    console.log(
      `   ${pad("id", 24)} ${pad("name", 24)} ${pad("subcategory", 18)} ${pad("locales", 8)} type`,
    );
    for (const s of list) {
      console.log(
        `${statusIcon(s)}  ${pad(s.id, 24)} ${pad(s.name, 24)} ${pad(s.subcategory, 18)} ${pad(localesLabel(s), 8)} ${s.type}`,
      );
    }
    console.log("");
  }

  const total = all.length;
  const enabled = all.filter((s) => s.enabled !== false).length;
  const activeInLocale = all.filter((s) => {
    if (s.enabled === false) return false;
    const ls = s.locales ?? ["zh", "en"];
    return ls.includes(REPORT_LOCALE);
  }).length;

  console.log(`总计: ${total} 个 · enabled: ${enabled} · 当前 locale 有效: ${activeInLocale}`);
  console.log("");
  console.log(`改源配置: 直接编辑 sources.config.json（JSON 数组）`);
  console.log(`切 locale: 在 .env.local 设 REPORT_LOCALE=en (默认 zh)`);
  console.log("");
}

async function main(): Promise<void> {
  let all: SourceDef[];
  try {
    all = loadAllSources();
  } catch (e) {
    console.error(`✗ sources.config.json validation failed:`);
    console.error(`  ${(e as Error).message}`);
    process.exit(1);
  }

  if (arg === "check") {
    console.log(`✓ sources.config.json OK (${all.length} sources)`);
    return;
  }

  list(all);
}

main();

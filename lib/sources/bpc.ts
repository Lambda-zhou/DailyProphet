import {
  execFile,
  execFileSync,
  type ExecFileOptions,
  type ExecFileSyncOptions,
} from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RawArticle, SourceDef } from "./types";

interface BpcCommand {
  file: string;
  argsPrefix: string[];
  env: NodeJS.ProcessEnv;
}

interface BpcDiscoverArticle {
  title?: string;
  url?: string;
  date?: string;
  domain?: string;
  excerpt?: string;
}

interface BpcDiscoverOutput {
  ok?: boolean;
  error?: string;
  articles?: BpcDiscoverArticle[];
}

interface BpcBatchResult {
  ok?: boolean;
  url?: string;
  title?: string;
  path?: string;
  skipped?: boolean;
  error?: string;
}

interface BpcBatchOutput {
  ok?: boolean;
  error?: string;
  results?: BpcBatchResult[];
}

interface MarkdownArticle {
  title?: string;
  date?: string;
  excerpt?: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const INTERNAL_BPC_SRC = path.resolve(PROJECT_ROOT, "tools", "bpc-fetch", "src");
const DEFAULT_CACHE_DIR = path.resolve(PROJECT_ROOT, "daily_reports", ".bpc-cache");
let cachedPython: string | null | undefined;

export async function fetchBpc(source: SourceDef): Promise<RawArticle[]> {
  const domain = normalizeDomain(source.url);
  if (!domain) throw new Error(`${source.id}: bpc source url must be a domain`);

  const limit = source.bpcLimit ?? 10;
  const since = source.bpcSince ?? "today";
  const discovered = await runBpcJson<BpcDiscoverOutput>(
    ["discover", domain, "--since", since, "--limit", String(limit), "--compact"],
    90_000,
  );
  if (!discovered.ok) {
    throw new Error(discovered.error ?? `bpc-fetch discover failed for ${domain}`);
  }

  const articles = (discovered.articles ?? [])
    .filter((a): a is BpcDiscoverArticle & { url: string } => Boolean(a.url))
    .slice(0, limit);

  let markdownByUrl = new Map<string, MarkdownArticle>();
  if (source.bpcFetchFullText && articles.length > 0) {
    try {
      markdownByUrl = await fetchFullText(source, articles);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[bpc] ${source.id}: full-text fetch failed, using discovery metadata only: ${msg}`);
    }
  }

  return articles
    .map((article) => {
      const markdown = markdownByUrl.get(article.url);
      const title = markdown?.title || article.title || article.url;
      return {
        sourceId: source.id,
        title,
        url: article.url,
        excerpt: markdown?.excerpt || article.excerpt,
        publishedAt: parseDate(markdown?.date || article.date),
        category: source.category,
      };
    })
    .filter((article) => article.title && article.url);
}

async function fetchFullText(
  source: SourceDef,
  articles: Array<BpcDiscoverArticle & { url: string }>,
): Promise<Map<string, MarkdownArticle>> {
  const outRoot = process.env.BPC_FETCH_CACHE_DIR
    ? path.resolve(process.env.BPC_FETCH_CACHE_DIR)
    : DEFAULT_CACHE_DIR;
  const outDir = path.join(outRoot, source.id);
  const args = [
    "batch",
    ...articles.map((a) => a.url),
    "--out-dir",
    outDir,
    "--concurrency",
    String(source.bpcConcurrency ?? 2),
    "--incremental",
    "--compact",
  ];
  if (source.bpcNoImages ?? true) args.push("--no-images");

  const batch = await runBpcJson<BpcBatchOutput>(args, 300_000);
  if (!batch.ok) {
    throw new Error(batch.error ?? "bpc-fetch batch failed");
  }

  const byUrl = new Map<string, MarkdownArticle>();
  for (const result of batch.results ?? []) {
    if (!result.ok || !result.url || !result.path) continue;
    try {
      byUrl.set(result.url, await readMarkdownArticle(result.path));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[bpc] ${source.id}: cannot read ${result.path}: ${msg}`);
    }
  }
  return byUrl;
}

async function runBpcJson<T>(args: string[], timeoutMs: number): Promise<T> {
  const command = resolveBpcCommand();
  const { stdout, stderr } = await execFileCapture(
    command.file,
    [...command.argsPrefix, ...args],
    {
      cwd: PROJECT_ROOT,
      env: command.env,
      maxBuffer: 5 * 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
    },
  );

  const text = stdout.trim();
  if (!text) {
    const tail = stderr.trim().split(/\r?\n/).slice(-3).join(" ");
    throw new Error(tail ? `bpc-fetch produced no JSON: ${tail}` : "bpc-fetch produced no JSON");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`bpc-fetch returned invalid JSON: ${text.slice(0, 240)}`);
  }
}

function execFileCapture(
  file: string,
  args: string[],
  options: ExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        const stderrTail = String(stderr).trim().split(/\r?\n/).slice(-4).join(" ");
        reject(new Error(stderrTail || error.message));
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function resolveBpcCommand(): BpcCommand {
  const explicitBin = process.env.BPC_FETCH_BIN?.trim();
  if (explicitBin) {
    return { file: explicitBin, argsPrefix: [], env: process.env };
  }

  if (existsSync(path.join(INTERNAL_BPC_SRC, "bpc_fetch", "__init__.py"))) {
    const python = resolvePythonForBpc();
    const existingPath = process.env.PYTHONPATH;
    const existingHistoryDb = process.env.BPC_FETCH_HISTORY_DB;
    return {
      file: python,
      argsPrefix: ["-m", "bpc_fetch"],
      env: {
        ...process.env,
        BPC_FETCH_HISTORY_DB:
          existingHistoryDb || path.join(DEFAULT_CACHE_DIR, "history.db"),
        PYTHONPATH: [INTERNAL_BPC_SRC, existingPath].filter(Boolean).join(path.delimiter),
      },
    };
  }

  return { file: "bpc-fetch", argsPrefix: [], env: process.env };
}

function resolvePythonForBpc(): string {
  if (cachedPython !== undefined) {
    if (cachedPython === null) {
      throw new Error("bpc-fetch requires Python 3.11+; set BPC_FETCH_PYTHON to a compatible interpreter");
    }
    return cachedPython;
  }

  const candidates = new Set<string>();
  for (const candidate of [
    process.env.BPC_FETCH_PYTHON?.trim(),
    process.env.PYTHON?.trim(),
  ]) {
    if (candidate) candidates.add(candidate);
  }

  if (process.platform === "win32") {
    for (const line of runSync("where.exe", ["python"])) {
      candidates.add(line);
    }
  }

  for (const fallback of process.platform === "win32" ? ["python"] : ["python3", "python"]) {
    candidates.add(fallback);
  }

  for (const candidate of candidates) {
    const version = detectPythonVersion(candidate);
    if (version && version.major === 3 && version.minor >= 11) {
      cachedPython = candidate;
      return candidate;
    }
  }

  cachedPython = null;
  throw new Error("bpc-fetch requires Python 3.11+; set BPC_FETCH_PYTHON to a compatible interpreter");
}

function detectPythonVersion(candidate: string): { major: number; minor: number } | null {
  const lines = runSync(candidate, [
    "-c",
    "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')",
  ]);
  if (lines.length === 0) return null;
  const match = /^(\d+)\.(\d+)$/.exec(lines[0].trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
  };
}

function runSync(file: string, args: string[]): string[] {
  const options: ExecFileSyncOptions = {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  };
  try {
    const stdout = execFileSync(file, args, options);
    return String(stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function normalizeDomain(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return trimmed.replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  }
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

async function readMarkdownArticle(mdPath: string): Promise<MarkdownArticle> {
  const markdown = await readFile(mdPath, "utf8");
  return {
    title: readFrontmatterValue(markdown, "title"),
    date: readFrontmatterValue(markdown, "date"),
    excerpt: markdownToExcerpt(markdown),
  };
}

function readFrontmatterValue(markdown: string, key: "title" | "date"): string | undefined {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) return undefined;
  const match = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(frontmatter[1]);
  if (!match) return undefined;
  const value = match[1].trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  return value;
}

function markdownToExcerpt(markdown: string): string {
  return markdown
    .replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, "")
    .replace(/^# .+$/m, "")
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_>#-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

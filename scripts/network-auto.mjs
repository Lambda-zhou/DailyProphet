#!/usr/bin/env node
/**
 * Auto-proxy wrapper.
 *
 * Default behavior:
 *   1. Load .env.local if present
 *   2. Probe representative URLs without proxy
 *   3. If direct access passes, run the target command with proxy vars cleared
 *   4. If direct access fails and AUTO_PROXY_* is configured, rerun with proxy vars injected
 *
 * Usage:
 *   node scripts/network-auto.mjs npm run daily
 *   node scripts/network-auto.mjs npm run dry-run
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
process.chdir(projectRoot);

loadDotEnv(path.join(projectRoot, ".env.local"));

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
  console.log(`daily-brief network wrapper

Usage:
  node scripts/network-auto.mjs <command> [args...]

Environment:
  AUTO_PROXY_MODE=auto|direct|proxy
  AUTO_PROXY_URL=http://127.0.0.1:7890
  AUTO_HTTP_PROXY=
  AUTO_HTTPS_PROXY=
  AUTO_ALL_PROXY=
  AUTO_PROXY_TEST_URLS=https://www.bbc.com,https://www.ft.com
  AUTO_PROXY_SUCCESS_POLICY=all|any
  AUTO_PROXY_TIMEOUT_MS=8000
`);
  process.exit(0);
}

const PROXY_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
];

const mode = (process.env.AUTO_PROXY_MODE ?? "auto").toLowerCase();
const successPolicy = (process.env.AUTO_PROXY_SUCCESS_POLICY ?? "all").toLowerCase();
const timeoutMs = parsePositiveInt(process.env.AUTO_PROXY_TIMEOUT_MS, 8000);
const testUrls = splitCsv(process.env.AUTO_PROXY_TEST_URLS).length
  ? splitCsv(process.env.AUTO_PROXY_TEST_URLS)
  : ["https://www.bbc.com", "https://www.ft.com"];

const baseEnv = { ...process.env };
for (const key of PROXY_KEYS) delete baseEnv[key];

const proxyEnv = buildProxyEnv();
const hasProxy = Object.keys(proxyEnv).length > 0;

const networkMode =
  mode === "proxy"
    ? "proxy"
    : mode === "direct"
      ? "direct"
      : await resolveNetworkMode(testUrls, successPolicy, timeoutMs, hasProxy);

const childEnv = networkMode === "proxy" ? { ...baseEnv, ...proxyEnv } : baseEnv;
const commandLabel = argv.join(" ");
if (networkMode === "proxy") {
  console.log(
    `[network-auto] direct probe failed; running with proxy for: ${commandLabel}`,
  );
} else if (networkMode === "direct-fallback") {
  console.warn(
    `[network-auto] direct probe failed and no proxy is configured; running direct anyway: ${commandLabel}`,
  );
} else {
  console.log(`[network-auto] direct network OK; running without proxy: ${commandLabel}`);
}

const child = spawn(argv[0], argv.slice(1), {
  cwd: projectRoot,
  env: childEnv,
  shell: process.platform === "win32",
  stdio: "inherit",
});

child.on("close", (code) => process.exit(code ?? 1));
child.on("error", (err) => {
  console.error(`[network-auto] failed to spawn child: ${err.message}`);
  process.exit(1);
});

async function resolveNetworkMode(urls, policy, timeout, proxyConfigured) {
  const results = await Promise.all(urls.map((url) => probe(url, timeout)));
  const directOk =
    policy === "any" ? results.some((result) => result.ok) : results.every((result) => result.ok);

  for (const result of results) {
    console.log(
      `[network-auto] probe ${result.ok ? "OK" : "FAIL"} ${result.url}` +
        (result.error ? ` (${result.error})` : ""),
    );
  }

  if (directOk) return "direct";
  if (!proxyConfigured) {
    console.warn("[network-auto] proxy fallback requested by probe, but AUTO_PROXY_* is not configured");
    return "direct-fallback";
  }
  return "proxy";
}

async function probe(url, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
    });
    response.body?.cancel().catch(() => {});
    return { url, ok: true, status: response.status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { url, ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

function buildProxyEnv() {
  const shared = trim(process.env.AUTO_PROXY_URL);
  const http = trim(process.env.AUTO_HTTP_PROXY) || shared;
  const https = trim(process.env.AUTO_HTTPS_PROXY) || shared;
  const all = trim(process.env.AUTO_ALL_PROXY) || shared;
  const env = {};
  if (http) {
    env.HTTP_PROXY = http;
    env.http_proxy = http;
  }
  if (https) {
    env.HTTPS_PROXY = https;
    env.https_proxy = https;
  }
  if (all) {
    env.ALL_PROXY = all;
    env.all_proxy = all;
  }
  return env;
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function splitCsv(value) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function trim(value) {
  return value?.trim() || "";
}

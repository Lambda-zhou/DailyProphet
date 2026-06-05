#!/usr/bin/env node
/**
 * Deploy the latest daily report to a remote host via scp+ssh.
 *
 * Triggered automatically by run-daily.mjs after a successful daily run.
 * Manual invocation:
 *   node scripts/deploy.mjs              # today's report
 *   node scripts/deploy.mjs 2026-05-20   # a specific date
 *
 * Configuration (in .env.local — gitignored, never shipped):
 *   DEPLOY_HOST=user@host           # e.g. ubuntu@1.2.3.4
 *   DEPLOY_PATH=/var/www/site       # remote document root
 *
 * Both unset → deploy is a no-op (most forks won't have a server).
 *
 * Server requirements (one-time, see README → 自托管部署):
 *   - sudo NOPASSWD for DEPLOY_HOST user
 *   - nginx site serving DEPLOY_PATH/index.html on the target domain
 *   - SSL certificate already configured (the .html itself has no sub-resources)
 */
import { config } from "dotenv";
// quiet: true suppresses dotenv v17's stdout banner advertising paid products.
config({ path: ".env.local", quiet: true });

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const host = process.env.DEPLOY_HOST;
const remotePath = process.env.DEPLOY_PATH;
if (!host || !remotePath) {
  console.log("[deploy] DEPLOY_HOST / DEPLOY_PATH not set in .env.local — skipping");
  process.exit(0);
}

// Pick the report to deploy:
//   - explicit arg wins (e.g. `npm run deploy 2026-05-20`)
//   - otherwise: today's date in REPORT_TZ (or system local if unset),
//     matching daily.ts's todayKey(). If that file doesn't exist (called
//     manually before today's run, or across a tz boundary), fall back to
//     the most recent <YYYY-MM-DD>/ directory on disk so manual invocations
//     always do something useful.
const dateArg = process.argv[2];
const todayLocal = new Intl.DateTimeFormat("en-CA", {
  timeZone: process.env.REPORT_TZ?.trim() || undefined,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

function reportPath(d) {
  return path.join("daily_reports", d, `${d}.html`);
}

let date;
let localFile;
if (dateArg) {
  date = dateArg;
  localFile = reportPath(date);
  if (!fs.existsSync(localFile)) {
    console.error(`[deploy] local file missing: ${localFile}`);
    process.exit(1);
  }
} else if (fs.existsSync(reportPath(todayLocal))) {
  date = todayLocal;
  localFile = reportPath(todayLocal);
} else {
  const dirs = fs
    .readdirSync("daily_reports")
    .filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f))
    .filter((f) => fs.existsSync(reportPath(f)))
    .sort();
  if (dirs.length === 0) {
    console.error("[deploy] no <YYYY-MM-DD>/<YYYY-MM-DD>.html files in daily_reports/");
    process.exit(1);
  }
  date = dirs[dirs.length - 1];
  localFile = reportPath(date);
  console.log(`[deploy] today (${todayLocal}) not generated yet, deploying latest: ${date}`);
}

const sizeKb = (fs.statSync(localFile).size / 1024).toFixed(1);
console.log(`[deploy] uploading ${localFile} (${sizeKb} KB) → ${host}:${remotePath}/`);

const tmpPath = `/tmp/daily-deploy-${date}.html`;
// shell:false so Windows cmd.exe doesn't try to interpret remote `&&`
// chains in the remoteCmd as local command chains.
const scp = spawnSync("scp", ["-q", localFile, `${host}:${tmpPath}`], {
  stdio: "inherit",
});
if (scp.status !== 0) {
  console.error(`[deploy] scp failed (exit ${scp.status})`);
  process.exit(1);
}

// Single ssh round-trip: move into doc root, refresh index, chown.
// Done sudo'd because the doc root is owned by www-data.
const remoteCmd = [
  `sudo mv ${tmpPath} ${remotePath}/${date}.html`,
  `sudo cp ${remotePath}/${date}.html ${remotePath}/index.html`,
  `sudo chown www-data:www-data ${remotePath}/${date}.html ${remotePath}/index.html`,
].join(" && ");

const ssh = spawnSync("ssh", [host, remoteCmd], {
  stdio: "inherit",
});
if (ssh.status !== 0) {
  console.error(`[deploy] ssh failed (exit ${ssh.status})`);
  process.exit(1);
}

console.log(`[deploy] OK — ${date}.html deployed`);

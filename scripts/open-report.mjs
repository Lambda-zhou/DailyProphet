#!/usr/bin/env node
/**
 * Open the latest (or specified-date) daily report HTML in a browser.
 * Cross-platform: prefers Chrome on Windows (file association often hijacked
 * by Edge), uses `open` on macOS, `xdg-open` on Linux.
 *
 * Usage:
 *   node scripts/open-report.mjs
 *   node scripts/open-report.mjs 2026-05-17
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const reportsDir = path.join(projectRoot, "daily_reports");

function pickReport(dateArg) {
  if (!fs.existsSync(reportsDir)) {
    throw new Error(`No daily_reports directory at ${reportsDir}`);
  }
  if (dateArg) {
    const target = path.join(reportsDir, dateArg, `${dateArg}.html`);
    if (!fs.existsSync(target)) {
      throw new Error(`No report for ${dateArg}: ${target}`);
    }
    return target;
  }
  const dirs = fs
    .readdirSync(reportsDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f))
    .map((d) => ({ d, file: path.join(reportsDir, d, `${d}.html`) }))
    .filter((x) => fs.existsSync(x.file))
    .sort((a, b) => b.d.localeCompare(a.d));
  if (dirs.length === 0) {
    throw new Error(`No HTML reports in ${reportsDir}. Run \`npm run daily\` first.`);
  }
  return dirs[0].file;
}

function findChromeWindows() {
  const candidates = [
    process.env.ProgramFiles &&
      path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
    process.env["ProgramFiles(x86)"] &&
      path.join(process.env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env.LocalAppData &&
      path.join(process.env.LocalAppData, "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p));
}

function openInBrowser(file) {
  const fileUrl = "file:///" + file.replace(/\\/g, "/");
  if (process.platform === "win32") {
    const chrome = findChromeWindows();
    if (chrome) {
      spawn(chrome, [fileUrl], { detached: true, stdio: "ignore" }).unref();
      console.log(`Opened in Chrome: ${file}`);
      return;
    }
    // Fall back to default association via cmd start
    console.warn("Chrome not found, using default file association.");
    spawn("cmd", ["/c", "start", "", file], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "darwin") {
    // -a "Google Chrome" prefers Chrome but falls through to default if unavailable
    spawn("open", ["-a", "Google Chrome", file], { detached: true, stdio: "ignore" })
      .on("error", () => {
        // -a Chrome failed → use default open
        spawn("open", [file], { detached: true, stdio: "ignore" }).unref();
      })
      .unref();
    console.log(`Opened: ${file}`);
  } else {
    // Linux (and any other Unix)
    spawn("xdg-open", [file], { detached: true, stdio: "ignore" }).unref();
    console.log(`Opened: ${file}`);
  }
}

try {
  const target = pickReport(process.argv[2]);
  openInBrowser(target);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}

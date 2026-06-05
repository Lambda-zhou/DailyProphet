#!/usr/bin/env node
/**
 * Cross-platform installer for the daily-brief pipeline.
 *
 * Per-platform scheduling:
 *   - Windows  →  Task Scheduler (via PowerShell Register-ScheduledTask)
 *                 + WakeToRun + wake timers in power plan
 *   - macOS    →  launchd plist at ~/Library/LaunchAgents/com.daily-brief.plist
 *   - Linux    →  user crontab entry
 *
 * Common:
 *   - Writes ~/.daily-brief-config recording the project's absolute path so
 *     slash commands and SKILL.md can locate it from any cwd
 *   - With --global, also links the project's .claude/skills + .claude/commands
 *     to the user-level ~/.claude/ so /run-daily etc. work in any Claude Code
 *     session regardless of cwd
 *
 * Usage:
 *   node scripts/install.mjs                  # default 08:00, project-local skill
 *   node scripts/install.mjs --at 07:30
 *   node scripts/install.mjs --global         # also install user-level skill
 *   node scripts/install.mjs --at 07:30 --global
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = { at: "08:00", global: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--at") args.at = argv[++i];
    else if (argv[i] === "--global") args.global = true;
    else if (argv[i] === "--help" || argv[i] === "-h") args.help = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`Usage: node scripts/install.mjs [--at HH:MM] [--global]

  --at HH:MM   Daily trigger time (24-hour, local). Default: 08:00
  --global     Also link skill/commands to user-level ~/.claude/ so they
               work from any Claude Code session, not just one in the
               project directory.
`);
  process.exit(0);
}

if (!/^\d{2}:\d{2}$/.test(args.at)) {
  throw new Error(`Invalid --at value '${args.at}'. Use HH:MM (24-hour) like '08:00' or '07:30'.`);
}

const wrapperPath = path.join(projectRoot, "scripts", "run-daily.mjs");
if (!fs.existsSync(wrapperPath)) {
  throw new Error(`Expected wrapper at ${wrapperPath} — is this the project root?`);
}

console.log("=== daily-brief — install ===");
console.log(`Project root: ${projectRoot}`);
console.log(`Platform:     ${process.platform}`);
console.log(`Trigger:      Daily at ${args.at} (local)`);
console.log(`Global skill: ${args.global ? "YES" : "no"}\n`);

// ============================================================
// Platform-specific scheduling
// ============================================================

function installWindows(at) {
  // Use Register-ScheduledTask via PowerShell. schtasks.exe doesn't support
  // -WakeToRun / -AllowStartIfOnBatteries easily without XML import.
  const psScript = `
$action = New-ScheduledTaskAction \`
    -Execute 'node.exe' \`
    -Argument '"${wrapperPath}"' \`
    -WorkingDirectory '${projectRoot}'

$trigger = New-ScheduledTaskTrigger -Daily -At "${at}"

$settings = New-ScheduledTaskSettingsSet \`
    -WakeToRun \`
    -StartWhenAvailable \`
    -AllowStartIfOnBatteries \`
    -DontStopIfGoingOnBatteries \`
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

$principal = New-ScheduledTaskPrincipal \`
    -UserId $env:USERNAME \`
    -LogonType Interactive \`
    -RunLevel Limited

Register-ScheduledTask \`
    -TaskName "DailyBrief" \`
    -Action $action \`
    -Trigger $trigger \`
    -Settings $settings \`
    -Principal $principal \`
    -Description "Generate daily AI/finance/politics/trading digest" \`
    -Force | Out-Null

Write-Host "[OK] Task 'DailyBrief' registered"

# Enable wake timers in active power plan (needed for WakeToRun on battery)
$ALLOW_WAKE_TIMERS = "BD3B718A-0680-4D9D-8AB2-E1D2B4AC806D"
$SUB_SLEEP = "SUB_SLEEP"
try {
    powercfg /setacvalueindex SCHEME_CURRENT $SUB_SLEEP $ALLOW_WAKE_TIMERS 1 | Out-Null
    powercfg /setdcvalueindex SCHEME_CURRENT $SUB_SLEEP $ALLOW_WAKE_TIMERS 1 | Out-Null
    powercfg /setactive SCHEME_CURRENT | Out-Null
    Write-Host "[OK] Wake timers enabled (AC + battery)"
} catch {
    Write-Warning "Could not enable wake timers: $_"
}
`;

  const tmpScript = path.join(os.tmpdir(), `daily-brief-install-${Date.now()}.ps1`);
  fs.writeFileSync(tmpScript, psScript, "utf8");
  try {
    execSync(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${tmpScript}"`, {
      stdio: "inherit",
    });
  } finally {
    try {
      fs.unlinkSync(tmpScript);
    } catch {}
  }
}

function installMacOS(at) {
  const [hour, minute] = at.split(":").map(Number);
  const label = "com.daily-brief";
  const logOut = path.join(projectRoot, "logs", "launchd.out.log");
  const logErr = path.join(projectRoot, "logs", "launchd.err.log");
  fs.mkdirSync(path.dirname(logOut), { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${process.execPath}</string>
        <string>${wrapperPath}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${projectRoot}</string>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>${hour}</integer>
        <key>Minute</key>
        <integer>${minute}</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>${logOut}</string>
    <key>StandardErrorPath</key>
    <string>${logErr}</string>
    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
`;
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, plist, "utf8");

  // Unload (if previously loaded) then load
  spawnSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
  const load = spawnSync("launchctl", ["load", plistPath], { stdio: "inherit" });
  if (load.status !== 0) {
    throw new Error(`launchctl load failed for ${plistPath}`);
  }
  console.log(`[OK] launchd job installed: ${plistPath}`);
  console.log("    Note: macOS may not wake the machine from deep sleep for launchd");
  console.log("    timers. If you need wake-from-sleep, configure pmset wake schedule");
  console.log("    separately (sudo pmset repeat wakeorpoweron MTWRFSU HH:MM:SS).");
}

function installLinux(at) {
  const [hour, minute] = at.split(":");
  const marker = "# daily-brief";
  const logOut = path.join(projectRoot, "logs", "cron.log");
  fs.mkdirSync(path.dirname(logOut), { recursive: true });

  const cronLine = `${minute} ${hour} * * * cd "${projectRoot}" && "${process.execPath}" "${wrapperPath}" >> "${logOut}" 2>&1 ${marker}`;

  // Read existing crontab (empty if none exists)
  let existing = "";
  const list = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  if (list.status === 0 && list.stdout) {
    existing = list.stdout;
  }

  // Strip any prior daily-brief line
  const filtered = existing
    .split("\n")
    .filter((line) => !line.includes(marker))
    .join("\n")
    .trim();

  const newCrontab = (filtered ? filtered + "\n" : "") + cronLine + "\n";

  // Pipe back to crontab via stdin
  const install = spawnSync("crontab", ["-"], {
    input: newCrontab,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (install.status !== 0) {
    throw new Error("crontab install failed");
  }
  console.log(`[OK] Cron entry installed for ${at} daily`);
  console.log("    Note: cron doesn't wake the machine from sleep.");
  console.log("    If the system is suspended at the trigger time the run is skipped.");
}

// ============================================================
// User-level skill linking (--global)
// ============================================================

function symlinkOrCopy(from, to) {
  // Try filesystem symlink first; fall back to copy if symlink is not
  // permitted (Windows without Developer Mode / admin, or cross-fs limits).
  try {
    fs.symlinkSync(from, to, fs.statSync(from).isDirectory() ? "junction" : "file");
    console.log(`[OK] link:   ${to}  ->  ${from}`);
    return "link";
  } catch (e) {
    fs.cpSync(from, to, { recursive: true, force: true });
    console.log(`[OK] copy:   ${to}  (re-run install to refresh after editing project files)`);
    return "copy";
  }
}

function installUserLevelSkill() {
  console.log("\n=== Installing user-level skill + commands ===");

  const userClaude = path.join(os.homedir(), ".claude");
  const userSkillsDir = path.join(userClaude, "skills");
  const userCmdsDir = path.join(userClaude, "commands");
  const userSkill = path.join(userSkillsDir, "daily-brief");

  const projSkill = path.join(projectRoot, ".claude", "skills", "daily-brief");
  const projRunCmd = path.join(projectRoot, ".claude", "commands", "run-daily.md");
  const projCheckCmd = path.join(projectRoot, ".claude", "commands", "check-daily.md");

  for (const p of [projSkill, projRunCmd, projCheckCmd]) {
    if (!fs.existsSync(p)) {
      throw new Error(`Missing project file: ${p} — repo incomplete`);
    }
  }

  fs.mkdirSync(userSkillsDir, { recursive: true });
  fs.mkdirSync(userCmdsDir, { recursive: true });

  // Skill directory: junction on Windows (cross-drive OK), symlink elsewhere
  if (fs.existsSync(userSkill)) {
    fs.rmSync(userSkill, { recursive: true, force: true });
  }
  symlinkOrCopy(projSkill, userSkill);

  // Slash command files
  for (const cmd of [
    { user: "run-daily.md", proj: projRunCmd },
    { user: "check-daily.md", proj: projCheckCmd },
  ]) {
    const userPath = path.join(userCmdsDir, cmd.user);
    if (fs.existsSync(userPath)) {
      fs.rmSync(userPath, { force: true });
    }
    symlinkOrCopy(cmd.proj, userPath);
  }
}

// ============================================================
// Main
// ============================================================

if (process.platform === "win32") {
  installWindows(args.at);
} else if (process.platform === "darwin") {
  installMacOS(args.at);
} else if (process.platform === "linux") {
  installLinux(args.at);
} else {
  throw new Error(`Unsupported platform: ${process.platform}`);
}

// Always write config so slash commands can locate the project from any cwd
const configPath = path.join(os.homedir(), ".daily-brief-config");
fs.writeFileSync(configPath, projectRoot, "utf8");
console.log(`[OK] config: ${configPath} = ${projectRoot}`);

if (args.global) {
  installUserLevelSkill();
}

console.log("\n✓ Installed!");
console.log(`Test immediately:  node "${wrapperPath}"`);
if (args.global) {
  console.log("Or via Claude Code: /run-daily   (works from any directory)");
} else {
  console.log("Re-run with --global to enable /run-daily from any Claude Code session");
}
console.log("Uninstall:         node scripts/uninstall.mjs");

---
description: Trigger the daily digest now (background via OS scheduler) and monitor until completion
---

Run the daily digest **right now**. Don't ask for confirmation — the user explicitly invoked this.

## Step 0: locate the project root (cross-platform, works from any cwd)

Read the path from `~/.daily-brief-config` (written by `install.mjs`). Use a small Node one-liner so it works on Windows / macOS / Linux:

```bash
node -e "const fs=require('fs'),os=require('os'),path=require('path');const cfg=path.join(os.homedir(),'.daily-brief-config');if(fs.existsSync(cfg)){process.chdir(fs.readFileSync(cfg,'utf8').trim());console.log(process.cwd())}else if(fs.existsSync('package.json')){console.log(process.cwd())}else{console.error('daily-brief not installed. Run bootstrap or: node scripts/install.mjs --global');process.exit(1)}"
```

That command prints the resolved project root. cd into it before running anything else:
- **Windows PowerShell**: `Set-Location (node -e "...")`
- **bash / zsh**: `cd "$(node -e '...')"`

If the Node check exits non-zero, the user hasn't installed yet — tell them to run the bootstrap or `node scripts/install.mjs --global` manually.

## Step 1: trigger the scheduled task (platform-specific)

**Windows**:
```powershell
Start-ScheduledTask -TaskName DailyBrief
Start-Sleep -Seconds 3
Get-ScheduledTaskInfo -TaskName DailyBrief | Format-List LastRunTime, LastTaskResult
```
Confirm `LastTaskResult = 267009` (running).

**macOS**:
```bash
launchctl start com.daily-brief
# Status: launchctl list | grep daily-brief
```

**Linux** (cron, no manual trigger — just run the wrapper directly):
```bash
node scripts/run-daily.mjs &
```

If "task not found" / "could not find specified service": user hasn't run the installer. Tell them to run `node scripts/install.mjs --global`.

## Step 2: monitor in background

The daily run produces `logs/daily-<YYYY-MM-DD>.log` (local date). Tail it as it grows:

```bash
# Polling approach (works any platform):
node -e "const fs=require('fs');const f='logs/daily-'+new Date().toISOString().slice(0,10)+'.log';let prev=0;const t=setInterval(()=>{if(fs.existsSync(f)){const s=fs.readFileSync(f,'utf8');if(s.includes('] OK')){console.log('DONE OK');clearInterval(t)}else if(s.match(/]\sFAILED/)){console.log('DONE FAILED');clearInterval(t)}}},30000)"
```

Or use `run_in_background` with the OS-specific status check (Get-ScheduledTaskInfo on Windows, `launchctl list` on macOS). Poll every 30s, max 12 min.

## Step 3: report when done

- Decode result: log ends with `] OK` (success) or `] FAILED:` (error)
- Tail last 30 lines of `logs/daily-<local-date>.log`
- List files in `daily_reports/` modified today

## Step 4: failure handling

If failed:
- Tail log, identify failure phase (fetch / enrichment / trading / digest)
- Propose a fix
- Don't auto-retry — let the user decide

Chrome (or system default browser) opens automatically on success — `run-daily.mjs` calls `npm run open` at the end.

Project context for diagnostics is in the `daily-brief` skill — load it if needed.

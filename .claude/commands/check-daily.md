---
description: Check the daily pipeline's state — last run, today's report files, Sonnet quota, recent failures
---

Show the current state of the daily pipeline. Just gather and report, don't ask anything.

## Step 0: locate the project root (cross-platform)

```bash
node -e "const fs=require('fs'),os=require('os'),path=require('path');const cfg=path.join(os.homedir(),'.daily-brief-config');if(fs.existsSync(cfg)){process.chdir(fs.readFileSync(cfg,'utf8').trim());console.log(process.cwd())}else if(fs.existsSync('package.json')){console.log(process.cwd())}else{console.error('daily-brief not installed');process.exit(1)}"
```

cd into the printed path before running anything else.

## Step 1: gather status (platform-specific where needed)

Run these and summarize:

**Scheduled task state**

- **Windows**: `Get-ScheduledTaskInfo -TaskName DailyBrief | Format-List LastRunTime, LastTaskResult, NextRunTime, NumberOfMissedRuns`
- **macOS**: `launchctl list | grep com.daily-brief`  (PID + last exit code)
- **Linux**: `crontab -l | grep daily-brief`  (just confirms the entry exists; cron doesn't track per-job last-run)

If the task/job isn't registered: tell the user to run `node scripts/install.mjs --global`.

**Latest report files** (cross-platform):
```bash
node -e "const fs=require('fs'),path=require('path');const root='daily_reports';if(!fs.existsSync(root)){console.log('(no reports yet)');return}fs.readdirSync(root).filter(d=>/^\d{4}-\d{2}-\d{2}/.test(d)).sort().reverse().slice(0,3).forEach(d=>{const f=path.join(root,d,d+'.html');if(fs.existsSync(f)){const s=fs.statSync(f);console.log(d.padEnd(25),s.size+'B',s.mtime.toISOString())}})"
```

**Today's log tail** (local date):
```bash
node -e "const fs=require('fs');const d=new Date();const pad=n=>String(n).padStart(2,'0');const f='logs/daily-'+d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'.log';if(fs.existsSync(f)){console.log(fs.readFileSync(f,'utf8').split('\n').slice(-15).join('\n'))}else{console.log('No log for today yet.')}"
```

**Sonnet quota**:
```bash
npm run quota-report 2>&1 | tail -25
```

## Step 2: synthesize

Short status:
- ✓ / ✗ Last run result
- 📅 Next run time
- 📄 Latest report file (date + size)
- 🔢 Sonnet 5h-window utilization
- ⚠ Anomalies (failed run, missing today's file when expected, quota near limit)

If healthy, keep it short. If something's wrong, propose the diagnostic next step from the `daily-brief` skill's flow.

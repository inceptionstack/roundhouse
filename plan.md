# Roundhouse Plan

## Priority Order
1. Config migration (~/.config/roundhouse/ → ~/.roundhouse/)
2. Cron system (internal scheduler)
3. Heartbeat / health endpoint

---

## 1. Config Directory Migration

**From:** `~/.config/roundhouse/` → **To:** `~/.roundhouse/`

New layout:
```
~/.roundhouse/
  gateway.config.json
  env
  crons/              # job definitions
  cron-state/         # mutable scheduler state
  cron-runs/          # run history
  incoming/           # attachment storage (already here)
  whisper-tmp/        # STT temp (already here)
```

Migration strategy:
- New canonical: `~/.roundhouse/`
- Fallback read from `~/.config/roundhouse/` with deprecation warning
- `roundhouse install` writes to new path
- Doctor check for stale old-path configs

Files to update: config.ts, cli.ts (install), doctor checks, gateway.ts, README.md, architecture.md

---

## 2. Cron System — Internal Scheduler (Cross-Platform)

### Architecture
```
Gateway process
  → CronSchedulerService (started after chat init)
      → setInterval tick every 60s
      → Load/hot-reload jobs from ~/.roundhouse/crons/*.json
      → Check which are due (timezone-aware via croner)
      → Execute: fresh agent per run, dispose after
      → Save results to ~/.roundhouse/cron-runs/
      → Notify Telegram directly
      → Catch-up missed jobs on startup
```

### Key design decisions
- **Internal scheduler, not OS cron** — cross-platform (Linux, Mac, Windows)
- **Fresh agent per run** — not shared with gateway's interactive agent
- **croner package** — zero-dep cron expression parser with IANA timezone support
- **Separate job config and state files** — hot reload without losing state
- **Catch-up: latest only by default** — prevent runaway after long downtime

### Schedule types
```json
{ "type": "cron", "cron": "0 8 * * *", "tz": "Asia/Jerusalem" }
{ "type": "interval", "every": "6h" }
{ "type": "once", "at": "2026-04-28T08:00:00", "tz": "Asia/Jerusalem" }
{ "type": "once", "at": "30m" }
```

### Job config (standalone JSON per job)
```json
{
  "id": "daily-report",
  "enabled": true,
  "createdAt": "2026-04-27T12:00:00.000Z",
  "updatedAt": "2026-04-27T12:00:00.000Z",
  "schedule": { "type": "cron", "cron": "0 8 * * *", "tz": "Asia/Jerusalem" },
  "prompt": "Prepare my daily report for {{date.local}}.",
  "timeoutMs": 1800000,
  "catchUp": { "mode": "latest", "maxRuns": 1 },
  "notify": {
    "telegram": { "chatIds": ["123456789"], "onlyOn": "always" }
  }
}
```

### Template variables
```
{{job.id}}, {{run.id}}, {{run.scheduledAt}}, {{date.iso}}, {{date.local}}, {{vars.name}}
```
Unknown vars fail validation at add/edit time. No JS eval.

### CLI commands
```
roundhouse cron add <id> --prompt "..." --cron "0 8 * * *" --tz Asia/Jerusalem --telegram 123
roundhouse cron add <id> --prompt "..." --every 6h
roundhouse cron add <id> --prompt "..." --at 30m
roundhouse cron list [--json]
roundhouse cron show <id>
roundhouse cron trigger <id>        # works without gateway running
roundhouse cron runs <id>
roundhouse cron edit <id> [flags]
roundhouse cron pause <id>
roundhouse cron resume <id>
roundhouse cron delete <id>
```

### Telegram /crons
```
/crons                  # list all jobs
/crons show <id>        # job details + last run
/crons trigger <id>     # run now
/crons pause <id>
/crons resume <id>
```

### Conversational setup
User says: "set a cron daily 8am Israel time to give me current AWS costs"
Agent runs:
```bash
roundhouse cron add aws-costs \
  --cron "0 8 * * *" \
  --tz "Asia/Jerusalem" \
  --prompt "Check current AWS costs. Summarize MTD spend, yesterday, major services, anomalies." \
  --telegram "123456789" \
  --timeout 30m
```

### New files
```
src/cron/types.ts       # CronJobConfig, CronJobState, CronRunRecord, CronSchedule
src/cron/durations.ts   # parse "6h", "30m", "2d" → ms
src/cron/template.ts    # {{var}} renderer
src/cron/schedule.ts    # isDue(), nextRun() using croner
src/cron/store.ts       # read/write/list job JSON, state, run records
src/cron/runner.ts      # create fresh agent, render prompt, run, notify
src/cron/scheduler.ts   # CronSchedulerService: tick, catch-up, hot reload
src/cron/format.ts      # Telegram formatting for /crons
src/cli/cron.ts         # CLI cron subcommands
src/notify/telegram.ts  # shared Telegram sender (extract from gateway)
```

### Concurrency
**Global:** max 1 concurrent cron run by default (agents share workspace/LLM)
**Per-job:** in-memory `running` map prevents same job overlapping itself

When capacity is full:
- Due jobs enter a bounded queue (default 15min timeout)
- If still blocked after timeout → mark `missed` with reason
- Never silently drop — queue, don't skip
- Coalesce queued duplicates for "latest only" catch-up jobs

Deterministic jitter: hash(job.id) → 0-90s offset to smooth overlapping schedules

Config:
```json
{
  "scheduler": {
    "maxConcurrentRuns": 1,
    "queueTimeoutMs": 900000,
    "jitterWindowMs": 90000
  }
}
```

User visibility:
- `cron add` warns about overlapping jobs at same time
- `/crons list` shows: scheduled, queued, running, missed, failed, completed
- Run history records: scheduled time, actual start, queue duration, skip reason

### Long-running jobs
- Default timeout: 30 minutes
- agent.abort(threadId) on timeout
- Always dispose fresh agent
- Stale running state detected on restart → mark as abandoned

### Hot reload
- Poll job files every tick (check mtime)
- Optional fs.watch as fast path
- Invalid JSON → keep last valid, expose error in /status

### Security
- Cron prompts are privileged automation (can run tools)
- Only allowed users can manage via Telegram
- Job files mode 0600
- Audit: createdAt, updatedAt in job config
- No secrets in job JSON

---

## 3. Heartbeat / Health Endpoint (after cron)
```
src/heartbeat.ts — node:http on 127.0.0.1:8787
GET /healthz     — liveness (cheap, always fast)
GET /readyz      — readiness (chat initialized)
GET /status.json — rich diagnostics + cached doctor + scheduler state
```

---

## 4. Future Items
- TTS (outgoing voice replies)
- Internal maintenance timers (session compaction, cache cleanup) — NOT called "crons"
- Cross-platform session unification
- Multi-agent routing

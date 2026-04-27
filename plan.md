# Roundhouse Plan

## Pending Design Decisions & TODOs

### Config Directory Migration (HIGH PRIORITY — do before cron)
**Decision: Migrate from `~/.config/roundhouse/` to `~/.roundhouse/`**

Rationale: Currently split — config in `~/.config/roundhouse/`, runtime in `~/.roundhouse/`. Consolidate to `~/.roundhouse/` like `~/.pi/`, `~/.docker/`, `~/.aws/`.

New layout:
```
~/.roundhouse/
  gateway.config.json     # gateway config
  env                     # secrets (0600)
  crons/                  # cron job definitions
  cron-runs/              # cron execution history
  incoming/               # attachment storage (already here)
  whisper-tmp/            # STT temp (already here)
```

Migration:
- New canonical root: `~/.roundhouse/`
- On startup: check new path first, fall back to `~/.config/roundhouse/` with deprecation warning
- `roundhouse install` writes to new path
- `roundhouse doctor` checks for stale old-path configs

Files to update: `src/config.ts`, `src/cli/cli.ts` (install), `src/cli/doctor/checks/config.ts`, `src/gateway.ts` (env file path), `architecture.md`, `README.md`.

### Cron System (NEXT — after config migration)
**Decision: Linux cron triggers `roundhouse cron tick` every minute**

Architecture:
```
Linux crontab (single entry)
  → * * * * * roundhouse cron tick
      → Load jobs from ~/.roundhouse/crons/
      → Check which are due (timezone-aware)
      → Execute due jobs (fresh agent session per run)
      → Save results to ~/.roundhouse/cron-runs/
      → Notify Telegram/chat targets
```

#### CLI Commands
```
roundhouse cron add <id> [flags]    # create job + install tick crontab
roundhouse cron list                # list all jobs
roundhouse cron show <id>           # show job details + last run
roundhouse cron run <id>            # trigger now
roundhouse cron runs <id>           # show run history
roundhouse cron edit <id> [flags]   # modify job
roundhouse cron pause <id>          # disable without removing
roundhouse cron resume <id>         # re-enable
roundhouse cron delete <id>         # remove job + clean crontab if last
roundhouse cron tick                # called by crontab every minute
```

#### Schedule Types
```
--cron "0 8 * * *" --tz "Asia/Jerusalem"    # standard cron expression
--every "6h"                                  # fixed interval
--at "30m"                                    # one-shot (relative)
--at "2026-04-28T08:00:00"                    # one-shot (absolute)
```

#### Session Modes
```
--session isolated     # fresh session per run (default)
--session main         # inject into running gateway session
```

#### Delivery
```
--announce                              # send result to chat
--channel telegram --to "123456789"     # target
--no-deliver                            # silent (log only)
```

#### Job Config Format
Standalone JSON: `~/.roundhouse/crons/<job-id>.json`

#### New Files
```
src/cron/types.ts       # job/run types
src/cron/store.ts       # read/write/list job JSON
src/cron/schedule.ts    # schedule → due check + crontab line
src/cron/tick.ts        # the tick runner
src/cron/trigger.ts     # render prompt, run agent, notify
src/notify/telegram.ts  # shared Telegram sender (extract from gateway)
```

#### Telegram Commands
```
/crons                  # list all jobs
/crons show <id>        # job details + last run
/crons run <id>         # trigger now
/crons runs <id>        # recent history
/crons pause <id>       # disable
/crons resume <id>      # enable
```

### Heartbeat / Health Endpoint (AFTER cron)
```
src/heartbeat.ts — node:http on 127.0.0.1:8787
GET /healthz     — liveness (cheap)
GET /readyz      — readiness (chat initialized)
GET /status.json — rich diagnostics + cached doctor summary
```

### TTS (Outgoing Voice) (FUTURE)
See /tmp/roundhouse-voice-service-design.md and /tmp/roundhouse-voice-unified-design.md

### Internal Maintenance Timers (FUTURE)
For process-local housekeeping only (NOT called "crons"):
- Session compaction at threshold
- Heartbeat interval
- Cache cleanup
- Stale session reaping (already exists in pi.ts)

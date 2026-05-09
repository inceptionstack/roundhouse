# Tools

Available tools that can be invoked via shell commands during agent turns.

## roundhouse cron add

Schedule recurring or one-shot jobs. The user may ask you to "remind me", "check every X", "do Y later", or "schedule Z".

**Usage:**
```bash
roundhouse cron add <job-id> --prompt "..." --every "6h"
roundhouse cron add <job-id> --prompt "..." --cron "0 8 * * *" --tz "America/New_York"
roundhouse cron add <job-id> --prompt "..." --at "30m"
```

**Flags:**
- `--prompt "..."` — What the agent should do when the job fires (required)
- `--cron "..."` — Cron expression (e.g. "0 9 * * 1-5" = weekdays at 9am)
- `--every "..."` — Interval (e.g. "6h", "30m", "1d")
- `--at "..."` — One-shot timer (e.g. "30m", "2h", or ISO datetime)
- `--tz "..."` — Timezone (default: UTC)
- `--telegram "..."` — Telegram chat IDs to notify (comma-separated)
- `--description "..."` — Human-readable description
- `--timeout "..."` — Max runtime (e.g. "5m", default: 10m)

**Examples:**
```bash
# Remind user every morning
roundhouse cron add morning-checkin --prompt "Good morning! Here's a summary of yesterday's work and today's plan." --cron "0 8 * * *" --tz "Asia/Jerusalem"

# Check something every 6 hours
roundhouse cron add monitor-deploy --prompt "Check if the deployment at https://example.com is healthy. Report any issues." --every "6h"

# One-shot reminder in 30 minutes
roundhouse cron add reminder-123 --prompt "Remind the user: 'Call the dentist'" --at "30m"
```

**Management:**
```bash
roundhouse cron list          # Show all jobs
roundhouse cron pause <id>    # Disable a job
roundhouse cron resume <id>   # Re-enable a job
roundhouse cron delete <id>   # Remove a job
roundhouse cron trigger <id>  # Run immediately
roundhouse cron runs <id>     # Show run history
```

## roundhouse cron (via /crons chat command)

Users can also manage jobs via Telegram:
- `/crons` — list all jobs
- `/crons trigger <id>` — run now
- `/crons pause <id>` — disable
- `/crons resume <id>` — enable

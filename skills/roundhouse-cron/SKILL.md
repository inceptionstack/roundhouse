# Roundhouse Cron Jobs

Schedule tasks, add cron jobs, trigger actions at specific times or intervals using the `roundhouse cron` CLI.

## When to Use

Activate this skill when the user asks to:
- Add a scheduled job or cron job
- Run something every X minutes/hours/days
- Trigger something at a specific time
- List, edit, pause, resume, or delete scheduled jobs
- Check job run history

## CLI Reference

### Add a job

```bash
roundhouse cron add <id> --prompt "..." --cron "0 8 * * *"
roundhouse cron add <id> --prompt "..." --every "6h"
roundhouse cron add <id> --prompt "..." --at "30m"
```

**Required flags:**
- `--prompt "..."` — The prompt sent to the agent when the job fires
- One schedule type (pick one):
  - `--cron "0 8 * * *"` — Standard cron expression
  - `--every "6h"` — Interval (e.g., `30m`, `2h`, `1d`)
  - `--at "..."` — One-shot (e.g., `30m` from now, or ISO date `2026-05-10T14:00:00Z`)

**Optional flags:**
- `--tz "Asia/Jerusalem"` — Timezone (default: system timezone)
- `--telegram "123456,789012"` — Notify these Telegram chat IDs
- `--notify-on "always|success|failure"` — When to send notifications
- `--var "key=value,key2=value2"` — Template variables for the prompt
- `--timeout "30m"` — Max execution time
- `--description "..."` — Human-readable description
- `--replace` — Overwrite existing job with same ID
- `--json` — Output job config as JSON

### List jobs

```bash
roundhouse cron list
roundhouse cron list --json
```

### Show job details

```bash
roundhouse cron show <id>
roundhouse cron show <id> --json
```

### Trigger a job manually

```bash
roundhouse cron trigger <id>
```

### View run history

```bash
roundhouse cron runs <id>
roundhouse cron runs <id> --limit 20
```

### Edit a job

```bash
roundhouse cron edit <id> --prompt "new prompt"
roundhouse cron edit <id> --every "12h"
roundhouse cron edit <id> --cron "0 */4 * * *" --tz "UTC"
```

### Pause / Resume

```bash
roundhouse cron pause <id>
roundhouse cron resume <id>
```

### Delete a job

```bash
roundhouse cron delete <id>
```

## Rules

1. **Always use `roundhouse cron` CLI** — do not edit cron files directly
2. **Job IDs** must be lowercase alphanumeric with hyphens (e.g., `daily-report`, `check-ssl`)
3. **Prompts** are sent to the agent as-is — write them as clear instructions
4. **Template variables** use `{{var}}` syntax in prompts (e.g., `--prompt "Check {{url}}" --var "url=https://example.com"`)
5. **One-shot jobs** (`--at`) run once and stay in history — delete them after if not needed
6. **Built-in jobs** (prefixed `_`) cannot be edited or deleted

## Examples

### Daily morning briefing at 8am
```bash
roundhouse cron add morning-brief \
  --prompt "Give me a summary of overnight alerts, pending PRs, and today's calendar" \
  --cron "0 8 * * *" \
  --tz "America/New_York" \
  --telegram "123456" \
  --description "Morning briefing"
```

### Check SSL expiry every 12 hours
```bash
roundhouse cron add check-ssl \
  --prompt "Check SSL certificate expiry for {{domain}} and alert if < 14 days" \
  --every "12h" \
  --var "domain=loki.run" \
  --telegram "123456" \
  --notify-on "failure"
```

### Run a one-shot reminder in 30 minutes
```bash
roundhouse cron add remind-standup \
  --prompt "Reminder: standup starts now!" \
  --at "30m" \
  --telegram "123456"
```

### Weekly dependency audit
```bash
roundhouse cron add weekly-deps \
  --prompt "Run npm audit on all repos in ~/repos/ and report any high/critical vulnerabilities" \
  --cron "0 9 * * 1" \
  --tz "UTC" \
  --timeout "10m" \
  --description "Monday dependency audit"
```

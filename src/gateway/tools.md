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

## roundhouse message

Send a message to the user via all active transports (Telegram, etc.) without spawning an agent turn.

**Usage:**
```bash
roundhouse message "Hello from the server!"
roundhouse message --session main "Targeted to primary chat"
```

## Git & GitHub (gh CLI)

Use `gh` CLI for all GitHub operations. It handles authentication automatically.

**Common patterns:**
```bash
# Push branches
git push origin <branch>

# Create PRs
gh pr create --base main --head <branch> --title "..." --body "..."

# Merge PRs
gh pr merge <number> --squash --admin

# Check CI status
gh pr checks <number>
gh run list --limit 5

# Create releases / tags
git tag v1.2.3 && git push origin v1.2.3
```

**Prefer `gh` over raw git for:**
- PR creation and merging
- CI/workflow status checks
- Release creation
- Repository settings

## mcporter (MCP Server CLI)

Call tools from configured MCP servers (AWS APIs, docs, infrastructure).

```bash
mcporter list                          # show available servers
mcporter list <server> --schema        # show tools + parameters
mcporter call <server>.<tool> key=val   # call a tool
```

**Examples:**
```bash
mcporter call 'aws-mcp.sts_GetCallerIdentity()'
mcporter call aws-mcp.s3_ListBuckets
mcporter call 'aws-documentation.search(query: "Lambda timeout")'
```

> Ensure PATH includes `~/.local/bin` for `mcporter`/`uvx` discovery.

## playwright-cli (Browser Automation)

Headless browser automation for testing web UIs, scraping, screenshots.

**Core workflow:** open → snapshot → interact → close

```bash
playwright-cli open "https://example.com"   # launch + navigate
playwright-cli snapshot                      # accessibility tree with [ref=eN]
playwright-cli click e5                      # click element by ref
playwright-cli fill e3 "search query"        # type into input
playwright-cli screenshot                    # save viewport PNG
playwright-cli close                         # close browser
```

**Other commands:**
```bash
playwright-cli requests               # list network requests
playwright-cli request <index>        # show request details
playwright-cli cookie-list            # list cookies
playwright-cli eval "document.title"   # run JS in page
playwright-cli pdf                    # save page as PDF
```

**Use for:** E2E testing, visual verification, form automation, web scraping.
**NOT for:** API-only testing (use curl), static file reading.

## codex exec

Delegate tasks to Codex CLI (architecture design, parallel research, code review).

```bash
codex exec "Design a retry mechanism with exponential backoff for this module"
```

Good for: brainstorming, getting a second opinion, architecture decisions, reducing bikeshedding.

## Memory Management

Durable state files the agent can read and update:

- `~/MEMORY.md` — stable facts, preferences, project context (edit existing entries, don't append duplicates)
- `~/daily/YYYY-MM-DD/front-page.md` — today's work log, decisions, open loops
- `~/daily/YYYY-MM-DD/articles/` — detailed write-ups for durable topics

## AWS CLI

Full AWS access via instance role (us-east-1). No credentials needed.

```bash
aws sts get-caller-identity
aws s3 ls
aws logs tail /aws/lambda/<name> --since 1h
aws cloudformation describe-stacks --stack-name <name>
```

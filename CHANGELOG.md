# Changelog

All notable changes to `@inceptionstack/roundhouse` are documented here.

## [Unreleased] (post-0.3.18)

### Added
- **Bundled skill: pr-merge-discipline** — always check PR comments before merging
- **Typing indicator during STT** — Telegram shows "typing" while voice messages are transcribed
- **systemd: TimeoutStopSec=15 + KillMode=mixed** — hung STT subprocesses no longer block shutdown for 90s
- **Shared "main" session** — all direct messages route to a single `main` agent thread
  - Telegram DMs, CLI TUI, CLI agent, future Slack/Discord all share one conversation
  - Sessions stored in `~/.roundhouse/sessions/main/`
  - `SESSIONS_DIR` exported from config
  - `resolveAgentThreadId()` routes DMs → `main`, groups → `group:<chatId>`
- `roundhouse tui` with no args opens `main` session directly (no scanning/prompting)
- `roundhouse agent` defaults to `main` thread; `--ephemeral` for one-off behavior

### Fixed
- **Pairing userId extraction** — reads `author.userId` matching Telegram adapter shape (was reading `.id` → undefined)
- **Session reaper race** — tracks `inFlight` counter, skips busy sessions during reap
- **/compact concurrency** — now acquires per-thread lock like normal prompts
- **Attachment permissions** — dirs created with 0700, files with 0600
- **Memory state permissions** — writes with mode 0600, dirs 0700
- **Cron template cwd** — uses `agentCfg.cwd` instead of `process.cwd()`
- **Cron TDZ crash** — `agentCfg` was referenced before declaration (moved config load above template render)
- **cmdRun shell injection** — uses `execFileSync` instead of shell string interpolation
- Startup warning when no allowlist is configured
- Security warning when loading config from cwd

### Removed
- Legacy `threadIdToDirLegacy()` and all backward-compat fallback code
- Per-platform session directories (old `telegram_c*` dirs no longer used)

## [0.3.18] — 2026-04-30

### Added
- **`--agent` flag** for `roundhouse setup` — agent-aware setup with `AgentDefinition` registry
  - Pi as default agent, extensible to future agent types
  - `stepInstallPackages`, `stepPreflight`, `stepConfigure` all driven by agent definition
  - `resolveAgentForSetup()` wires Pi-specific configure/installExtension
  - Unknown agent types rejected with available list

## [0.3.17] — 2026-04-29

### Added
- **`setup --telegram`** — interactive wizard + headless automation
  - Interactive: BotFather guide, masked token prompt, QR pairing link, 10-step guided flow
  - Headless: `--headless` with structured JSON logging, persistent pairing file
  - Gateway completes pairing on `/start <nonce>` — `handlePendingPairing()` method
  - `--bot-token` rejected in headless mode (argv visible in process listings)
- `qrcode-terminal` dependency for pairing QR codes
- Seed `~/.roundhouse/.env` with commented-out example template (mode 0600)

## [0.3.16] — 2026-04-29

### Fixed
- Show Telegram checks in CLI doctor, deduplicate token resolution
- Flip psst default to off

## [0.3.15] — 2026-04-29

### Fixed
- Validate pathValue and guard against non-string unit values in systemd generator
- Newline-injection guard in `generateUnit`, harden `whichSync`

### Changed
- Consolidate systemd/shell helpers, add systemd tests
- Extract shared env-file and systemd modules (DRY/SRP)

## [0.3.14] — 2026-04-28

### Changed
- Refactor: extract shared env-file and systemd modules

## [0.3.13] — 2026-04-28

### Fixed
- `cmdInstall` tsx fallback now uses 'run' subcommand
- Split start/run: 'start' launches daemon, 'run' runs foreground

## [0.3.12] — 2026-04-28

### Changed
- Rename env file to `.env` with legacy fallback + deprecation warning

## [0.3.11] — 2026-04-28

### Fixed
- E2E findings: show step ⑥ skip message, doctor checks global npm for Pi SDK
- Allow `--dry-run` without bot token

## [0.3.10] — 2026-04-27

### Fixed
- 6 findings from Codex full-codebase review (2 HIGH, 4 MEDIUM)
  - Attachment size: `Blob.size` check before Buffer materialization
  - Shell injection in `runSudo`: `execFileSync` with arg arrays
  - `threadIdToDir` collision: injective `_xNNNN` encoding
  - `/restart` checks both allowlists
  - `isCommand` validates @bot suffix
  - Cron `lastScheduledAt` pre-advance documented

## [0.3.9] — 2026-04-27

### Fixed
- Setup fixes from E2E test findings on fresh EC2 instances

## [0.3.8] — 2026-04-27

### Added
- **`roundhouse setup`** — one-command install & configure with psst integration
- **`roundhouse pair`** — standalone Telegram pairing command
- **`roundhouse agent`** — CLI command to send messages to configured agent
- `roundhouse --version` / `-v` flag
- Shared `BOT_COMMANDS` constant
- `allowedUserIds` (immutable numeric IDs) in gateway auth

## [0.3.6] — 2026-04-26

### Added
- **Memory system** (Option B) — roundhouse-managed by default
  - MEMORY.md, daily notes, newspaper-style injection
  - Proactive compaction: soft/hard/emergency thresholds
  - Pre-compact flush in all modes
- `/status` shows memory mode and system CPU/RAM
- Rich startup notification with version, model, cron counts

## [0.3.5] — 2026-04-25

### Added
- **Cron system** — internal scheduler with `p-queue` and `croner`
  - `roundhouse cron add/list/show/trigger/runs/edit/pause/resume/delete`
  - Standard cron, interval, and one-shot schedule types
  - Fresh agent per run, timeout with abort, template variables
  - `/crons` and `/jobs` Telegram commands
  - Built-in heartbeat job (reads HEARTBEAT.md every 30min)

## [0.3.2] — 2026-04-24

### Added
- **Voice support** — download attachments, STT via whisper
- **Doctor** — 21 checks across 7 categories
- Config migration `~/.config/roundhouse/` → `~/.roundhouse/`

## [0.3.1] — 2026-04-23

### Added
- Gateway with Telegram adapter, per-thread agent sessions
- `/new`, `/restart`, `/status`, `/compact`, `/verbose`, `/stop`, `/doctor` commands
- Auto-register bot commands with Telegram on startup
- Draining/drain_complete notification system
- Context token usage with progress bar

## [0.2.0] — 2026-04-22

- Initial release

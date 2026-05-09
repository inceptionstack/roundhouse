# Changelog

All notable changes to `@inceptionstack/roundhouse` are documented here.

## [Unreleased]

_No unreleased changes._

## [0.5.7] — 2026-05-09

### Added
- **`<tools>` section injection** — bundled `tools.md` injected into every agent prompt so agent knows it can schedule cron jobs (PR #50)
- **Extension updates in `/update`** — pi-hard-no and pi-branch-enforcer updated alongside roundhouse (PR #51)
- User-customizable `~/.roundhouse/tools.md` overrides bundled tools documentation
- Per-extension progress messages shown to user during update

### Fixed
- Tools injection runs after STT enrichment so voice-only messages also get tools context
- XML tag sanitization prevents prompt injection from user-customized tools.md
- `/update` version-check failure returns distinct error (not misleading "already-latest")
- Error messages truncated to 200 chars for Telegram safety

## [0.5.6] — 2026-05-09

### Added
- **STT agent prompt injection** — when whisper/ffmpeg are missing, injects install prompt into agent turn instead of complex auto-install chains (PR #45)
- **getMissingDeps()** on whisper provider + SttService — reports what’s missing so gateway can act
- **Duration-exceeded “skipped” status** — audio too long gets status “skipped” (not “failed”), preventing false install prompts
- **Text+audio handling** — when user sends caption + voice, install prompt appends to existing text

### Changed
- **Removed `autoInstall` config** — no longer needed; agent handles installation autonomously
- **Simplified whisper.ts** — removed installWhisperWithPip, installWhisperWithUv, ensureFfmpeg (~150 lines deleted)
- **User notification** — “Asking agent to install...” (accurate) replaces “Setting up...” (misleading)

### Fixed
- **systemd: TimeoutStopSec=15 + KillMode=mixed** (PR #43) — hung whisper subprocesses no longer block shutdown for 90s
- **Stale autoInstall references** in CLI setup wizard, doctor checks, and usability report (PR #46)

## [0.5.5] — 2026-05-09

### Added
- **TransportAdapter interface** — enrichPrompt, postMessage, registerCommands, ownsThread, notify, isPairingPending, handlePairing (PR #37)
- **TelegramAdapter** — implements TransportAdapter, pairing logic moved from gateway (PR #39)
- **Bundled skills** — roundhouse-cron + pr-merge-discipline ship with package
- **STT typing indicator** — Telegram shows “typing” during voice transcription (PR #42)
- **PairingResult widened** to `string | number` for future Slack/Discord support (PR #41)
- **Agent chooser** — interactive numbered menu in setup wizard (PR #37)

### Fixed
- **Gateway imports** — 9 broken `./` → `../` paths after module reorg (PR #40)
- **Naming conventions** — adapter.ts → telegram-adapter.ts, TelegramTransportAdapter → TelegramAdapter (PR #38)

### Changed
- **Module reorganization** (PR #36) — gateway/, transports/telegram/, cli/setup/, provisioning/
- 376 tests passing

## [0.5.0–0.5.4] — 2026-05-08

### Added
- **Shared "main" session** — all direct messages route to a single `main` agent thread
  - Telegram DMs, CLI TUI, CLI agent, future Slack/Discord all share one conversation
  - Sessions stored in `~/.roundhouse/sessions/main/`
  - `SESSIONS_DIR` exported from config
  - `resolveAgentThreadId()` routes DMs → `main`, groups → `group:<chatId>`
- `roundhouse tui` with no args opens `main` session directly (no scanning/prompting)
- `roundhouse agent` defaults to `main` thread; `--ephemeral` for one-off behavior
- **Silent agent failure detection** — model_error event, pi-telegram conflict warning, safety net posts "no response" if turn silent (v0.5.4)
- **macOS LaunchAgent support** — auto-start, Plist generation (v0.5.2)
- **Phase 2 refactoring** — cron dispatcher, pi-adapter extraction, setup.ts split (v0.5.3)

### Fixed
- **Pairing userId extraction** — reads `author.userId` matching Telegram adapter shape
- **Session reaper race** — tracks `inFlight` counter, skips busy sessions during reap
- **/compact concurrency** — now acquires per-thread lock like normal prompts
- **Attachment permissions** — dirs created with 0700, files with 0600
- **Memory state permissions** — writes with mode 0600, dirs 0700
- **Cron template cwd** — uses `agentCfg.cwd` instead of `process.cwd()`
- **Cron TDZ crash** — `agentCfg` was referenced before declaration
- **cmdRun shell injection** — uses `execFileSync` instead of shell string interpolation

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

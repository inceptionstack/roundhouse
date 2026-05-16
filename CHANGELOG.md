# Changelog

All notable changes to `@inceptionstack/roundhouse` are documented here.

## [0.5.38] — 2026-05-16

### Fixed
- **Soft-reset pre-turn gap.** Idle sessions that grew via background work
  (cron jobs, boot turn, sub-agent results) could cross the provider's context
  limit without ever tripping the proactive `softTokens`/`hardTokens`
  thresholds while live. The next user turn called `agent.prompt()` directly
  and overflowed; the gateway catch posted the raw `prompt is too long: N >
  200000` error with no classification or recovery, and the loop persisted
  until manual surgery on the jsonl. The v0.5.29–v0.5.32 soft-reset machinery
  only fired from `flushMemoryThenCompact`'s catch (i.e. when *compact itself*
  overflowed), not from a normal user-prompt overflow. Concrete evidence on
  the maintainer's machine: `~/.roundhouse/sessions/main` jsonl reached 2.8 MB
  with zero `"main"` entries in `compact-timing.jsonl` between
  2026-05-14 and 2026-05-16.
- **Fix:** classify `agent.prompt()` / `agent.promptStream()` exceptions in the
  gateway catch via the existing `isContextOverflowError`. On overflow, call
  `agent.softReset(threadId)` (extracted into a shared
  `recoverFromContextOverflow` helper, also used by the v0.5.32 compact-time
  path). On success, set `forceInjectReason="after-soft-reset"` and clear
  `pendingCompact`; on no-op or failure with `agent.compact` available, arm
  `pendingCompact="emergency"` so the existing pre-turn branch fires on the
  user's next message. UX is deferred-retry only — same-turn replay would
  duplicate streamed text and re-execute side-effecting tools. Background
  turns (boot/subagent/cron) get distinct copy that doesn't ask a user to
  resend. Telemetry: one line per gateway-side recovery in
  `compact-timing.jsonl` with `level: "gateway-overflow"`.
- 19 new tests across `test/overflow-recovery.test.ts` (helper-level
  classify/recover/no-op/failed/cause-chain) and
  `test/gateway-overflow-recovery.test.ts` (gateway-level state writes,
  pendingCompact arming, streaming partial-text branch, background-turn
  copy, post-throw resilience). **584 tests passing** (+19 net).
- Design doc: `docs/design/v0.5.38-soft-reset-pre-turn-gap.md` (codex-cli
  Alternative D — shared reactive recovery helper, deferred retry,
  pendingCompact fallback).

## [0.5.37] — 2026-05-16

### Fixed
- **`/model` and `/topic` no longer show redundant option list above the keyboard.** When the inline keyboard renders, the buttons already enumerate the options — the verbose `*Available:*` text was just noise. Added optional `RichResponse.menuCaption` for concise body next to menus; transports prefer it when rendering, fall back to `text` (verbose) when caption absent or menu can't render.

## [0.5.36] — 2026-05-16

### Fixed
- **Inline keyboards restored for `/model` and `/topic`** (v0.5.35 regression). The Rich UI Surface refactor extracted `adapter.telegramFetch` as a plain reference, which loses `this` — the underlying `@chat-adapter/telegram` method needs `this.apiBaseUrl` and `this.botToken`. Detached calls threw silently; postRich's catch swallowed and fell back to text. Fix: invoke as `tgAdapter.telegramFetch(...)`. Mutation-tested regression with a `FakeTelegramAdapter` that detects detached calls (`vi.fn()` mocks couldn't catch this).

## [0.5.35] — 2026-05-16

### Rich UI Surface
- **RichResponse + TransportAdapter.postRich** — commands now return data, transports render. `/model`, `/topic`, `/crons` migrated. Adding a new menu command no longer requires Telegram-specific code.
- **Thread-routing fix** — `/topic` from inside a named-topic session no longer falls back to text. Routing preserves the original transport thread by construction (only rewrites the agent-session id separately). Mutation-tested regression.
- **`buildSelectableMenu()` helper** — shared picker UI for `/model` and `/topic`. Handles current marker, sentinel buttons (e.g. "main (default)"), and text fallback.
- **`/crons trigger` edit-in-place** — "⏳ Triggering…" → "✅ queued" via `transport.progress()` instead of two separate bubbles.
- **`safePostText` 3-tier fallback** — postRich never-throws contract now correctly degrades to `thread.post()` for non-Telegram thread shapes (was dropping confirmations on synthetic threads).
- 561 tests green (+9 net).

## [0.5.32] — 2026-05-14

### Fixed
- **Soft-reset progress: emit completion message, not just start.** Before, the user saw `♻️ Session overflowed — soft-resetting to recent turns...` and then silence — success/failure outcomes only went to stderr. Now the user always sees a follow-up:
  - ✅ `Soft-reset complete (N → M entries). Durable memory will re-inject on next turn.` on success
  - ⚠️ `Soft-reset no-op (<reason>). Will retry compact next turn.` when nothing to trim
  - ❌ `Soft-reset failed: <msg>. Will retry next turn.` when recovery itself errors
- 3 new tests verifying onProgress emissions for all three outcomes (`emergency_whenSoftResetSucceeds_emitsCompletionProgressMessage`, `..._emitsNoOpProgressMessage`, `..._emitsFailureProgressMessage`), plus 1 regression test (`..._doesNotMaskWithTypeError`) for non-Error throws inside the recovery catch. **540 tests passing.**

## [0.5.31] — 2026-05-14

### Internal
- **Refactor: session-repair module split + DRY shared error-classifier helper.** Pure refactor, zero behavior change. Addresses 7 maintainability findings from the post-v0.5.30 review:
  - Extracted `matchesErrorPatterns()` shared helper so `isContextOverflowError` and `isToolPairingError` no longer duplicate ~80% of their structure. Both classifiers now walk the `cause` chain (previously only the overflow classifier did — fixed divergent-change smell). Both share `looksLikeValidationError()` gating.
  - Extracted `buildTrimmedEntries()` from `softResetSessionFile` and `attemptSoftResetRecovery()` from `flushMemoryThenCompact`. The lifecycle catch block is now ~25 lines of linear flow (classify → recover → log → persist) instead of ~60 lines with a nested try/catch.
  - `MAX_CAUSE_CHAIN_DEPTH = 5` named constant.
  - Split `src/agents/shared/session-repair.ts` (574 lines, two domains) into four focused files: `session-repair.ts` (81 lines, public surface), `session-soft-reset.ts`, `error-classifiers.ts`, `session-repair-internal.ts`. All public exports preserved via re-exports for backward compat.
  - Introduced `SessionRepairResult` named type replacing anonymous `{entries, report}` shape (named to avoid collision with the existing `RepairResult` in `message-validator.ts`).
- 2 new regression tests for `isToolPairingError`'s now-fixed cause-chain walking. **536 tests passing.**

## [0.5.30] — 2026-05-14

### Fixed
- **Soft-reset robustness fixes from codex review of v0.5.29:**
  - **P1 — byte-cap could cut mid-turn.** When `findSoftResetCutIndex()` hit the byte budget before reaching `keepRecentUserTurns`, it returned `i + 1` which could land on an assistant reply or toolResult whose user prompt was about to be dropped. The kept tail then started mid-turn and tool-pairing repair didn't fix that (only orphans, not turn boundaries). Fixed: byte-cap path now snaps to the most-recent user-message boundary we've walked through.
  - **P2 — byte cap measured in JS code units, not real bytes.** `JSON.stringify(e).length` counts UTF-16 code units; non-ASCII content (emoji, CJK) overshot the advertised 250k ceiling 2–3x. Now uses `Buffer.byteLength(..., 'utf8')` end-to-end so reported `bytesAfter` and the cap decision both reflect actual file bytes.
  - **P2 — trim + repair was not atomic end-to-end.** Old flow wrote the trimmed file, then called `repairSessionFile()` which re-backed-up the *already-trimmed* file and rewrote it again. A crash between the two writes left a partial state and lost the true original. Refactored: extracted `repairEntriesInMemory()` so trim + tool-pair repair compose in memory and land as a single backup + atomic rename.
  - **P2 — `isContextOverflowError()` only inspected top-level `.message`.** Wrapped provider errors (`err.cause.message`, Bedrock `ValidationException` carrying overflow text in nested SDK fields) fell through to re-arming `pendingCompact` instead of triggering recovery. Now mirrors `isToolPairingError()`'s nested handling: walks the `cause` chain (bounded, cycle-safe) and stringify-searches gated on a 4xx/`ValidationException` shape so we don't false-positive on unrelated 5xx noise.
- 7 regression tests added (534 total passing): byte-cap user-boundary snap, UTF-8 byte accounting, single-atomic-write backup integrity, wrapped-cause classification, Bedrock validation classification, false-positive gating, circular-cause safety.

## [0.5.29] — 2026-05-14

### Added
- **Soft-reset recovery for already-overflowed sessions.** When a session has grown past the model's context window, normal compact cannot recover — the summarizer prompt itself overflows and `compact()` throws `prompt is too long: N > max`. v0.5.28's threshold tuning prevents *new* sessions from hitting this; this release adds graceful recovery for sessions that already crossed the line. On context-overflow detection, the memory lifecycle calls a new `agent.softReset(threadId)` capability that trims the on-disk session jsonl to its most-recent N user turns (default 8, byte-capped at 250k), reloads the session, and queues a memory re-injection on the next turn. The agent loses verbatim message history for older turns but retains its durable context (MEMORY.md, daily front-page, soul.md). No more manual surgery on stuck sessions.
- New module exports: `softResetSessionFile()` and `isContextOverflowError()` in `src/agents/shared/session-repair.ts`. New optional `softReset?(threadId)` method on `AgentAdapter` interface (no-op when not implemented — backward-compatible). PiAdapter implements it via the existing `reloadSession` path.
- 20 new tests across `session-repair.test.ts` (file-level cut/preserve/repair semantics, error classifier) and `memory.test.ts` (lifecycle wiring — success/no-op/missing-capability/non-overflow-error/throws-during-recovery). 527 tests total.

## [0.5.28] — 2026-05-14

### Fixed
- **PR #126 actually shipped this time.** v0.5.26's CHANGELOG advertised the emergency-compact-loop fix, but the underlying PR (`fix/compact-loop-thresholds-and-thinking`) was still OPEN — only the version bump and self-update patch went out. Users on v0.5.26/v0.5.27 still hit `Summarization failed: prompt is too long: 212776 tokens > 200000 maximum` on overflowed sessions because `DEFAULT_HARD_TOKENS` was still 200k with no headroom clamp. This release contains the actual code change: `DEFAULT_HARD_TOKENS=150_000`, `DEFAULT_SOFT_TOKENS=130_000`, `COMPACT_HEADROOM_TOKENS=50_000`, plus `thinkingLevel='off'` forced inside `compactWithModel`. (#126)

## [0.5.27] — 2026-05-14

### Fixed
- **Self-update no longer falsely fails on mise/nvm hosts** — on systems where Node is managed by mise (or nvm), `npm install -g` triggers a post-install reshim hook that exits 127 when its tool isn't on PATH, causing `execSync` to throw even though the package was written to disk correctly. The user-visible bug: "Self-update failed: Command failed: npm install -g …" plus `/status` continuing to show the old version forever (because the gateway never restarted). Fix: when the install command throws, consult `npm list -g <pkg>` and trust the on-disk version. If it matches the target, treat the install as successful. Same logic applied to extension updates. (#128)
- **Side effect:** `/update` now fires its existing 'restarting…' branch on this case, so `/status` reflects the new version on next boot.

### Changed
- **DRY in `cli/update.ts`:** extracted `getInstalledVersion()` helper used by both pre-install version check and post-failure verification; introduced `SELF_PACKAGE` constant; fixed stale `commands/update.ts` header comment.

## [0.5.26] — 2026-05-14

### Fixed
- **Emergency compact loop — output-cap mismatch + summarization input overflow.** Two compounding bugs caused infinite emergency-compact loops on Haiku 4.5 sessions near the context limit. (1) `reserveTokens=150000` + Haiku's 64k output cap produced `maxTokens=120000`, which Bedrock rejected. (2) `hardTokens=200k`/`softTokens=180k` against a 200k window left no headroom for the summarizer prompt itself. Fix: lower thresholds to 150k/130k, add `COMPACT_HEADROOM_TOKENS=50k`, force `thinkingLevel:off` in `compactWithModel`, drop `reserveTokens` to 78k. State is now loaded once and reused; phase timing is hoisted; telemetry is accurate on failure. (#126)

## [0.5.25] — 2026-05-12

### Fixed
- **Emergency-compact loop** — when a pi session exceeded the model's context limit (e.g. Bedrock 200k), the memory-flush step sent a prompt through the already-overloaded session, which the provider rejected, leaving `pendingCompact = "emergency"` re-armed on every turn (infinite loop). Fix: on emergency pressure, skip flush entirely and go straight to `session.compact()`, which builds its own summarization payload from older history and does not require the live session to fit under the limit. (#122)
- **Telemetry:** `timing.model` no longer mis-reports the flush model when the adapter lacks `compactWithModel`. Documented remaining BaseAdapter-shim ambiguity inline. (#122)
- **Soft flush no longer blocks thread lock** — Haiku flush (30–120s) runs outside the lock; hard/emergency compact still inside for memory invariants. Removes 2-minute silent dead zones after user messages. (#110)
- **Session auto-repair** — corrupted session history (orphan tool-call/result pairs from crashed tools) is now detected and the session file repaired on the fly, preventing permanent thread wedging. (#118)
- **Sub-agent orphan recovery** — watcher checks stdout before marking a run failed on non-zero exit, so runs that produced output survive process crashes. (#109)
- **Sub-agent completion on non-zero exit** — runs with stdout output treated as complete regardless of exit code. (#105)
- **Sub-agents run with `--no-extensions --no-skills`** — prevents stale-context crashes on teardown. (#107)
- **Boot turn** — synthetic thread now fully transport-agnostic via `transport.createThread()`. Fixes Telegram coupling and missing `handleStream`. (#100, #102, #103)

### Added
- **`/topic` inline keyboard** — tap-to-switch topic menu in private chats with `🏠 main` escape button; falls back to text list when no topics exist. Sentinel design: button value is `-main` so user input can never collide (leading `-` stripped by normalizer). (#120)
- **Cron management notifications via IPC** — `roundhouse cron add/pause/resume/trigger/delete` now posts to the active transport without spawning an agent turn. (#114)
- **Sub-agent completion injects result into parent agent** — synthetic agent turn fires with stdout, so the parent "hears" what the sub-agent did. (#108)
- **Sub-agent launch notification** (🔬) via `onSpawn()` observer on the orchestrator interface. (#111, #112)

### Changed
- **Gateway notifications use markdown** — transport adapters convert to their native format (Telegram HTML, future Slack mrkdwn). Removed `parseMode` from the transport interface. (#113)
- **Command dispatch: descriptor pattern** — each command declares `{triggers, stage, acceptsArgs, invoke, actions}` and the gateway iterates a single list. Replaces three branching dispatch loops. Adding a command is now one object literal. (#121)
- **Clean code pass** on `cron-commands` + gateway (SRP/DRY extraction). (#115)
- **Slack adapter design doc** added (Socket Mode, `pairedChannels`, DM-based pairing, progressive streaming). (#116, #117)

## [0.5.19] — 2026-05-10
- Sub-agent orchestrator: spawn background Pi agents for review/research/scout/implementation
- CLI: `roundhouse subagent spawn/status/list/abort`
- Telegram notifications on sub-agent completion (✅/⏰/❌)
- Security: UUID-only run IDs, path traversal guard, SIGKILL escalation
- Boot turn: agent greets in-character on startup
- /status shows configured model after /model switch
- TUI: fresh session support on new deploys

## [0.5.14] — 2026-05-10

### Added
- **"What's New" notification** — after `/update` + restart, startup message shows changelog highlights from the new version
- Command dispatch registry — cleaner gateway routing (−13 lines)
- Status helpers extracted (`formatUptime`, `checkAvailableUpdate`)

### Fixed
- COMMAND_REGISTRY type safety (`CommandContext` not `any`)
- CHANGELOG.md now included in published npm package

## [0.5.13] — 2026-05-10

### Added
- **soul.md + user.md persona injection** — agent identity + user context, auto-reloads on file change
- tools.md now hints agent to check `~/.roundhouse/workspace/later.md`

### Fixed
- XML injection: escape `</persona>` in user-supplied persona files
- `mkdirSync` before `writeSettings` (fixes fresh-install crash)
- mtime check uses `!==` instead of `>` (catches deletions)
- `/later@BotName` suffix now stripped in group chats

## [0.5.12] — 2026-05-10

### Added
- **Inline keyboard for /model** — 8 frontier Bedrock models (2-column, 4-row layout)
- Models: Claude Opus 4.7, Opus 4.6, Sonnet 4.6, Haiku 4.5, DeepSeek R1, Llama 4, Nova Pro, Mistral Large

## [0.5.11] — 2026-05-09

### Added
- **/later command** — quick-capture ideas to `~/.roundhouse/workspace/later.md`

## [0.5.10] — 2026-05-09

### Fixed
- **Cron notifications actually delivered** — replaced IPC socket loopback with direct callback injection from gateway
- `shouldNotify` onlyOn filter now applies to all notification routes (was only explicit Telegram)

## [0.5.9] — 2026-05-09

### Added
- **Cron IPC broadcast** — cron jobs without explicit `notify.telegram.chatIds` now broadcast results via IPC socket to all active transports
- Expanded tools.md: mcporter, playwright-cli, codex exec, AWS CLI, memory management docs

### Fixed
- Completed one-shot jobs hidden from `/crons` and `roundhouse cron list` (use `--all` to see them)
- playwright-cli command names corrected (requests, cookie-list, eval)
- mcporter examples use actual configured server names (aws-mcp, aws-documentation)

## [0.5.8] — 2026-05-09

### Added
- **IPC unix socket** — `roundhouse message "text"` sends messages to active transports via `~/.roundhouse/gateway.sock`
- **Session routing** — `--session main` targets primary chat, numeric ID targets specific chat
- **Provision tools.md** — bundled tools.md auto-copied to `~/.roundhouse/` on setup/update (never overwrites)
- 13 IPC integration tests
- IPC barrel exports for consistent import paths

### Security
- Socket mode 0600 (owner-only access)
- Stale socket cleanup with liveness probe (500ms timeout)
- 64KB payload guard, 5s request timeout

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

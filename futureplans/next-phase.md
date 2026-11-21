# Next phase: ideas and open work

Written 2026-11-21. A list of candidate work for roundhouse after the pi 1.6 migration, the security hardening and the responsiveness fixes (PRs #153 to #157). Nothing here is started. Each item says what it is, why it matters for one owner chatting from Telegram with a large-window model, where it would land in the code, a rough size (S: under 50 lines, M: 50 to 200, L: more), and what is still unknown.

Two sources:

- **OpenClaw**, read at commit `e695c13a` (release 2026.11.6, https://github.com/openclaw/openclaw). Read only: nothing from it was run, and claims marked "docs only" were not confirmed in its source. Paths below that start with `openclaw:` are in that repository.
- **A survey of roundhouse's own Telegram experience**, done against the code of this repository and the pi 1.6 and Chat SDK 4.45 sources in `node_modules`.

How to use this file: pick an item, re-read the code it names (it will have moved), settle the open questions first, and delete the item when it ships.

## A. Requested by the owner

### A1. Review the scheduler

`src/cron/` (about 1,100 lines) runs agent prompts on cron expressions, intervals and one-shot timers, plus a built-in heartbeat that runs `~/.roundhouse/HEARTBEAT.md` every 30 minutes. It has not had the review the gateway and the pi adapter got. Questions to answer:

- **What does a scheduled run cost and say?** Every heartbeat and cron result is posted with a header, whether or not there was anything to say, and each run is a fresh full agent with the whole standing context. See B5 for what OpenClaw does instead.
- **What happens when a job keeps failing?** Today it fails again at full price on every tick. There is no backoff, no auto-disable and no "one alert per incident".
- **How do scheduled runs interact with the chat?** They do not go through `accept()` in `src/gateway/gateway.ts`, so they take no part in the per-chat queue, the interrupted-request markers, or `/cancel` (`runningTurns`). Each run also gets its own session (`buildCronThreadId(job.id, runId)` in `src/cron/runner.ts`) and its own adapter, so it never shares a transcript or a queue with a chat turn. The questions that follow from that: a run starts cold every time (no prompt cache, and nothing from the chat or from the job's previous run), runs are serial among themselves (`p-queue`, concurrency 1, in `src/cron/scheduler.ts`) but run alongside a chat turn on the same host and workspace, and the owner cannot stop a run from chat.
- **Which session does a job run in, and which model?** `src/cron/runner.ts` creates its own adapter through the registry, without the gateway's `standingContext` (so no persona and no `tools.md`). Decide whether that is intended, and whether jobs should take `--model` and `--thinking`.
- **Missed runs.** `catchUp` exists; verify its behaviour across a restart, a sleep/wake of the host, and a clock change.
- **Robustness already fixed:** one job file with an invalid id no longer stops the scheduler. Look for the same class of problem in state and run-history files.
- **Who may create jobs?** The agent is told it can (`roundhouse cron add` in `tools.md`), with no owner confirmation. A prompt injection that creates a job persists. Consider requiring a confirmation in chat for a job the agent creates itself (ties in with B4).

Size: review S to M; the fixes it turns up, unknown.

### A2. Use ACP to support other agent harnesses

Roundhouse already talks ACP: the Kiro backend (`src/agents/kiro/`) spawns `kiro-cli` and drives it over a JSON-RPC-over-stdio client in `src/agents/kiro/acp/` (`client.ts`, `process.ts`, `methods.ts`, `types.ts`). `docs/kiro-adapter-design.md` records what it took. The idea is to make that client a general ACP adapter, so any harness that speaks ACP can sit behind the gateway without a hand-written adapter each.

What to work out:

- **How much of `src/agents/kiro/` is Kiro and how much is ACP.** `kiro-adapter.ts`, `session.ts` and `tool-names.ts` carry Kiro specifics (its agent config file under `~/.kiro/agents/`, tool-name prefixes, `--trust-all-tools`, the `/compact` command form). Split a generic `agents/acp/` adapter from a thin Kiro profile.
- **Which protocol version and which optional capabilities** the generic adapter needs: session load/resume, cancel, permission requests, streaming chunks, tool-call updates, images, model selection. The Kiro design doc lists places where Kiro's behaviour needed workarounds (hook lifetimes, event synthesis); find out which are protocol gaps and which are Kiro's.
- **Which harnesses to target first.** Verify, per harness and version, that it ships an ACP server mode and what it supports; do not assume. Candidates to check: other coding-agent CLIs that advertise ACP, and pi itself (pi has an RPC mode, `docs/rpc.md` in the pi package, which is not ACP; an ACP front for pi may or may not exist).
- **What the gateway loses on a generic backend.** The pi adapter gives roundhouse things ACP may not: context usage for the compaction policy (`getInfo()`), in-place model and thinking changes (`setModel`, `thinkingLevel`), the system-prompt standing context, session repair and soft reset, images as model input. Each becomes an optional capability the gateway must degrade without. `AgentAdapter` in `src/types.ts` already marks most of them optional.
- **Permission requests.** ACP lets the agent ask the client to approve a tool call. That is the natural hook for approval buttons in chat (B4), and would work for every ACP backend at once.
- **Process hygiene.** A subprocess per session needs what the gateway now has for itself: bounded shutdown, no orphans after a restart, and no second copy next to a running one.

Size: L. Open question: whether to keep pi in-process (fast, full-featured) and add ACP beside it, which is the low-risk reading of this item.

## B. From OpenClaw, ranked by value to one daily user

### B1. Steer the running turn (S to M)

- **OpenClaw:** a message that arrives mid-run is injected after the current tool batch, before the next model call. Defaults: steer mode, 500 ms debounce, a cap of 20 (`openclaw:src/auto-reply/reply/queue/state.ts`, `openclaw:docs/concepts/queue.md`). `/followup <msg>` forces a separate turn.
- **Why:** today a correction waits behind the whole turn, or needs `/cancel` and a restart of the work.
- **Roundhouse:** messages are chained per chat in `accept()` (`src/gateway/gateway.ts`). pi has `session.steer()`, `followUp()` and `clearQueue()`, unused in `src/`. Route a message to `steer` when its chat has a turn in `runningTurns` that is streaming; acknowledge it in chat; the reply continues in the same stream.
- **Traps found in pi 1.6:** `steer()` on an idle session only queues, so check `pendingMessageCount` after the run settles and resubmit; `/cancel` must also call `clearQueue()` or the next run drains the queue; a steer that lands after the last model call starts a new run and triggers the "waiting for follow-up" notice; flush prompts also raise `inFlight`, so "is a user turn streaming" needs its own flag. Attachments and transcription must finish before the steer.
- **Risk:** "which message is this answering" gets blurrier; memory injection assumes one message per turn.

### B2. Let the agent send files, images and voice notes to the chat (S to M)

- **OpenClaw:** a `message` tool with attachments, and a `MEDIA:/path` line in a reply (`openclaw:src/media/parse-output.ts`). Local paths are limited to allowed roots; photos group into albums.
- **Why:** from a phone there is no way to get a screenshot, a PDF or a log back.
- **Roundhouse:** nothing outbound exists. `roundhouse message` is text only and IPC (`src/ipc/types.ts`) has `notify` and `ping`. Add an IPC request `send-file` and `roundhouse send <path>`, posting through the SDK thread (`thread.post({ markdown, files })`, which the Telegram adapter sends as a document). Document it in `tools.md`.
- **Trap:** the SDK refuses files and attachments in the same post.
- **Risk:** it is an exfiltration path if injected content ever steers the agent. Restrict to the workspace and a size limit.

### B3. Trim old tool output only when the prompt cache is already cold (M)

- **OpenClaw:** with `contextPruning.mode: "cache-ttl"`, only tool results are touched, and only after the cache lifetime has lapsed. Above 30% of the window, results over 4,000 characters are cut to their first and last 1,500; above 50% they are replaced by a placeholder. The last three assistant turns are kept and the transcript on disk is untouched (`openclaw:src/agents/embedded-agent-runner/tool-result-truncation.ts`, `openclaw:docs/concepts/session-pruning.md`).
- **Why:** with compaction at 60% of a 1M window, a session carries hundreds of thousands of tokens of stale tool output and pays to re-cache all of it after every pause.
- **Roundhouse:** pi's `context` extension hook can filter messages per call; roundhouse registers no in-process hooks today. Trim decisions must be stored and applied identically on every later call, or each call breaks the cache.
- **Unknown:** whether a server-side context edit can be added through pi's `before_provider_request` and how pi's token accounting reacts. Untested.
- **Risk:** the agent loses old output verbatim.

### B4. Approval buttons for risky shell commands (M)

- **OpenClaw:** exec approvals with modes `deny | allowlist | ask | auto | full`. An approval binds the exact argv, cwd, env and the executable's real path, is shown with command and cwd, can be resolved only by owner ids, and times out to deny (`openclaw:src/agents/bash-tools.exec-approval-binding.ts`, `openclaw:extensions/telegram/src/exec-approvals.ts`). It is **off by default**, and OpenClaw's own `SECURITY.md` calls it a guardrail "to reduce accidental command execution", not a boundary.
- **Why:** it is the only control found that puts a human between injected content and the shell.
- **Roundhouse:** pi's `tool_call` hook can block and its handler is async; inline buttons and `chat.onAction` already sit behind the allowlist. Start with ask-on-match for a short list of destructive or outbound patterns, deny on timeout, and deny rather than ask in scheduled runs. With ACP backends (A2) the protocol's permission request is the same hook.
- **Unknown:** whether pi tolerates a handler that waits minutes for a human.
- **Risk:** friction; sub-agents are separate `pi -p` processes and bypass an in-process hook; the agent can edit `~/.roundhouse`. A guardrail, not isolation.

### B5. Quiet, self-limiting scheduled runs (S each, M together)

Belongs with A1.

- **Stay silent when there is nothing to say:** a `NO_REPLY` reply suppresses delivery; the default check runs only when idle, within active hours, and makes no model call when its checklist is empty (`openclaw:src/cron/default-proactive-job.ts`).
- **Back off and give up:** 30 s, 60 s, 5 m, 15 m, 60 m; auto-disable after 10 consecutive failures; one alert per incident with a one-hour cooldown (`openclaw:src/cron/service/jobs-scheduling.ts`, `auto-disable.ts`, `failure-alerts.ts`).
- **Per-job model, thinking level and a light context.** The last meaningful result is saved and given to the next run.
- **Do not copy the old heartbeat design** (`HEARTBEAT_OK`, `ackMaxChars`): upstream retired it.

### B6. Background commands that wake the conversation when they exit (M to L)

- **OpenClaw:** `exec` returns after 10 s and leaves the command running; on exit a turn starts in the originating session with exit code, duration and the last 2,000 characters (`openclaw:docs/gateway/background-process.md`). A `process` tool polls, reads logs and kills. After a restart the chat is told which commands were lost.
- **Why:** builds and test runs hold the turn, or the agent sleeps and polls.
- **Roundhouse:** must be built: a custom tool through pi's `registerTool`, a process registry, and a wake through `sendUserMessage`. `src/subagents/` (watcher, pid tracking) is a starting point.
- **Risk:** orphaned processes; wake turns arriving unattended.

### B7. Resume after a restart, on request (S)

- **OpenClaw:** an interrupted session gets one input on the next start telling it the gateway restarted and to check the state of anything in progress before repeating it (`openclaw:src/gateway/session-restart-resume-prompt.ts`). `/restart` and updates leave a sentinel so the chat that asked gets a plain result with no model turn. Restarts wait until work is idle.
- **Roundhouse:** already lists the requests that were cut off and waits for the owner to say "continue". What is left: an optional resume turn, and a plain "back online" notice in place of the boot turn.
- **Risk:** resuming the turn that caused the crash. OpenClaw resumes once and stops channels after three unclean boots in five minutes.

### B8. Reassemble bursts before they become turns (S)

- **OpenClaw:** a 300 ms quiet window for text, extended to 1.5 s after a message of 4,000 or more characters so a long paste that Telegram split is rejoined; forwards get 1 s (`openclaw:extensions/telegram/src/bot-handlers.inbound-buffer.ts`). Commands bypass it.
- **Roundhouse:** a small buffer in front of the per-chat chain in `accept()`.
- **Risk:** 300 ms of latency; `/cancel` must also drop buffered text.

### B9. One status message while working, the answer as its own message (M)

- **OpenClaw:** one edited status message (headline, plan steps, current tool) that is cleared when the turn completes, with the answer as a normal message. It appears after 1.5 s and edits at most once a second (`openclaw:extensions/telegram/src/draft-stream.ts`). Repeated tool rows collapse ("Exec ×12"). Optional reactions on the owner's message for queued, thinking, tool, done and error.
- **Roundhouse today:** with verbose off, a long turn shows only "typing…"; with verbose on, one bubble per tool call, and every interim line is a separate message that notifies. `transport.progress()` (`src/transports/telegram/progress.ts`) already does edit-in-place. Forward `thinking_start`/`thinking_end` and the arguments of `tool_execution_start` from the pi adapter; send the status and interim text with `disable_notification`.
- **Trap:** which bubble is the final one is not known when it starts.

### B10. Compaction that checks its own summary (S to M)

- **OpenClaw:** the summary must contain sections for decisions, open TODOs, constraints and rules, pending user asks and exact identifiers (`openclaw:src/agents/agent-hooks/compaction-safeguard-quality.ts`). Afterwards the current time and named sections of the agent's instructions are re-injected. (Rejecting a truncated summary and keeping history when none is produced: docs only.)
- **Why:** at 1M, compaction is rare, but each one discards far more.
- **Roundhouse:** `compact(customInstructions)` and pi's `session_before_compact` hook, in `src/memory/lifecycle.ts`.
- **Risk:** a retry costs a second large summary.

### B11. `/btw`, a side question during a turn (S to M)

- **OpenClaw:** answered from a snapshot of the session, with no tools, never written to history, while the main run continues (`openclaw:src/agents/btw.ts`).
- **Roundhouse:** the session's messages plus a direct model call, as an `immediate` command.
- **Risk:** on a large session a call whose prefix differs from the main run misses the prompt cache and reads everything at full price.

### B12. `/context` and a per-reply usage line (S)

- **OpenClaw:** `/context` shows the size of each injected file, the tool schemas and the system prompt; `/usage` appends tokens, cache hit and cost to each reply; a one-line notice when a fallback model answered.
- **Roundhouse:** `/status` has the session's cost and cache use. pi's `getSessionStats()` gives the per-turn delta. Keep it off by default.

## C. From the survey of roundhouse itself, not yet done

- **PDFs** have no direct route to the model: pi's message content is text and images only, and its `read` tool does not parse PDF. The agent has to shell out.
- **Typing loops in `/doctor` and `/crons`** still use the bare thread, so Telegram shows a phantom typing indicator after them (`typingTarget` in the gateway fixes this for turns and `/compact`).
- **A turn whose answer was delivered but which is still in post-turn work** (memory finalize, flush) when the gateway stops is reported as unfinished at the next start.
- **Expired OAuth credentials** produce pi's "Run '/login x'" text in chat, which is not a roundhouse command.
- **Hard cuts** of a single line longer than Telegram's limit can land inside inline markup, so both halves show the markers literally. Nothing is lost.
- **Telegram delivery, left from the review of the rendering fix:**
  - A message with more than 100 formatted spans may exceed Telegram's entity limit (recalled, not verified); the splitter counts characters only.
  - A line of several thousand `>` or `-` characters loses a few of them or turns into rules, and a table header of about 4,090 characters produces one chunk over the limit.
  - An edit that Telegram applied but whose response was lost is posted again as a new message.
  - A stream of one-character pieces costs more per piece as the answer grows; a 1M-character answer streamed that way is slow.
  - A rate limit longer than 90 s per answer drops the rest of that answer with a log line; the owner is not told in chat.
  - Tilde fences (`~~~`) are not read as code blocks, and a closing fence followed by text on the same line does not close the block (as in CommonMark).
  - `telegramFetch` is called without a timeout of its own.
- **Slack pairing** has no one-time code: the first user whose display name matches is paired. Slack users are admitted by id only, but the pairing step is the weak link.
- **`roundhouse setup` and `roundhouse update`** install unpinned software: latest npm packages, a skills repository at its default branch, and the uv installer piped to a shell.
- **The CI workflow does not run the typecheck.** Adding it needs a token with the `workflow` scope.

## D. Deliberately not copied from OpenClaw

- **Durable ingress and delivery machinery** (an update spool, outbound replay, lanes with priority aging). It exists for many channels and many users; a per-chat chain and the interrupted-request markers cover one owner.
- **Multi-user and multi-device features:** collaborative steering, operator roles, per-sender tool policy, multi-agent routing, nodes, a plugin SDK, a control UI.
- **Embedding-based memory, a blocking recall step before every reply, nightly rewrites of the memory file.** On a 1M window with a shell, grep over the memory files and one nightly "distil the daily notes" job do most of it.
- **Auth-profile rotation and cooldown state machines.** One optional fallback model with a notice is enough.
- **Chat commands that run host shell directly or change gateway configuration**, an "elevated" mode that skips approvals, and auto-approved self-modification.
- **A model that reviews commands for approval.** On a personal machine the reviewer has to be the owner.
- **Auto-continuation after every turn** (`/goal`, `/loop`): unattended shell use with open-ended spend.
- **Container sandbox backends.** OpenClaw leaves the owner's main session unsandboxed by default anyway. Running the gateway as a dedicated OS user is the cheaper isolation, and the README already suggests it.

## E. Security notes from the comparison

- **OpenClaw's default is the same as roundhouse's:** an allowed user gets host shell with no approval prompt. Everything stronger there is opt-in.
- **Worth taking:**
  - the approval gate (B4);
  - an owner id distinct from "allowed to chat", required for `/restart`, `/update` and `/model`;
  - removing the bot token from the environment of the agent's child processes. Partial at best: `~/.roundhouse/.env` stays readable by the agent.
- **Advisory only, there as here:** wrapping external content in markers, and prompt-injection defences in general. OpenClaw puts prompt-injection-only attacks out of scope in its security policy.

## F. Not determined

- OpenClaw's source was read at the functions and constants named above, not end to end, and its 2026.11.5 release notes were skimmed by keyword.
- Nothing in section B was prototyped. The pi capabilities named were read from its type declarations and docs.
- Whether a `tool_call` handler in pi may wait minutes (B4), whether pi has a fallback-model chain, and the cache cost of B11 on a large session are open.

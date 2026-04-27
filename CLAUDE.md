# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start                        # run gateway via tsx (src/index.ts)
npm run dev                      # tsx watch
npm test                         # vitest run (single pass)
npm run test:watch               # vitest watch
npx vitest run test/unit.test.ts # run a single test file
npx vitest run -t "splitMessage" # run tests matching a name
```

There is no lint or typecheck script. TypeScript is executed directly via `tsx`; `tsc` is never invoked at build/runtime. The only "build" happens implicitly when the CLI's `start` command prefers a compiled `src/dist/index.js` if present, otherwise re-runs `tsx` on `src/index.ts`.

The repo uses a custom git hooks path: `git config core.hooksPath .githooks` (already set locally). `.githooks/pre-commit` scans staged diffs for secret patterns (Telegram/Anthropic/OpenAI/AWS/NPM) and blocks commits. Don't bypass with `--no-verify` unless the user asks.

## Architecture

Roundhouse is a chat-gateway between chat platforms (via Vercel Chat SDK) and a **single** AI agent backend. Read `architecture.md` for diagrams; the points below are what's not obvious from the code.

**One gateway = one agent target.** Selection happens at startup from `config.agent.type` via `src/agents/registry.ts`. The `AgentRouter` seam (`src/router.ts`) currently always returns that one agent (`SingleAgentRouter`), but the interface is there so per-thread/multi-agent routing can be added without touching `gateway.ts` or the adapters.

**Streaming path vs. fallback path.** `Gateway.handleStreaming` (src/gateway.ts) prefers `agent.promptStream()` if the adapter implements it. It turns pi's event stream into Chat SDK calls:
- `text_delta` → buffered into a per-turn `AsyncIterable<string>` passed to `thread.handleStream()` (which does post+edit with rate limiting)
- `tool_start` → a compact status message via `thread.post()` (separate bubble)
- `custom_message` → flush the current streaming turn, post as its own bubble (used by pi extensions like pi-lgtm code review)
- `turn_end` / `agent_end` → flush so the next turn starts a fresh message
If `promptStream` is missing, `agent.prompt()` is called and the full text is split/posted via `postWithFallback` (markdown-first, plaintext fallback).

**Pi adapter nuance — private event queue drain.** `src/agents/pi.ts` awaits `session._agentEventQueue` (a private field of `@mariozechner/pi-coding-agent`'s `AgentSession`) after every `prompt()` / `agent.continue()`. Without this drain, extension `agent_end` handlers (e.g. pi-lgtm's review) haven't finished and their `followUp` messages or `custom_message` events race against the `unsubscribe()` in the `finally` block, causing lost review bubbles. The field access is wrapped in `if (queue)` — if upstream renames it, behavior silently reverts to the pre-fix race. See the big comment in `drainSessionEvents()` for context before touching it.

**Pi adapter nuance — subscribers must outlive extension-triggered runs.** `runPromptAndFollowUps` loops on *both* `session.isStreaming` (awaits `agent.waitForIdle()`) and `agent.hasQueuedMessages()` (awaits `agent.continue()`). When an extension calls `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })` inside its `agent_end` handler, pi's `sendCustomMessage` picks one of two branches depending on `isStreaming` at that moment: if still streaming it queues via `agent.followUp()` (caught by `hasQueuedMessages`); if already idle it bypasses the queue and calls `agent.prompt(appMessage)` directly as fire-and-forget, kicking off a new run that is *only* visible via `isStreaming`. The pi CLI is immune because its subscriber stays attached across runs; our per-prompt subscriber must loop on both conditions or we unsubscribe mid-run and Telegram sees the review bubble followed by silence. Don't collapse the loop to a single condition.

**Thread serialization.** The pi adapter keeps one queue per `threadId` (`threadQueues` in pi.ts). `prompt()` and `promptStream()` both `enqueue()` onto this chain so overlapping user messages in the same thread never race inside the pi session. Don't remove this — pi sessions are not safe for concurrent prompts.

**Per-thread sessions persist as `.jsonl`** at `<sessionDir>/<threadIdToDir(threadId)>/<session>.jsonl` (default `~/.pi/agent/gateway-sessions/`). Thread IDs are encoded reversibly by `threadIdToDir` in `src/util.ts` (`_` → `_u`, `:` → `_c`, other → `_x`) so that `telegram:123` and `telegram_123` do not collide. `SessionManager.continueRecent` resumes the most recent jsonl in that dir; `SessionManager.create` starts a new one if none exist.

**Config resolution order** (src/config.ts → `loadConfig`): `ROUNDHOUSE_CONFIG` env → `--config <path>` CLI flag → `~/.roundhouse/gateway.config.json` (with legacy fallback to `~/.config/roundhouse/`) → `./gateway.config.json` → `DEFAULT_CONFIG`. Then `applyEnvOverrides` layers `BOT_USERNAME`, `ALLOWED_USERS`, `NOTIFY_CHAT_IDS` on top. Secrets (`TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`) are always env-only, never read from config.

**Install/daemon.** `roundhouse install` writes `~/.roundhouse/gateway.config.json`, an env file at `~/.roundhouse/env` (merged with existing so manually-added keys survive), and a systemd unit that runs either the global bin or tsx against the source. `roundhouse update` does `npm update -g` then `systemctl restart`. All chat input in the daemon goes through the unit's `EnvironmentFile`.

**Adding a new agent backend:** implement `AgentAdapter` from `src/types.ts` in `src/agents/<name>.ts`, register in `src/agents/registry.ts`, set `"agent": { "type": "<name>" }` in config. If you want streaming, implement `promptStream` yielding `AgentStreamEvent`s; otherwise `prompt` alone is enough and the gateway will fall back.

**Adding a new chat platform:** install the `@chat-adapter/<platform>` package, lazy-import it in `buildChatAdapters` inside `src/gateway.ts`, and add a corresponding entry to `GatewayConfig["chat"]["adapters"]` in `src/types.ts`. The unified `handle()` in `gateway.ts` already covers all platforms.

## Debugging

Set `ROUNDHOUSE_DEBUG_STREAM=1` to log every stream event in `gateway.ts` (`[roundhouse/stream]`) and every pi session event in `pi.ts` (`[pi-agent/sub]`). Evaluated once at module load (`DEBUG_STREAM` in `src/util.ts`), so toggling requires a restart.

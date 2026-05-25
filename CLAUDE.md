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

**Streaming path vs. fallback path.** `Gateway.handleStreaming` (`src/gateway/gateway.ts`) prefers `agent.promptStream()` if the adapter implements it. It turns pi's event stream into Chat SDK calls:
- `text_delta` → buffered into a per-turn `AsyncIterable<string>` passed to `thread.handleStream()` (which does post+edit with rate limiting)
- `tool_start` → a compact status message via `thread.post()` (separate bubble)
- `custom_message` → flush the current streaming turn, post as its own bubble (used by pi extensions like pi-lgtm code review)
- `turn_end` / `agent_end` → flush so the next turn starts a fresh message
If `promptStream` is missing, `agent.prompt()` is called and the full text is split/posted via `postWithFallback` (markdown-first, plaintext fallback).

**Pi adapter nuance — private event queue drain.** `src/agents/pi/pi-adapter.ts` awaits `session._agentEventQueue` (a private field of `@earendil-works/pi-coding-agent`'s `AgentSession`) after every `prompt()` / `agent.continue()`. Without this drain, extension `agent_end` handlers (e.g. pi-lgtm's review) haven't finished and their `followUp` messages or `custom_message` events race against the `unsubscribe()` in the `finally` block, causing lost review bubbles. The field access is wrapped in `if (queue)` — if upstream renames it, behavior silently reverts to the pre-fix race. See the big comment in `drainSessionEvents()` for context before touching it.

**Pi adapter nuance — subscribers must outlive extension-triggered runs.** `runPromptAndFollowUps` loops on *both* `session.isStreaming` (awaits `agent.waitForIdle()`) and `agent.hasQueuedMessages()` (awaits `agent.continue()`). When an extension calls `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })` inside its `agent_end` handler, pi's `sendCustomMessage` picks one of two branches depending on `isStreaming` at that moment: if still streaming it queues via `agent.followUp()` (caught by `hasQueuedMessages`); if already idle it bypasses the queue and calls `agent.prompt(appMessage)` directly as fire-and-forget, kicking off a new run that is *only* visible via `isStreaming`. The pi CLI is immune because its subscriber stays attached across runs; our per-prompt subscriber must loop on both conditions or we unsubscribe mid-run and Telegram sees the review bubble followed by silence. Don't collapse the loop to a single condition.

**Thread serialization.** The pi adapter keeps one queue per `threadId` (`threadQueues` in pi.ts). `prompt()` and `promptStream()` both `enqueue()` onto this chain so overlapping user messages in the same thread never race inside the pi session. Don't remove this — pi sessions are not safe for concurrent prompts.

**Per-thread sessions persist as `.jsonl`** at `<sessionDir>/<threadIdToDir(threadId)>/<session>.jsonl` (default `~/.pi/agent/gateway-sessions/`). Thread IDs are encoded reversibly by `threadIdToDir` in `src/util.ts` (`_` → `_u`, `:` → `_c`, other → `_x`) so that `telegram:123` and `telegram_123` do not collide. `SessionManager.continueRecent` resumes the most recent jsonl in that dir; `SessionManager.create` starts a new one if none exist.

**Config resolution order** (src/config.ts → `loadConfig`): `ROUNDHOUSE_CONFIG` env → `--config <path>` CLI flag → `~/.roundhouse/gateway.config.json` (with legacy fallback to `~/.config/roundhouse/`) → `./gateway.config.json` → `DEFAULT_CONFIG`. Then `applyEnvOverrides` layers `BOT_USERNAME`, `ALLOWED_USERS`, `NOTIFY_CHAT_IDS` on top. Secrets (`TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`) are always env-only, never read from config.

**Install/daemon.** `roundhouse install` writes `~/.roundhouse/gateway.config.json`, an env file at `~/.roundhouse/.env` (merged with existing so manually-added keys survive), and a systemd unit that uses `roundhouse run` (foreground mode) as ExecStart. `roundhouse start` starts the daemon via systemctl; `roundhouse run` runs in the foreground (used by systemd and for dev). `roundhouse update` does `npm update -g` then `systemctl restart`. All chat input in the daemon goes through the unit's `EnvironmentFile`.

**Adding a new agent backend:** implement `AgentAdapter` from `src/types.ts` in `src/agents/<name>.ts`, register in `src/agents/registry.ts`, set `"agent": { "type": "<name>" }` in config. If you want streaming, implement `promptStream` yielding `AgentStreamEvent`s; otherwise `prompt` alone is enough and the gateway will fall back.

**Adding a new chat platform:** install the `@chat-adapter/<platform>` package, register it in `chatAdapterFactories` (`src/transports/chat-adapters.ts`), implement a `TransportAdapter` (`src/transports/<name>/<name>-adapter.ts`), add it to `buildTransportDelegates` in `src/gateway/gateway.ts`, and add a corresponding entry to `GatewayConfig["chat"]["adapters"]` in `src/types.ts`. The composite transport routes all per-thread methods automatically by `ownsThread`/`ownsChatId`.

**Multi-transport composition.** A single gateway runs all configured transports simultaneously through `CompositeTransportAdapter` (`src/transports/composite.ts`). The composite owns a `delegates: TransportAdapter[]` and routes:
- per-thread methods (`postMessage`, `postRich`, `progress`, `stream`, `enrichPrompt`) by the first delegate where `ownsThread(thread)` is true;
- `notify(chatIds, ...)` by partitioning chat ids by `ownsChatId` then fanning out;
- `handlePairing` to the first delegate that returns non-null, decorated with `transport: <delegateName>` so the gateway tracks `pairingComplete` per-transport (a `Map<string, boolean>` — a single boolean would silently block the second transport's pairing once the first paired);
- `registerCommands` and `dispose` to all delegates.
The gateway never branches on platform; everything reads `this.transport.foo()` against the composite.

**Slack adapter nuances.**
- Thread ids are `slack:CHANNEL:THREAD_TS`. Always use `sdk.encodeThreadId({ channel, threadTs })` and `sdk.decodeThreadId(id)` — never split manually. Top-level posts use `threadTs: ""` (sentinel); the `progress.ts` and `streaming.ts` helpers check for `"" | "main"` and elide `thread_ts` when posting.
- `AdapterPostableMessage` is `string | { raw } | { markdown } | { ast } | { card } | CardElement` (`chat@4.29.0` `chat-D9UYaaNO.d.ts:1549`). **There is no `blocks` field.** Menus go through `{ card, fallbackText }` and the SDK's `cardToBlockKit` does the conversion internally. Same model works for telegram via `extractCard`. The transport-agnostic `richMenuToCard` lives in `src/transports/rich-helpers.ts` and is shared.
- **Streaming + Block Kit can't coexist.** Slack's stream API doesn't take blocks. Decision: streaming turns are agent text only; menu turns are command results that don't stream. If a future feature needs both, finalize the stream first then post a separate menu message.
- **`SlackAdapter.attach(slackSdk)` lifecycle.** Must be called *after* `chat.initialize()` because the Chat SDK Slack adapter populates `_botUserId` and starts socket-mode during initialize. The gateway does this for you (`gateway.ts` post-`chat.initialize()` block); don't call `attach()` earlier or webClient calls will throw `AuthenticationError`.
- **Bot self-loop filtering.** Slack delivers the bot's own messages back through `message.channels` / `message.groups` if those scopes are enabled. The Chat SDK does central isMe filtering; verified that the SDK's `initialize()` already calls `auth.test` and populates `_botUserId` before subscriptions activate (`@chat-adapter/slack@4.29.0` `index.js:868-885`), so the filter is armed by the time events flow.
- **Pairing chicken-and-egg.** Slack's `message.im` only fires for *existing* DM channels. To support users who haven't DM'd the bot yet, the gateway also registers `bot.onAssistantThreadStarted` and synthesizes an IncomingMessage from the event (resolving the user via `slackSdk.getUser(userId)` so the allowlist's userName check has a value to match). Both paths flow through the same `transport.handlePairing` → composite seam.
- **Per-transport boot turn.** `fireBootTurn` partitions `notifyChatIds` by `ownsChatId` and fires one boot turn against the first chatId owned by each transport — not the global `chatIds[0]`. Otherwise multi-transport installs would silently favor whichever transport happened to be listed first.
- `createSlackAdapter` env-var fallback only fires when called with NO config (`zeroConfig = !config`). The factory in `src/transports/chat-adapters.ts` therefore explicitly forwards `process.env.SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` / `SLACK_SIGNING_SECRET` so they're populated regardless of whether other config keys are set. Verified against `dist/index.js:4233-4243`. Skipping this is a silent `AuthenticationError: No bot token available` at runtime.

**Type widening for multi-transport.** `allowedUserIds` and `notifyChatIds` are `(string | number)[]` (Telegram numeric, Slack string). `ChatThread.post` accepts `string | { markdown } | { card, fallbackText? }`. `IncomingMessage.chatId` is `string | number`. `isAllowed` does dual lookup against the heterogeneous union by normalizing both sides to `String()`. Several legacy `Number()` coercion sites were caught in Phase 1 (`gateway.ts:113, 329, 352, 978-1001, 1017-1021`, `subagent-command.ts`, `ipc/handler.ts`) — preserve string IDs end-to-end; don't reintroduce `parseInt` or `Number()` casts.

## Debugging

Set `ROUNDHOUSE_DEBUG_STREAM=1` to log every stream event in `gateway.ts` (`[roundhouse/stream]`) and every pi session event in `pi.ts` (`[pi-agent/sub]`). Evaluated once at module load (`DEBUG_STREAM` in `src/util.ts`), so toggling requires a restart.

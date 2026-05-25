# Plan: Slack Adapter for Roundhouse (v4)

> **Revision history:**
> - **v1** reviewed by independent subagent → verdict: minor-to-major revisions.
> - **v2** addressed v1's 17 findings → verdict: minor revisions.
> - **v3** restructured around the Chat SDK `Card` model after verifying the `.d.ts` files → verdict: minor revisions (5 small findings).
> - **v4** closes the v3 findings:
>   - `createThread.post` signature dropped the v2-residual `blocks`/`text` shape; now matches the widened `ChatThread.post`.
>   - Phase 1 checklist adds `TelegramAdapter.createThread.post` widening (with a fallback gate if the migration proves heavy).
>   - `fireBootTurn` partition logic clarified: "first chatId owned by each transport," not the global `chatIds[0]`.
>   - `assistant_thread_started` pairing path now does an explicit `slackSdk.getUser(userId)` lookup so allowlist matching has a `userName` to compare; `userId`-literal allowlist entries are also supported as a fallback.
>   - `composite.identifyOwner` collapsed into the existing `ownsThread` walk via `composite.delegates.find(...)` — no new method.
>   - Verification table cite for `Thread.post` corrected from line 100 (ChannelImpl) to 298 (Thread); `dispatchInteractivePayload` annotated as protected SDK plumbing.
>
> **Earlier v3 changes (preserved):**
>   - **`postRich` uses the Chat SDK's transport-agnostic `Card` model** (not a hand-rolled Block Kit converter). The Slack adapter converts `Card → cardToBlockKit` internally; Telegram converts `Card → inline keyboard` via `extractCard`. We map `RichMenu → CardElement` once, transport-agnostic. **This eliminates v2 §2.3 entirely** and unifies with what telegram already does.
>   - **`bot.onAssistantThreadStarted` is a real public method on `ChatInstance`** (`chat-D9UYaaNO.d.ts:2913`). The iter-2 reviewer was wrong on this; the protected method they cited is on the Slack adapter, not the public `ChatInstance`. Verified.
>   - **`AdapterPostableMessage` is `string | { raw } | { markdown } | { ast } | { card } | CardElement`** — there is no `blocks` field on the Chat SDK's input. v2's `{ blocks, text }` shape was wrong. v3 uses `{ card }`.
>   - Streaming polish: abort handling, initial-post failure recovery, throttled overflow.
>   - `req.session` numeric-regex parsing in `ipc/handler.ts` is widened to use `ownsChatId`.
>   - Cron scheduler/runner notifyFn signature widened to `(string | number)[]`.
>   - `pairingComplete` race spelled out: gate is per-transport AND `composite.handlePairing` is only called if any transport reports pending.
>   - `ChatThread.post` signature reconciled with what adapters accept (the SDK already accepts the union we want).
>   - Section "What's still unverified" removed; everything in v3 is anchored to the version-pinned `.d.ts`.

> **Memory note:** Chat SDK types may drift between versions. Every type/interface shape in this plan is anchored to `chat@4.29.0` / `@chat-adapter/slack@4.29.0` / `@chat-adapter/telegram@4.29.0`. Re-verify against the same versions before implementation; don't quote shapes from memory.

## Overview

Add Slack as a first-class chat transport alongside Telegram, using the existing `TransportAdapter` contract in `src/transports/types.ts`. Two design decisions are fixed up front:

1. **Socket mode only (v1).** WebSocket connection — no public URL needed. Single Slack workspace per gateway. Best fit for self-hosted deployments.
2. **Multi-transport composition.** One gateway instance can run Telegram and Slack simultaneously. Routing between them is owned by a new `CompositeTransportAdapter`; the gateway code keeps reading like it does today (`this.transport.foo()`).

The work is split into 5 phases. Each phase is meant to land as its own PR so reviews stay tractable.

---

## Phase 0 — Bump Chat SDK to 4.29 *(separate PR, low-risk)*

### Why first
- We're 3 minor versions behind (locked at 4.26.0; latest 4.29.0).
- 4.29 release notes call out "previous type names kept as deprecated aliases" — backwards-compatible.
- Unlocks `@chat-adapter/slack@4.29.0` matched to the same release as the rest of the SDK.
- Unlocks `@chat-adapter/tests@4.29.0` (Vitest factories + matchers like `toHavePosted`) for Phase 4 — **but** we have a fallback if it doesn't exist (see Phase 4).

### Changes
- `package.json`: bump `chat`, `@chat-adapter/telegram`, `@chat-adapter/state-memory` to `^4.29.0`.
- `npm install` to refresh `package-lock.json`.

### Verification
- `npm test` passes (existing suite).
- **Diff `node_modules/@chat-adapter/telegram/dist/index.d.ts` between 4.26 and 4.29.** Look at the `Adapter<TThreadIdData, TRaw>` generic, telegramFetch shape, and `processUpdate`. Note any signature drift (the reviewer flagged this as more important than the `video_note` change).
- Verify the bot's own messages don't echo back (Slack and Telegram both do central isMe filtering — see Phase 2 risk #6 for the eager `auth.test` mitigation).
- Smoke test: start gateway with current Telegram setup, exchange a few messages, run `/status`, `/compact`, `/cancel`. Verify streaming still works end-to-end.

### Risks
- 4.29 changed adapter internals from `private` to `protected`. We don't subclass, so no runtime impact.
- Telegram now handles `video_note` round videos as video attachments — previously dropped silently. Verify `saveAttachments` doesn't choke on the new mediaType.

---

## Phase 1 — Multi-transport refactor *(no Slack code yet)*

The codebase already has good seams; this phase finishes the job so adding the second transport doesn't require touching `gateway.ts`.

### 1.1 Widen ID types from `number` to `string | number`

Slack IDs are strings (`U02XXXX` for users, `C03XXXX` / `D03XXXX` for channels). Telegram IDs are numbers. **The full sweep (verified line by line) is bigger than v1 estimated:**

| File | Today | Change |
|---|---|---|
| `src/types.ts` `GatewayConfig.chat.allowedUserIds` | `number[]` | `(string \| number)[]` |
| `src/types.ts` `GatewayConfig.chat.notifyChatIds` | `number[]` | `(string \| number)[]` |
| `src/transports/types.ts` `PairingResult` | already `string \| number` ✓ | no change |
| `src/transports/types.ts` `TransportAdapter.createThread(chatId: number)` | numeric | `createThread(chatId: string \| number)` |
| `src/transports/types.ts` `TransportAdapter.notify(chatIds: number[], …)` | numeric | `notify(chatIds: (string \| number)[], …)` |
| `src/util.ts:50-65` `isAllowed(allowedUserIds?: number[])` | `parseInt(author.userId, 10)` then `.includes(numericId)` | accept `(string \| number)[]`; compare via dual lookup: numeric path for tg-style numeric strings, raw-string path for slack-style `Uxxx` |
| `src/util.ts:50` signature | `allowedUserIds?: number[]` | `allowedUserIds?: (string \| number)[]` |
| `src/gateway/gateway.ts:113` | `Number(rawThreadId)` then `Number.isFinite` guard | preserve string when transport says ID is a string; coerce numbers only when both raw values are numeric |
| `src/gateway/gateway.ts:122-141` | numeric persistence in config | persist as-is (JSON handles either) |
| `src/gateway/gateway.ts:329-333` `notifyFn: (chatIds: number[], …)` | numeric | `(string \| number)[]` |
| `src/gateway/gateway.ts:352` `Number(status.routing?.chatId)` | NaN-coerces Slack ID | drop the `Number()` cast; pass through as `string \| number`; route via `transport.notify([id], msg)` (composite partitions by `ownsChatId`) |
| `src/gateway/gateway.ts:978-1001` `notifyStartup` `Number(chatId) < 0` | telegram negative-id semantics | move "group:" detection into `TelegramAdapter.formatNotifySession(id)` (returns `"main" \| "group:N"`); Slack always returns `"main"` |
| `src/gateway/gateway.ts:1017-1021` `fireBootTurn(chatIds[0])` | telegram-only assumption | **partition `notifyChatIds` by `ownsChatId`, fire one boot turn per transport that has a primary chat id**; the gateway iterates the partitioned map |
| `src/cli/subagent-command.ts:30-38` hardcoded `` `telegram:${chatId}:main` `` | telegram-only | resolve transport by `ownsChatId`; encode `parentThreadId` per transport (Slack: `slack:${channel}:${threadTs ?? "main"}`; Telegram: `telegram:${chatId}:main`); the encoding lives behind a `transport.encodeParentThreadId(chatId)` method |
| `src/ipc/handler.ts:17-30` numeric coercions in notify routing | `targetIds: number[]`; `req.session` matched via `/^-?\d+$/` regex | (a) widen `targetIds: (string \| number)[]`; (b) replace numeric regex with `transport.ownsChatId(req.session)` so a Slack `Cxxx` / `Dxxx` session value is treated as a single-target id, not falling through to "send to all"; (c) `transport.notify` already partitions by `ownsChatId` so no further work after this site |
| `src/cron/scheduler.ts:44` `notifyFn?: (chatIds: number[], text: string) => Promise<void>` | numeric | `(string \| number)[]`; same change in `cron/runner.ts` constructor signature |
| `src/cron/runner.ts` `defaultChatIds` | `number[]` | `(string \| number)[]` |
| `src/cron/scheduler.ts` (notifyChatIds plumbing) | numeric | propagate `(string \| number)[]` |
| `src/transports/telegram/notify.ts` `sendTelegramMessage(chatId: string \| number, …)` | already `string \| number` ✓ | no change (already widened) |

**Tests to update / add:** `config.test.ts`, `gateway-helpers.test.ts`, `setup.test.ts`. Add cases mixing string and number IDs in the same allowlist; add a test that proves `isAllowed` matches a numeric-string-encoded telegram user id (`"12345"`) AND a slack `Uxxx` id without crossing wires.

### 1.1.5 Reconcile `ChatThread.post` signature with what adapters actually accept

The current `src/transports/types.ts` declares:
```ts
export interface ChatThread {
  id: string;
  post(text: string): Promise<void>;
  [key: string]: unknown;
}
```

But the SDK's real `Thread.post` (per `chat@4.29.0` `chat-D9UYaaNO.d.ts:100, 298`):
```ts
post(message: string | AdapterPostableMessage | AsyncIterable<string> | ChatElement): Promise<SentMessage>;
```

Our local `ChatThread` interface is a structural lie — narrower than reality. Widen it so transports can pass `{ markdown }` and `{ card, fallbackText }` without `as any` casts:

```ts
export interface ChatThread {
  id: string;
  post(message: string | { markdown: string } | { card: unknown; fallbackText?: string }): Promise<void>;
  [key: string]: unknown;
}
```

Keep `unknown` for the card field (the actual `CardElement` type is `chat@4.29.0`-specific; we don't want to import it into the local interface and tie it to a particular SDK version). Adapters that touch `card` cast at the boundary the same way `TelegramAdapter.postRich` casts to access `adapter.telegramFetch`.

**`enrichPrompt(thread, text)` call-site inventory (verified before locking the signature change):** the callers are `Gateway.prepareAgentMessage` (gateway.ts:666) and any synthetic-thread path that goes through `prepareAgentMessage`. Boot turn (gateway.ts:1026), sub-agent injection (gateway.ts:1082), and cron notifications (`cron/runner.ts`) all build a thread via `transport.createThread()` first and pass that thread into the agent-turn flow — so they all already have a `thread` to pass. **No additional callers**; the change is mechanical.

### 1.2 Add `ownsChatId(id)` and `encodeParentThreadId(chatId)` to `TransportAdapter`

```ts
// src/transports/types.ts
export interface TransportAdapter {
  // …existing methods…

  /**
   * Pure shape check — return true iff this transport recognizes the given
   * chat ID format. No I/O.
   *
   * Telegram: typeof id === "number" || /^-?\d+$/.test(String(id))
   * Slack:    typeof id === "string" && /^[CDGU]/.test(id)
   *
   * The composite uses this to partition `notifyChatIds` and route notify().
   */
  ownsChatId(id: string | number): boolean;

  /**
   * Build a synthetic "parent thread id" string for sub-agent / cron routing
   * from a single chat id. Encodes the platform prefix and any extra
   * coordinates the transport needs (Slack needs threadTs; "main" sentinel is
   * acceptable for top-level channel posts).
   *
   * Telegram: `telegram:${chatId}:main`
   * Slack:    `slack:${channelId}:main`  (top-level; threadTs filled when known)
   */
  encodeParentThreadId(chatId: string | number): string;

  /**
   * Format a chat id for human-facing "session: …" labels in startup notifications.
   * Replaces the inline `Number(chatId) < 0 ? "group:..." : "main"` logic
   * that only made sense for Telegram.
   */
  formatNotifySession(chatId: string | number): string;
}
```

Update `TelegramAdapter` to implement all three. Slack will implement them in Phase 2.

### 1.3 Extract `chatAdapterFactories` registry

`src/gateway/gateway.ts:61-74` has a hardcoded `if (config.telegram)` block. Replace with a registry so adding a transport is one line:

```ts
// src/transports/chat-adapters.ts (NEW)
type ChatAdapterFactory = (config: Record<string, unknown>) => unknown;

export const chatAdapterFactories: Record<string, () => Promise<ChatAdapterFactory>> = {
  telegram: async () => {
    const { createTelegramAdapter } = await import("@chat-adapter/telegram");
    return (cfg) => createTelegramAdapter({ mode: (cfg.mode as any) ?? "auto" });
  },
  slack: async () => {
    const { createSlackAdapter } = await import("@chat-adapter/slack");
    return (cfg) => createSlackAdapter({
      mode: (cfg.mode as any) ?? "socket",
      // tokens come from env — the SDK auto-reads SLACK_BOT_TOKEN /
      // SLACK_APP_TOKEN, so we don't pass them explicitly unless overridden
    });
  },
};
```

`buildChatAdapters` becomes a loop over the configured keys. **Failure mode:** if a configured key has no factory, throw at startup — never silently drop a transport the user expected.

### 1.4 Composite TransportAdapter

```
src/transports/composite.ts (NEW, ~200 LoC — heavier than v1's 150 estimate)
```

Implements `TransportAdapter` over `Map<string, TransportAdapter>`. Routing rules:

| Method | Routing |
|---|---|
| `enrichPrompt(thread, text)` | by `ownsThread(thread)` (signature changes to add `thread`) |
| `postMessage`, `postRich`, `progress`, `stream` | first delegate where `ownsThread(thread) === true` |
| `createThread(platform, chatId)` | by `platform` arg (caller picks; signature change) |
| `notify(chatIds, text)` | partition `chatIds` by `ownsChatId`, fan out to each delegate |
| `registerCommands()` | call all delegates (each self-sources its creds) |
| `ownsThread(thread)` | true if any delegate claims it |
| `ownsChatId(id)` | true if any delegate claims it |
| `encodeParentThreadId(chatId)` | first delegate where `ownsChatId(chatId)` |
| `formatNotifySession(chatId)` | first delegate where `ownsChatId(chatId)` |
| `isPairingPending()` | `Promise.all` → `.some()` |
| `handlePairing(thread, message)` | first delegate that returns non-null; **does not short-circuit on `pairingComplete`** (see 1.6) |
| `dispose()` | `Promise.all` |
| `shouldIgnoreMessage(text, message, thread)` | first delegate that owns the thread, or `false` if none |

Failure mode: if no delegate owns a thread for `postMessage`/`postRich`/`stream`/`progress`, log + drop. This matches the existing "best-effort post" model.

**Note on signature changes:**
- `enrichPrompt(thread, text)` — `thread` arg added. Callers are `prepareAgentMessage` (gateway.ts) and any synthetic-thread caller (boot turn, cron, sub-agent inject). Verify the synthetic threads carry transport-identifying ids (`thread.id` starts with `telegram:` / `slack:`) so `ownsThread()` resolves correctly. **Add a test:** `composite.enrichPrompt(syntheticTelegramThread, text)` routes to TelegramAdapter; same for Slack.
- `createThread(platform, chatId)` — `platform` arg added so the caller picks explicitly (gateway has multiple, doesn't have to guess from `chatId` alone).

### 1.5 `registerCommands()` self-sources its credentials

`gateway.ts:937-941` reads `TELEGRAM_BOT_TOKEN` and passes it to `transport.registerCommands(token)` after gating on `if (!this.config.chat.adapters.telegram) return`. Both checks belong in the adapter, not the gateway.

```ts
// TransportAdapter
registerCommands(): Promise<void>;   // signature change: no token arg
```

`TelegramAdapter.registerCommands` early-returns when `process.env.TELEGRAM_BOT_TOKEN` is missing. `SlackAdapter.registerCommands` is a no-op (slash commands live in app manifest, not at runtime).

`Gateway.registerBotCommands` (gateway.ts:937) becomes:

```ts
private async registerBotCommands() {
  await this.transport.registerCommands();   // composite fans out
}
```

The telegram-only gate is gone — composite calls all delegates; each delegate owns its own preconditions.

### 1.6 Per-transport `pairingComplete` (not a single boolean)

`gateway.ts:83` has `private pairingComplete = false`. With composite, the user could pair Telegram now and Slack later. A single boolean gets stuck `true` after the first transport pairs and the second's `isPairingPending()` is silently ignored.

**Fix:**
```ts
// Gateway
private pairingComplete = new Map<string, boolean>();   // keyed by transport name
```

The gateway's incoming-message hook (`gateway.ts:245`) currently reads:

```ts
if (!this.pairingComplete && await this.transport.isPairingPending()) { … }
```

In v3, this becomes:

```ts
const ownerName = this.transport.delegates.find(d => d.ownsThread(thread))?.name;
if (ownerName && !this.pairingComplete.get(ownerName)) {
  if (await this.transport.isPairingPending()) {
    const handled = await this.handlePendingPairing(message, thread);
    if (handled) return;
  }
}
```

Two pieces this requires:

1. **No new method** — the composite already walks delegates; the gateway can find the owning transport via:
   ```ts
   const owner = composite.delegates.find(d => d.ownsThread(thread))?.name;
   ```
   Expose `delegates: ReadonlyArray<TransportAdapter>` on the composite (or a `forEach`/`find` helper if direct exposure feels too leaky). v3 prefers this over introducing `identifyOwner` — fewer methods to test, same semantics.
2. `CompositeTransportAdapter.handlePairing(thread, message): Promise<(PairingResult & { transport: string }) | null>` — returns the delegate name alongside the result. After success, `gateway.handlePendingPairing` sets `this.pairingComplete.set(result.transport, true)`.

**Race scenario the iter-2 reviewer asked about:** both transports pending, Telegram event arrives first.
- `identifyOwner(telegramThread) → "telegram"`. Gate is open (`!pairingComplete.get("telegram")`).
- `transport.isPairingPending()` returns true (Telegram's pairing file still pending).
- `handlePairing(telegramThread, message)` walks delegates in order. Telegram delegate matches; Slack delegate sees a thread it doesn't own and short-circuits via `ownsThread === false` → returns null. Composite returns `{ transport: "telegram", … }`.
- Gateway sets `pairingComplete.set("telegram", true)`. Slack is still pending, untouched.
- Later, Slack event arrives. `identifyOwner → "slack"`. `pairingComplete.get("slack")` is unset → falsy → gate is open. Pairing proceeds.

Resolved cleanly. Add a test in `composite-transport.test.ts` that exercises this exact sequence.

This is a semi-breaking change to the `handlePairing` return type. Old `PairingResult` callers (only the gateway) are updated.

### 1.7 Move `/start` filter into transport via `shouldIgnoreMessage`

`gateway.ts:255` short-circuits `if (_isCmd(userText, "/start", _botUsername))` — Telegram-specific (`/start <nonce>` is the BotFather pairing handshake). Slack has no `/start` semantics.

```ts
// TransportAdapter
/** Pre-handler hook: return true to drop the message before any other gateway logic. */
shouldIgnoreMessage?(text: string, message: IncomingMessage, thread: ChatThread): boolean;
```

Telegram implements it (returns true for `/start`). Slack omits it. Composite routes by `ownsThread(thread)`.

### 1.8 Constructor wiring

```ts
// src/gateway/gateway.ts (constructor)
constructor(router: AgentRouter, config: GatewayConfig) {
  this.router = router;
  this.config = config;
  this.transport = buildCompositeTransport(config.chat.adapters);
  _botUsername = config.chat.botUsername || "";
}
```

`buildCompositeTransport` looks at the config keys and instantiates one `TransportAdapter` per configured platform, then wraps in `CompositeTransportAdapter`. **Always wrap**, even with one transport — the test harness expects a uniform interface, and the composite overhead is negligible (one map lookup per call).

### Phase 1 checklist
- [ ] Widen `allowedUserIds` / `notifyChatIds` types in `src/types.ts`
- [ ] Update `isAllowed` (`src/util.ts`): dual lookup (numeric path + raw-string path); preserve telegram numeric-id matching
- [ ] Add `ownsChatId()`, `encodeParentThreadId()`, `formatNotifySession()` to `TransportAdapter` interface
- [ ] Implement those three on `TelegramAdapter`
- [ ] Add optional `shouldIgnoreMessage()` hook
- [ ] Move `/start` filter into `TelegramAdapter.shouldIgnoreMessage`
- [ ] Change `enrichPrompt(thread, text)` signature
- [ ] Change `createThread(platform, chatId)` signature
- [ ] Change `registerCommands()` signature (no token arg); move `TELEGRAM_BOT_TOKEN` gate into `TelegramAdapter.registerCommands`
- [ ] Change `handlePairing` return type to include `transport: string`
- [ ] Replace `pairingComplete: boolean` with `Map<string, boolean>` in Gateway
- [ ] Fix `gateway.ts:113` (preserve string IDs)
- [ ] Fix `gateway.ts:329-333` (notifyFn signature)
- [ ] Fix `gateway.ts:352` (drop `Number()` cast on sub-agent chatId)
- [ ] Fix `gateway.ts:978-1001` (move negative-id detection into `formatNotifySession`)
- [ ] Fix `gateway.ts:1017-1021` (partition boot-turn chatIds by transport)
- [ ] Fix `cli/subagent-command.ts:30-38` (use `transport.encodeParentThreadId`)
- [ ] Fix `ipc/handler.ts:17-30` (accept and partition mixed-type ids; replace `/^-?\d+$/` regex with `transport.ownsChatId(req.session)` so Slack `Cxxx` / `Dxxx` sessions route correctly)
- [ ] Update `cron/scheduler.ts:44` and `cron/runner.ts` `notifyFn` signature to `(string \| number)[]`
- [ ] **Widen `TelegramAdapter.createThread.post`** (`src/transports/telegram/telegram-adapter.ts:196`) to match the new `ChatThread.post` shape: `string \| { markdown: string } \| { card: unknown; fallbackText?: string }`. Route `{ card }` through the SDK's `postMessage` (which already handles `PostableCard` via `extractCard`) rather than the existing direct `telegramFetch("sendMessage", …)` path. If migration would balloon Phase 1, gate `{ card }` to throw "telegram createThread.post does not yet accept card" so type checks pass and tests catch the gap; the Phase 2 "bonus refactor" then completes the migration. Pick the simpler of the two during implementation.
- [ ] Tighten `fireBootTurn` partition logic: for each transport that owns at least one chatId in `notifyChatIds`, fire one boot turn against the *first* chatId owned by that transport (not the global `chatIds[0]`). Document this as "primary chatId per transport."
- [ ] Create `src/transports/composite.ts`
- [ ] Create `src/transports/chat-adapters.ts` factory registry
- [ ] Update `Gateway` constructor + `buildChatAdapters`
- [ ] Update tests: `config.test.ts`, `gateway-helpers.test.ts`, `unit.test.ts`, `setup.test.ts`
- [ ] Add `composite-transport.test.ts` covering: routing by `ownsThread`, partitioned `notify`, dispose fan-out, `handlePairing` per-transport completion
- [ ] Smoke test: telegram still works end-to-end

### Phase 1 risks
- The signature changes ripple through tests and the gateway. **Mitigation:** do them in one commit so the type system catches every call site.
- `isAllowed` is in the auth hot path — one regression here breaks auth. **Mitigation:** add property-based tests with mixed-type allowlists. Specific case: telegram user id `12345` (number) + slack user id `"U02ABC"` (string) in the same `allowedUserIds`, both must match their respective platforms.
- Migration of old `telegram-pairing.json` files: those store `userId: number` and `chatId: number`. The widened union accepts those untouched — no migration needed at the file level. But the in-memory `allowedUserIds` array now mixes types; numeric comparisons must use a helper, not raw `===`.

---

## Phase 2 — Slack adapter

Single workspace, socket mode. Implements the same `TransportAdapter` contract as `TelegramAdapter`. Mirrors the telegram directory layout for parity and DRY.

### Files

```
src/transports/slack/
├── slack-adapter.ts       (~300 LoC) — TransportAdapter impl
├── format.ts              (~100 LoC) — markdown helpers, mention rewriting, mrkdwn fallback for menus
├── pairing.ts             (~140 LoC) — first-DM pairing state with assistant_thread_started fallback
├── notify.ts              (~80 LoC)  — chat.postMessage wrapper (matches SDK defaults)
├── progress.ts            (~100 LoC) — chat.postMessage + chat.update for editable progress
├── rich-ui.ts             (~80 LoC)  — RichMenu → Block Kit blocks
├── streaming.ts           (~150 LoC) — streaming with post-then-edit fallback (see 2.7)
└── manifest.yaml          (static)   — Slack app manifest for setup CLI to print
```

**Updated effort estimate:** ~950 LoC (was 700; the streaming fallback alone is ~150 LoC).

### 2.1 `slack-adapter.ts`

Three facts anchored to `@chat-adapter/slack@4.29.0` and `chat@4.29.0`:

**A. Slack thread ID is `slack:CHANNEL:THREAD_TS`.** Per `@chat-adapter/slack@4.29.0` `index.d.ts:866-892`:
```ts
encodeThreadId(platformData: { channel: string; threadTs: string }): string;
decodeThreadId(threadId: string): { channel: string; threadTs: string };
isDM(threadId: string): boolean;     // checks if channel starts with 'D'
channelIdFromThreadId(threadId: string): string;
```

We MUST use `adapter.encodeThreadId()` to construct synthetic threads. We also MUST use `adapter.channelIdFromThreadId(thread.id)` rather than parsing `thread.id.split(":")[1]` manually. This is the same pattern telegram uses (`thread.adapter.telegramFetch` is opaque-by-design).

**B. There is no `blocks` field on `AdapterPostableMessage`.** The shape per `chat@4.29.0` `chat-D9UYaaNO.d.ts:1549`:

```ts
type AdapterPostableMessage =
  | string
  | PostableRaw      // { raw: string, attachments?, files? }
  | PostableMarkdown // { markdown: string, attachments?, files? }
  | PostableAst      // { ast: Root, attachments?, files? }
  | PostableCard     // { card: CardElement, fallbackText?, files? }
  | CardElement;
```

**Use `{ card }` for menus.** The Slack adapter's `cardToBlockKit` (`index.d.ts:73`) converts a `CardElement` into Block Kit blocks internally; the Telegram adapter does the same conversion to inline keyboards via `extractCard`. **Do not write a custom Block Kit converter.**

**C. `bot.onAssistantThreadStarted(handler)` is a public method on `ChatInstance`** (`chat-D9UYaaNO.d.ts:2913`):

```ts
onAssistantThreadStarted(handler: AssistantThreadStartedHandler): void;
onAssistantContextChanged(handler: AssistantContextChangedHandler): void;
onAppHomeOpened(handler: AppHomeOpenedHandler): void;
onMemberJoinedChannel(handler: MemberJoinedChannelHandler): void;
```

The iter-2 reviewer flagged this as missing because they were looking at the Slack adapter's `protected handleAssistantThreadStarted` (which is internal). The public registration path lives on the core `Chat` class.

Sketch:

```ts
export class SlackAdapter implements TransportAdapter {
  readonly name = "slack";

  // Holds the @chat-adapter/slack instance after Chat SDK initialize().
  // Populated by an attach() method the gateway calls after chat.initialize().
  private slackSdk: import("@chat-adapter/slack").SlackAdapter | null = null;

  attach(slackSdk: import("@chat-adapter/slack").SlackAdapter): void {
    this.slackSdk = slackSdk;
  }

  enrichPrompt(thread: ChatThread, text: string): string {
    return `${text}\n\n${SLACK_FORMAT_HINT}`;
  }

  async postMessage(thread: ChatThread, text: string): Promise<void> {
    // Chat SDK adapter accepts { markdown } natively; emits Slack markdown_text.
    await thread.post({ markdown: text });
  }

  async postRich(thread: ChatThread, response: RichResponse): Promise<void> {
    if (!response.menu) {
      await this.safePostText(thread, response.text);
      return;
    }
    try {
      const body = response.menuCaption ?? response.text;
      // Build a transport-agnostic Card. The Slack adapter's cardToBlockKit
      // converts this to Block Kit; Telegram's extractCard does the same to
      // inline keyboards. We never touch Block Kit JSON ourselves.
      const card = richMenuToCard(response.menu, body);
      await thread.post({ card, fallbackText: stripMarkdownToPlain(body) });
    } catch (err) {
      console.warn("[roundhouse] slack postRich failed:", err);
      await this.safePostText(thread, response.text);
    }
  }

  progress(thread: ChatThread, initialText: string): Promise<ProgressMessage> {
    return createSlackProgress(this.requireSdk(), thread, initialText);
  }

  async stream(thread: ChatThread, iter: AsyncIterable<string>): Promise<void> {
    return handleSlackStream(this.requireSdk(), thread, iter);   // see 2.7
  }

  async registerCommands(): Promise<void> {
    // No-op — Slack slash commands live in the app manifest, not at runtime.
  }

  ownsThread(thread: ChatThread): boolean {
    return typeof thread?.id === "string" && thread.id.startsWith("slack:");
  }

  ownsChatId(id: string | number): boolean {
    return typeof id === "string" && /^[CDGU]/.test(id);
  }

  encodeParentThreadId(chatId: string | number): string {
    // Top-level posts: use "main" as a sentinel threadTs; postChannelMessage
    // is used at send time so the threadTs is irrelevant for outbound.
    return `slack:${chatId}:main`;
  }

  formatNotifySession(chatId: string | number): string {
    // Slack channel ids start with C (public), G (private), D (DM), U (user/IM).
    // Map to a consistent "main" / "channel:Cxxx" / "dm:Dxxx" label.
    const id = String(chatId);
    if (id.startsWith("D")) return "main";
    if (id.startsWith("C") || id.startsWith("G")) return `channel:${id}`;
    return "main";
  }

  createThread(chatId: string | number): ChatThread {
    // Synthetic thread for boot/cron/sub-agent paths.
    // We use postChannelMessage at send-time (no thread_ts), so the
    // synthetic thread carries an empty-string threadTs sentinel.
    const sdk = this.requireSdk();
    const channelId = String(chatId);
    const threadId = sdk.encodeThreadId({ channel: channelId, threadTs: "" });
    return {
      id: threadId,
      // Expose the SDK adapter under a slack-specific key for postRich /
      // progress / stream to narrow on (mirrors telegram's `adapter.telegramFetch`).
      adapter: { slack: sdk },
      // Signature matches the widened ChatThread.post (see §1.1.5):
      // string | { markdown } | { card, fallbackText? }. No blocks/text shapes
      // — those are not in AdapterPostableMessage and would be silently
      // dropped or rejected by the adapter.
      post: async (content: string | { markdown: string } | { card: unknown; fallbackText?: string }) => {
        // postChannelMessage = top-level post (no thread_ts). For replying
        // inside a Slack thread we'd use postMessage with a real threadId.
        await sdk.postChannelMessage(channelId, content as AdapterPostableMessage);
      },
      startTyping: async () => {
        // Generic "Typing..." indicator — no scope requirement.
        try { await sdk.startTyping(threadId); } catch {}
      },
    };
  }

  async notify(chatIds: (string | number)[], text: string): Promise<void> {
    const slackIds = chatIds.filter(id => this.ownsChatId(id));
    if (slackIds.length === 0) return;
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) {
      console.warn("[roundhouse] SLACK_BOT_TOKEN not set — skipping slack notification");
      return;
    }
    for (const id of slackIds) {
      await postSlackMessage(token, String(id), text);
    }
  }

  async isPairingPending(): Promise<boolean> { /* read slack-pairing.json */ }
  async handlePairing(thread, message) { /* see 2.4 */ }
  shouldIgnoreMessage() { return false; }   // no /start equivalent

  private requireSdk() {
    if (!this.slackSdk) throw new Error("SlackAdapter not attached to Chat SDK yet");
    return this.slackSdk;
  }

  private async safePostText(thread: ChatThread, text: string): Promise<void> {
    try { await this.postMessage(thread, text); return; } catch {}
    try { await thread.post(text); } catch (err) {
      console.error("[roundhouse] slack safePostText: all paths failed:", err);
    }
  }
}
```

Note: `attach(slackSdk)` is called by the gateway after `chat.initialize()` — Chat SDK exposes adapter instances via `bot.getAdapter("slack")`. The gateway runs once: `if (this.transport instanceof CompositeTransportAdapter) compositeAttachSlack(this.transport, this.chat.getAdapter("slack"))`.

### 2.2 Format strategy

**Outgoing plain messages (no menu):** `{ markdown: text }` — Chat SDK adapter renders to Slack `markdown_text` natively. **No converter needed.**

**Outgoing menus:** `{ card }` — the Slack adapter renders to Block Kit internally. Card prose is markdown via `Text({ style: "muted"|"bold"|"plain" })` and `Section` elements. Adapter handles platform-specific escaping. No mrkdwn converter on our side.

**Outgoing length limit:**
- Plain `postMessage`: `markdown_text` is capped at 12,000 chars. Chunk at 12,000 with newline-preferred split (mirror `splitMessage` in `src/util.ts`).
- Cards: Slack's section block is 3,000 chars per block; the adapter chunks long text into multiple sections. Verify with a test that posts a 50,000-char body inside a card.
- Menus: `actions` block holds at most 5 elements; the adapter chunks buttons across multiple actions blocks. Verify the SDK actually does this (one quick spike); if not, our `richMenuToCard` chunks button groups itself.

**Incoming:** Chat SDK adapter parses Slack mrkdwn into AST. We don't see raw mrkdwn.

**`format.ts` content** (~40 LoC, much smaller than v2 estimated):
- `richMenuToCard(menu, prose): CardElement` — see §2.3.
- `stripMarkdownToPlain(md): string` — used as `fallbackText` for `PostableCard` (one-line summary for clients that can't render cards). Reuse `markdownToPlainText` from `chat@4.29.0` (`chat-D9UYaaNO.d.ts:714` exports it).

### 2.3 Map `RichMenu` to the SDK's transport-agnostic `Card` model (`rich-ui.ts`)

This subsection in v2 was a Slack-specific Block Kit converter. v3 deletes it: the Chat SDK already provides a transport-agnostic Card model that both the Slack and Telegram adapters convert internally.

`CardElement` shape, anchored to `chat@4.29.0` `jsx-runtime-CFq1K_Ve.d.ts:150-243`:

```ts
interface CardElement {
  type: "card";
  title?: string;
  subtitle?: string;
  imageUrl?: string;
  children: CardChild[];   // TextElement | ActionsElement | SectionElement | ...
}

interface ButtonElement {
  type: "button";
  id: string;              // ← maps to action_id (Slack) / callback_data (Telegram)
  label: string;
  value?: string;          // payload sent to onAction handler
  style?: ButtonStyle;
  actionType?: "action" | "modal";
  callbackUrl?: string;
  disabled?: boolean;
}

interface ActionsElement {
  type: "actions";
  children: (ButtonElement | LinkButtonElement | SelectElement | RadioSelectElement)[];
}
```

The mapping is then trivial:

```ts
// src/transports/rich-helpers.ts (NEW or extend existing)
import { Card, Section, Text, Actions, Button } from "chat";
import type { CardElement } from "chat";
import type { RichMenu, RichButton } from "./types";

export function richMenuToCard(menu: RichMenu, headerProse?: string): CardElement {
  const children: CardChild[] = [];
  if (headerProse) {
    children.push(Section([Text(headerProse)]));   // adapter renders markdown
  }
  for (const section of menu.sections) {
    const sectionChildren: CardChild[] = [];
    if (section.title) sectionChildren.push(Text(section.title, { style: "bold" }));
    sectionChildren.push(Actions(section.buttons.map(richButtonToButton)));
    children.push(Section(sectionChildren));
  }
  return Card({ children });
}

function richButtonToButton(btn: RichButton): ButtonElement {
  return Button({
    id: btn.actionId,       // ← Slack maps to action_id; Telegram maps to callback_data
    label: btn.label,
    value: btn.value,
    ...(btn.selected ? { style: "primary" } : {}),
  });
}
```

This single helper now serves **both** transports. Telegram's existing `rich-ui.ts:toTelegramInlineKeyboard` (currently called from `telegram-adapter.ts:postRich`) becomes redundant — instead, telegram's `postRich` also goes through `thread.post({ card })` and the `@chat-adapter/telegram` adapter's `extractCard` does the conversion. **This unifies the menu-rendering path across transports.**

> **Bonus refactor opportunity for Phase 1:** convert `TelegramAdapter.postRich` to use `{ card }` first, then extend the same path to Slack in Phase 2. Defer to Phase 1 only if it stays a contained 1-day diff; otherwise leave telegram on its current `toTelegramInlineKeyboard` path and let Slack be the first user of the unified card path. Either way, Slack uses `{ card }` from day one.

Slack `block_actions` events arrive via the WebSocket; the Chat SDK fires them as `chat.onAction(actionId, handler)` events — same API the telegram inline keyboard already uses (`gateway.ts:311`). **Zero changes to the action-dispatch layer in the gateway.** Verified: `@chat-adapter/slack@4.29.0` `index.d.ts:625` `dispatchInteractivePayload` is the SDK plumbing that emits these.

**Action-id collision question (raised in iter-2 review):** when both Telegram and Slack run in the same gateway, are `chat.onAction("model")` callbacks fired correctly? The action handler receives `event.thread` (a `Thread<TRaw>` instance). The thread's `id` carries the platform prefix (`telegram:…` / `slack:…`) so the handler can route by `transport.ownsThread(event.thread)` if it ever needs to differentiate. Today's handlers don't need to — they only call `transport.postRich(event.thread, …)`, which composite already routes correctly. **Add a test** in `composite-transport.test.ts` that registers an `onAction("test")` handler, fires it from both a fake-telegram thread and a fake-slack thread, and verifies the handler sees the correct `event.thread.id` in each case.

### 2.4 Pairing (`pairing.ts`)

The "first DM from allowed user" model has a chicken-and-egg gap: Slack `message.im` events only fire for *existing* DM channels. Until the user opens a DM with the bot, we can never see a message.

**Three-pronged approach:**

1. **Setup output makes it explicit.** The CLI prints:
   > To complete pairing, open a new DM with @BOT_NAME in your Slack workspace. (Click the bot name in your sidebar, or search for the bot, then send any message.) The first message from `@your-username` completes pairing.

2. **Listen to `assistant_thread_started`** — fires when a user opens an Assistant thread DM with the bot (`@chat-adapter/slack@4.29.0` `index.d.ts:288-303` for the event shape; `chat@4.29.0` `chat-D9UYaaNO.d.ts:2913` for the public `bot.onAssistantThreadStarted(handler)` registration). For workspaces with the Assistants API enabled (which we enable in the manifest), this fires *before* the user types anything. We capture `user_id` and `channel_id` from the event payload and complete pairing immediately. Requires in the manifest:
   - `oauth_config.scopes.bot += assistant:write`
   - `event_subscriptions.bot_events += assistant_thread_started`
   - `features.assistant_view` block (NOT a top-level `apps.assistant.enabled` flag — see §3 manifest; the iter-2 reviewer flagged this).
   - In the gateway: register `bot.onAssistantThreadStarted(async (event) => transport.handleAssistantThreadStarted(event))` after `chat.initialize()`. The composite routes the call to the Slack delegate (Telegram doesn't implement it).

3. **Fallback: first message in the DM channel.** If the user posts before opening the assistant thread (or if assistant API isn't enabled in the workspace), `message.im` still works.

The pairing module covers both:

```ts
interface PendingSlackPairing {
  version: 1;
  workspaceTeamId?: string;
  botUserId?: string;
  allowedUsers: string[];      // Slack usernames (display names normalized)
  createdAt: string;
  status: "pending" | "paired";
  pairedAt?: string;
  channelId?: string;          // Dxxx DM channel
  userId?: string;             // Uxxx user
  username?: string;
}

const PAIRING_PATH = resolve(ROUNDHOUSE_DIR, "slack-pairing.json");
```

`handlePairing` in the adapter is called for both `message.im` and `assistant_thread_started`-derived events. The gateway converts the latter into an `IncomingMessage`-shaped envelope before calling `handlePairing`. The conversion is non-trivial because `AssistantThreadStartedEvent` carries `userId`, `channelId`, `threadTs`, `context.teamId` (`chat-D9UYaaNO.d.ts:2120`) but **not `text`** and **not a populated `author.userName`** — so we must look the user up explicitly:

```ts
// In gateway start, after attaching adapter
bot.onAssistantThreadStarted(async (event) => {
  const slackSdk = bot.getAdapter("slack");
  // Slack adapter exposes lookupUser via getUser() — verified at slack
  // index.d.ts:612 (getUser(userId): Promise<UserInfo | null>).
  const userInfo = await slackSdk.getUser(event.userId).catch(() => null);
  const synthetic: IncomingMessage = {
    text: "",
    author: {
      userId: event.userId,
      userName: userInfo?.userName,    // populated for allowlist match
      name: userInfo?.displayName,
    },
    chatId: event.channelId,
    raw: event,
  };
  // Run through the same composite.handlePairing path as message.im
  await this.handlePendingPairing(synthetic, this.transport.createThread("slack", event.channelId));
});
```

On match (either path):
1. Verify `message.author.userName` is in `allowedUsers` (case-insensitive, strip leading `@`). If `userName` is not yet populated (assistant_thread_started before user lookup completes — handled by the `await` above), allowlist match falls back to `userId` if any user in `allowedUsers` is a `Uxxx` literal.
2. Capture `channelId` and `userId`.
3. Persist `slack-pairing.json` with `status: "paired"` (include `username` if resolved).
4. Return `{ threadId: channelId, userId, username, transport: "slack" }`.

The gateway's `handlePendingPairing` (gateway.ts:102) widens to handle string IDs (Phase 1.6 already covered this).

### 2.5 Notify and channel-post (`notify.ts`)

Mirror telegram's `notify.ts`. The reviewer flagged that we should match the SDK's defaults so notify and gateway-emitted messages render consistently:

```ts
export async function postSlackMessage(
  token: string,
  channelId: string,
  text: string,
  options?: { unfurlLinks?: boolean; mrkdwn?: boolean },
): Promise<boolean> {
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        channel: channelId,
        markdown_text: text,
        unfurl_links: options?.unfurlLinks ?? false,    // match SDK default (no unfurl in chat ops)
        mrkdwn: options?.mrkdwn ?? true,                // match SDK default
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.warn(`[slack] postMessage to ${channelId} failed (${res.status}): ${errBody.slice(0, 200)}`);
    }
    return res.ok;
  } catch (err) {
    console.warn(`[slack] postMessage to ${channelId} failed:`, (err as Error).message);
    return false;
  }
}

export async function postSlackToMany(
  chatIds: (string | number)[],
  text: string,
): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return;
  const slackIds = chatIds.filter(id => typeof id === "string" && /^[CDGU]/.test(id));
  for (const id of slackIds) await postSlackMessage(token, String(id), text);
}
```

### 2.6 Progress messages (`progress.ts`)

Slack's `chat.update` supports in-place edits. Mirror telegram's `createProgressMessage`:

```ts
export async function createSlackProgress(
  sdk: SlackAdapter,
  thread: ChatThread,
  initialText: string,
): Promise<ProgressMessage> {
  const { channel, threadTs } = sdk.decodeThreadId(thread.id);
  const initial = await sdk.webClient.chat.postMessage({
    channel,
    markdown_text: initialText,
    ...(threadTs && threadTs !== "main" && threadTs !== "" ? { thread_ts: threadTs } : {}),
  });
  const ts = initial.ts as string;

  return {
    update: async (text: string) => {
      try {
        await sdk.webClient.chat.update({
          channel,
          ts,
          markdown_text: text,
        });
      } catch {
        // ProgressMessage contract: never throw. Telegram's progress.ts
        // does the same swallow.
      }
    },
  };
}
```

### 2.7 Streaming integration

**Reviewer caught a v1 mistake:** the SDK's native `stream(threadId, textStream, options)` (`index.d.ts:837`) requires `recipientUserId` and `recipientTeamId` in options, AND requires the Slack AI Assistant feature enabled in the manifest. We can't rely on this for v1.

**Realistic plan: post-then-edit fallback first; native streaming second.**

The iter-2 review flagged three holes in v2's sketch: (a) `handleOverflow` doesn't honor edit throttling so back-to-back overflows can hit Slack rate limits; (b) no abort signal handling; (c) failed initial post leaves `messageTs=null` forever and every subsequent chunk re-attempts `sendInitial`. v3 closes all three:

```ts
// src/transports/slack/streaming.ts

const STREAM_EDIT_INTERVAL_MS = 800;     // Slack rate limit ~1 edit/sec; 800ms is safe
const SLACK_TEXT_LIMIT = 12_000;         // markdown_text limit
const SLACK_MIN_PUBLIC_LIMIT = 4000;     // chunk threshold to ensure clean breaks
const INIT_FAIL_BACKOFF_MS = 1500;       // pause before retrying initial send
const MAX_INIT_RETRIES = 3;

export async function handleSlackStream(
  sdk: SlackAdapter,
  thread: ChatThread,
  stream: AsyncIterable<string>,
  signal?: AbortSignal,
): Promise<void> {
  const { channel, threadTs } = sdk.decodeThreadId(thread.id);
  const replyOpts = (threadTs && threadTs !== "main" && threadTs !== "")
    ? { thread_ts: threadTs }
    : {};

  let accumulated = "";
  let messageTs: string | null = null;
  let lastEditAt = 0;
  let lastSentText = "";
  let committedLength = 0;
  let initFailures = 0;
  let lastInitAttemptAt = 0;

  const sleepRemaining = async () => {
    const wait = STREAM_EDIT_INTERVAL_MS - (Date.now() - lastEditAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  };

  const sendInitial = async (body: string) => {
    if (initFailures >= MAX_INIT_RETRIES) return;   // give up; let final flush try
    if (Date.now() - lastInitAttemptAt < INIT_FAIL_BACKOFF_MS) return;  // backoff
    lastInitAttemptAt = Date.now();
    try {
      const result = await sdk.webClient.chat.postMessage({
        channel,
        markdown_text: body,
        ...replyOpts,
      });
      messageTs = result.ts as string;
      lastSentText = body;
      lastEditAt = Date.now();
      initFailures = 0;
    } catch (err) {
      initFailures++;
      console.warn(`[slack/stream] initial post failed (${initFailures}/${MAX_INIT_RETRIES}):`, err);
    }
  };

  const editMessage = async (body: string) => {
    if (!messageTs || body === lastSentText) return;
    try {
      await sdk.webClient.chat.update({ channel, ts: messageTs, markdown_text: body });
      lastSentText = body;
      lastEditAt = Date.now();
    } catch {
      // Slack rejects empty/invalid edits silently — keep streaming.
    }
  };

  const handleOverflow = async () => {
    const current = accumulated.slice(committedLength);
    if (current.length <= SLACK_TEXT_LIMIT) return;

    // Finalize current message at a clean boundary (newline if possible).
    // Throttle BEFORE the edit so back-to-back overflows don't hit rate limits.
    await sleepRemaining();
    const cutAt = Math.max(
      current.lastIndexOf("\n", SLACK_TEXT_LIMIT - 100),
      SLACK_MIN_PUBLIC_LIMIT,
    );
    const final = current.slice(0, cutAt);
    await editMessage(final);
    committedLength += cutAt;
    messageTs = null;
    lastSentText = "";
  };

  for await (const chunk of stream) {
    if (signal?.aborted) break;
    accumulated += chunk;

    if (!messageTs) {
      const body = accumulated.slice(committedLength);
      if (body.trim()) await sendInitial(body);
      // If sendInitial failed but we haven't exhausted retries, keep
      // accumulating; next chunk's iteration will retry after backoff.
      continue;
    }

    await handleOverflow();
    if (signal?.aborted) break;
    if (Date.now() - lastEditAt >= STREAM_EDIT_INTERVAL_MS) {
      await editMessage(accumulated.slice(committedLength));
    }
  }

  // Final flush — runs even if signal aborted, so the user sees the last
  // partial buffer rather than silent truncation.
  const remaining = accumulated.slice(committedLength);
  if (!remaining.trim()) return;

  if (messageTs) {
    await editMessage(remaining);
  } else if (initFailures < MAX_INIT_RETRIES) {
    // We never got an initial message id — try one final post unconditionally
    // (no backoff gate) so the user isn't left with nothing.
    try {
      await sdk.webClient.chat.postMessage({
        channel,
        markdown_text: remaining,
        ...replyOpts,
      });
    } catch (err) {
      console.error("[slack/stream] final post failed:", err);
    }
  }
}
```

Three changes vs v2:
1. **Throttled overflow:** `await sleepRemaining()` before the overflow edit so a burst of large chunks can't fire two edits in 800ms.
2. **Abort handling:** check `signal?.aborted` at chunk boundaries and after overflow handling. The gateway already wires `AbortController` for `/cancel` (`gateway.ts:476-484`); pass it through.
3. **Initial-post failure recovery:** `initFailures` counter with `INIT_FAIL_BACKOFF_MS` between attempts; cap at `MAX_INIT_RETRIES`. After the limit, stop retrying inside the loop but keep buffering. The final flush gets one more attempt as a last resort.

The `gateway/streaming.ts:13,134-148` block currently does:
```ts
const useTelegramHtml = isTelegramThread(thread);
// ... if (useTelegramHtml) handleTelegramHtmlStream(thread, ts.iterable)
```

Refactor to a `transport.stream(thread, iter, signal)` dispatch instead:
```ts
// streaming.ts (post-refactor)
const streamPromise = transport.stream
  ? transport.stream(thread, ts.iterable, signal).catch((err: Error) => { /* … */ })
  : fallbackChunkedPost(thread, ts.iterable);
```

`TransportAdapter` gets `stream(thread, iter, signal?): Promise<void>` as a required method. Telegram impl wraps `handleTelegramHtmlStream` (existing helper, will need a small abort-signal threading change too); Slack impl wraps `handleSlackStream`.

The `signal` is already available in the gateway: `Gateway.handleAgentTurn` creates one per turn at `gateway.ts:476-484` and passes it to `handleStreaming`. Plumb it through `transport.stream`.

**Native streaming (deferred to v2):** `assistant.threads.streaming` requires AI Assistant features. Add a v2 task to detect when the workspace has them enabled and switch to native, but ship v1 with post-then-edit which works on every Slack workspace.

### 2.8 Files in attachments

Slack files require auth on download (`url_private` + bot token in `Authorization`). The Chat SDK's `Attachment.fetchData()` handles this (`index.d.ts:771` `rehydrateAttachment`). `src/gateway/attachments.ts` already calls `attachment.fetchData()` if available — **add a test that exercises this with a mock Slack attachment**, don't refactor blindly.

### Phase 2 checklist
- [ ] Add `@chat-adapter/slack@^4.29.0` to `package.json`
- [ ] Create `src/transports/slack/` directory with files listed above
- [ ] Implement `SlackAdapter` class with `attach(slackSdk)` integration
- [ ] Implement `richMenuToCard` in `rich-helpers.ts` (transport-agnostic; uses Chat SDK Card model — no per-platform Block Kit converter)
- [ ] Implement `stripMarkdownToPlain` (or reuse `markdownToPlainText` from `chat`) for card `fallbackText`
- [ ] Implement `createSlackProgress` (`progress.ts`)
- [ ] Implement `handleSlackStream` post-then-edit (`streaming.ts`)
- [ ] Implement Slack pairing with both `message.im` and `assistant_thread_started` paths
- [ ] Add `stream()` to `TransportAdapter` interface + telegram + slack impls
- [ ] Refactor `gateway/streaming.ts` to call `transport.stream()`
- [ ] Register `bot.onAssistantThreadStarted` in gateway and route to pairing
- [ ] Register `slack` in `chatAdapterFactories`
- [ ] Wire `SlackAdapter.attach()` after `chat.initialize()` in gateway start
- [ ] Add Slack manifest YAML
- [ ] Eagerly call Slack `auth.test` on gateway start so `botUserId` is populated before subscriptions activate (mitigates self-loop window)
- [ ] Verify attachments work end-to-end (test a real upload)

### Phase 2 risks
1. **Bot self-loop.** Slack delivers bot messages back through `message.channels` / `message.groups`. SDK central isMe filter relies on `botUserId` being populated, fetched lazily. **Mitigation:** call `slackSdk.webClient.auth.test()` in `gateway.start()` before any subscriptions, and store the result so the filter is always armed before the first event.
2. **AdapterPostableMessage shape** — v3 uses `{ card }` (real shape per `chat@4.29.0` `chat-D9UYaaNO.d.ts:1549`). The v2 `{ blocks, text }` shape was wrong and is not used in v3.
3. **Streaming + cards can't coexist.** Stream API doesn't take cards/blocks. Decision: streaming turns are agent text only; menu turns are command results that don't stream. Document this constraint in CLAUDE.md. If a future feature needs both, finalize the stream then post a separate menu message — that's fine because menus are typically command responses, not mid-conversation.
4. **DM channel discovery.** Pairing assumes the user opened a DM first. The setup CLI tells them to. Assistant-thread fallback covers most cases. **Mitigation:** add a CLI doctor command `roundhouse doctor --slack` that shows current pairing status and a deep link to open the DM.
5. **Chat SDK 4.29 breaking changes.** Re-verify after Phase 0: `Adapter<TThreadIdData, TRaw>` generic shape, `webClient` getter behavior in single-workspace mode. The Slack adapter d.ts at `index.d.ts:533` says `webClient` throws `AuthenticationError` outside any context in multi-workspace mode — ours is single-workspace, so the static `botToken` path applies and `webClient` works without a context.
6. **Slack manifest schema evolves.** The plan's manifest uses `features.assistant_view`, which is the current field for enabling Assistants API features. Verify against `https://api.slack.com/reference/manifests` before shipping; the v2 plan incorrectly listed a non-existent `apps.assistant.enabled: true` flag.

---

## Phase 3 — `roundhouse setup --slack` CLI

Mirror `setup --telegram` flow. Files:

```
src/cli/setup/slack.ts          — Slack-specific helpers (token validation, redaction)
src/cli/setup/flows.ts          — add runInteractiveSlackSetup, runNonInteractiveSlackSetup
src/cli/setup/args.ts           — accept --slack flag and --slack-bot-token / --slack-app-token
src/cli/setup/steps.ts          — reusable steps already platform-agnostic (no change needed)
src/cli/setup/types.ts          — extend SetupOptions for slack tokens
```

### Flow (interactive)

```
roundhouse setup --slack

① Preflight (shared) — node version, disk, agent install detection
② Print Slack app setup guide:
     1. Go to api.slack.com/apps → "From an app manifest"
     2. Paste the manifest (printed inline; also written to /tmp/roundhouse-slack-manifest.yaml)
     3. Install to your workspace
     4. Enable Socket Mode and generate App-Level Token (xapp-…)
     5. Copy Bot User OAuth Token (xoxb-…) from OAuth & Permissions
③ Masked prompt for SLACK_BOT_TOKEN (xoxb-…); regex-validate prefix before proceeding
④ Masked prompt for SLACK_APP_TOKEN (xapp-…); regex-validate prefix
⑤ Validate tokens via auth.test → returns bot user id, team name, team id
⑥ Prompt for Slack username (the user — for allowlist)
⑦ Install packages (shared with telegram path)
⑧ Write ~/.roundhouse/.env: SLACK_BOT_TOKEN, SLACK_APP_TOKEN
⑨ Write config.chat.adapters.slack = { mode: "socket" }
⑩ Write pending-pairing file with allowedUsers
⑪ Install + start systemd / launchd service (shared)
⑫ Print explicit pairing instructions:
     "To complete pairing, open a new DM with @<bot> in your Slack workspace
      (click bot in sidebar or search), then send ANY message.
      Pairing completes when the first message from @<your-username> arrives.
      slack://app?team=<teamId>&id=<botUserId> opens the bot directly."
```

### Flow (non-interactive)

```
roundhouse setup --slack \
  --slack-bot-token "$SLACK_BOT_TOKEN" \
  --slack-app-token "$SLACK_APP_TOKEN" \
  --user my-slack-username \
  --non-interactive
```

Same as telegram — JSON logger, exit codes, diagnostics on failure.

### Manifest (Phase 3 — corrected from v1)

`src/transports/slack/manifest.yaml` literal. Trimmed scopes (dropped `users:read.email`; the reviewer flagged it as a privacy red flag and unnecessary):

```yaml
display_information:
  name: Roundhouse
  description: Roundhouse chat-gateway bot

features:
  bot_user:
    display_name: Roundhouse
    always_online: true
  assistant_view:
    assistant_description: Roundhouse AI agent
    suggested_prompts: []

oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - assistant:write          # for assistant_thread_started + setStatus
      - channels:history
      - chat:write
      - groups:history
      - im:history
      - im:read
      - im:write
      - users:read               # for username matching during pairing
      # users:read.email INTENTIONALLY OMITTED — not needed for matching

settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.im
      - message.channels
      - message.groups
      - assistant_thread_started     # for first-DM pairing fallback
      - assistant_thread_context_changed
  interactivity:
    is_enabled: true
  socket_mode_enabled: true
```

### `slack.ts` helpers

```ts
export interface SlackBotInfo {
  botUserId: string;          // Uxxx — the bot's own user id (for self-loop filter)
  botName: string;            // bot display name
  teamId: string;             // Txxx
  teamName: string;
}

export async function validateSlackTokens(botToken: string, appToken: string): Promise<SlackBotInfo> {
  // 1. Validate bot token via auth.test (HTTP POST with Bearer botToken)
  // 2. Validate app token shape (xapp-prefix); we can't auth.test it but
  //    a malformed xapp- token will fail at socket connect time.
  // Throws on invalid; redacts token in error messages.
}

export function redactSlackToken(token: string): string {
  // xoxb-XXX...XXX (preserve prefix so user can tell which token is bad)
  if (token.length < 12) return "***";
  return token.slice(0, 8) + "..." + token.slice(-4);
}
```

### Phase 3 checklist
- [ ] `runInteractiveSlackSetup` in `flows.ts`
- [ ] `runNonInteractiveSlackSetup` in `flows.ts`
- [ ] `slack.ts` helpers (token validation, redaction)
- [ ] Regex prefix-check for `xoxb-` and `xapp-` at prompt time
- [ ] `--slack`, `--slack-bot-token`, `--slack-app-token` args
- [ ] Slack manifest YAML in `src/transports/slack/manifest.yaml`
- [ ] Pairing file write (mirror telegram)
- [ ] Update `setup/index.ts` exports
- [ ] Print "open new DM with bot" instructions explicitly (not just "DM @bot")
- [ ] Smoke test the full flow against a real Slack workspace
- [ ] Add `roundhouse doctor --slack` to surface pairing status (sees pending file, tells user where to click)

### Phase 3 risks
- Slack tokens come in two flavors (xoxb, xapp). Easy to mix up. **Mitigation:** regex-validate the prefix at prompt-time, before calling `auth.test`.
- Setup must not log tokens. **Mitigation:** redaction helper + no `console.log(opts)` anywhere.
- Manifest schema may evolve. **Mitigation:** the YAML is a starting point; reference the SDK's published example (Phase 0 verification step) when shipping.

---

## Phase 4 — Tests

### New test files

| File | What it covers |
|---|---|
| `test/slack-format.test.ts` | `markdownToSlackMrkdwn` round-trips, escape rules, `<@U>` / `<url\|text>` preservation, length truncation |
| `test/slack-postrich.test.ts` | Block Kit shape for menus, action_id mapping, prose-as-section-block (NOT markdown_text+blocks) |
| `test/slack-pairing.test.ts` | First-DM pairing, `assistant_thread_started` pairing, allowlist matching |
| `test/composite-transport.test.ts` | Routing by `ownsThread`, partitioned `notify`, `dispose` fan-out, per-transport `pairingComplete` Map race (telegram-paired-then-slack and the reverse), `enrichPrompt(thread, text)` routing for synthetic threads, `chat.onAction` callback routing across both transports |
| `test/ipc-handler-partition.test.ts` | `req.session = "Cxxx"` triggers Slack-only target; `req.session = "12345"` triggers telegram-only; missing transport returns useful error |
| `test/cron-notify-partition.test.ts` | `notifyFn` receives mixed `(string \| number)[]` and partitions correctly by `ownsChatId` |
| `test/setup-slack.test.ts` | Token validation, env file, manifest write, prefix regex |
| `test/slack-adapter.test.ts` | Smoke: postMessage, postRich, createThread, notify, ownsChatId, encodeParentThreadId, formatNotifySession |
| `test/slack-streaming.test.ts` | Post-then-edit fallback: edit interval throttling, overflow chunking, final flush |
| `test/slack-attachment.test.ts` | Mock `Attachment.fetchData()` round-trip |

### Updated test files

- `test/config.test.ts` — string + number IDs in `allowedUserIds`
- `test/gateway-helpers.test.ts` — composite transport in helpers
- `test/setup.test.ts` — `--slack` arg parsing
- `test/adapter-interface.test.ts` — `ownsChatId`, `stream`, `encodeParentThreadId`, `formatNotifySession` methods on the contract
- `test/telegram-format.test.ts` — verify `enrichPrompt(thread, text)` signature change didn't break cases
- `test/typing.test.ts` — Slack typing indicator path
- `test/old-bugs.test.ts` — add cases for new bugs we'll catch (notify partitioning by `ownsChatId`)

### `@chat-adapter/tests@4.29.0` integration

The reviewer flagged that this package may not exist. Verify before adopting:
```bash
npm view @chat-adapter/tests version
```
If it exists, use `createMockAdapter`, `toHavePosted`, `toHaveDispatched` for the new Slack tests. If not, hand-roll mocks (matches the existing telegram test style — see `test/telegram-postrich.test.ts`). Don't block Phase 4 on availability.

### Phase 4 checklist
- [ ] Verify `@chat-adapter/tests@^4.29.0` exists; add to devDeps if so
- [ ] If using SDK helpers: wire vitest setup file
- [ ] If hand-rolling: copy mock-thread pattern from `test/telegram-postrich.test.ts`
- [ ] Write new test files listed above
- [ ] Update existing test files
- [ ] Confirm `npm test` is green
- [ ] Add a "two transports, one gateway" integration test that exercises both telegram and slack notify in the same run

---

## Phase 5 — Documentation

### Updated files
- `README.md` — Slack section: setup, manifest, supported features, limitations
- `architecture.md` — section on `CompositeTransportAdapter` + transport routing; updated diagram
- `CLAUDE.md` — Slack adapter nuances (mirror the telegram nuance section's depth)
- `CHANGELOG.md` — entries for each phase release

### CLAUDE.md additions
- **"Bot self-loop filtering"** — explain how Chat SDK central filtering keeps bot messages from echoing, and that we eagerly populate `botUserId` via `auth.test` at startup to close the lazy-fetch race window
- **"Streaming + Block Kit can't coexist"** — document the constraint and the menus-don't-stream rule
- **"Slack thread-id encoding"** — `slack:CHANNEL:THREAD_TS` format; always use `adapter.encodeThreadId()` / `decodeThreadId()`, never split manually
- **"`markdown_text` is mutually exclusive with `text` and `blocks`"** — section blocks for menu prose, not markdown_text
- **"Multi-transport composition"** — how `CompositeTransportAdapter` routes calls; per-transport `pairingComplete` map
- **"Per-transport boot turn"** — `fireBootTurn` partitions chatIds by `ownsChatId` and runs once per transport
- **"Slack pairing chicken-and-egg"** — first DM doesn't exist yet; `assistant_thread_started` is the primary capture; fallback `message.im` for non-assistant workspaces

---

## Out of scope (explicit non-goals for v1)

- Multi-workspace OAuth (single workspace only)
- Webhook mode (socket mode only — no public URL needed)
- Slack Connect / external shared channels
- Token rotation / encryption at rest
- Slash commands as Slack-native commands (users type `/new` as text; gateway parses it the same way today)
- Modals (Block Kit views)
- Reactions, pins, scheduled messages (those are openclaw-style "tools", not chat-gateway features)
- Threading inside a Slack channel — **clarification:** v1 always replies at channel/DM root (uses `postChannelMessage` for top-level posts; never sets `thread_ts`). The SDK's thread-id format still includes `threadTs`, but we use a `"main"` sentinel and ignore inbound `thread_ts` for routing.
- Enterprise Grid org-wide installs
- App Home tab
- Native streaming via Slack's `assistant.threads.streaming` API (post-then-edit fallback ships in v1; native streaming is a v2 enhancement once we know the workspace has AI Assistant features)
- `@username` mention rewriting in outgoing menu prose (v2; needs user lookup)

---

## Effort estimate (revised after iter-2 review and SDK type verification)

| Phase | Files touched | New code | Risk |
|---|---|---|---|
| 0 — chat SDK bump | 2 | ~10 LoC | low |
| 1 — refactor | ~16 | ~450 LoC (sweep is comprehensive: includes IPC, cron, ChatThread.post widening) | medium |
| 2 — slack adapter | 8 new + 6 modified | ~800 LoC (was 950; v3 deletes the Block Kit converter — `richMenuToCard` is ~30 LoC, not 80; the SDK does the rest) | medium |
| 3 — setup CLI | 2 new + 4 modified | ~350 LoC | low |
| 4 — tests | 10 new + 7 modified | ~800 LoC | low |
| 5 — docs | 4 modified | ~200 LoC | trivial |

**Total:** ~2,600 LoC across 5 PRs. Phase 2 dropped ~150 LoC vs v2 by adopting the Chat SDK Card model; that LoC was added back in Phase 4 for additional tests (composite race, IPC partition, cron partition, action-id routing).

---

## Open questions resolved during review

1. ~~Bot self-loop filtering~~ → **eager `auth.test` at gateway start** populates `botUserId` before subscriptions activate (Phase 2 risk #1).
2. ~~Slack typing indicators~~ → **generic `startTyping(threadId)` for v1**, no `assistant:write` scope needed for the basic indicator (per `index.d.ts:823`). `setAssistantStatus` with custom text is a v2 enhancement.
3. ~~Mention triggering~~ → **DM-only for v1.** Channel mentions deferred. `app_mention` event is in the manifest in case we want it later, but the gateway only acts on `onDirectMessage` and `onAssistantThreadStarted` paths.
4. ~~Channel join behavior~~ → DM-only sidesteps it. If the bot is added to a channel, all `message.channels` events are filtered out by the gateway's `ownsThread` + DM-only routing.

---

## Migration / rollback

- Phase 0 (SDK bump): rollback = `git revert`, `npm install`. Lockfile-only change.
- Phase 1 (refactor): existing telegram users keep working. Config files: numeric `allowedUserIds`/`notifyChatIds` remain valid (union widening). Old `telegram-pairing.json` files unchanged.
- Phase 2 (Slack adapter): purely additive. Telegram users aren't affected unless `chat.adapters.slack` is configured.
- Phase 3+ (setup, tests, docs): additive.

No data migration. Pairing files are platform-specific (`telegram-pairing.json` vs `slack-pairing.json`) so coexist by name.

---

## Verified-against-source claims

The following claims are anchored to the version-pinned `.d.ts` files. Re-verify the SAME versions before implementation; the [chat-sdk-types-may-drift-between-versions](#) memory notes that types can shift between versions even within a minor.

| Claim | Source |
|---|---|
| Slack thread id format `slack:CHANNEL:THREAD_TS` (encode/decode/isDM/channelIdFromThreadId) | `@chat-adapter/slack@4.29.0` `index.d.ts:866 (encode), 871 (isDM), 881 (decode), 892 (channelIdFromThreadId)` |
| `AdapterPostableMessage = string \| { raw } \| { markdown } \| { ast } \| { card } \| CardElement` | `chat@4.29.0` `chat-D9UYaaNO.d.ts:1549` |
| `Thread.post(message: string \| AdapterPostableMessage \| AsyncIterable<string> \| ChatElement)` | `chat@4.29.0` `chat-D9UYaaNO.d.ts:298` (the ChannelImpl variant at :100 has the same signature) |
| `bot.onAssistantThreadStarted(handler)` is a public method on `ChatInstance` | `chat@4.29.0` `chat-D9UYaaNO.d.ts:2913` |
| Telegram and Slack adapters both consume `AdapterPostableMessage` and convert `card` internally | telegram `index.d.ts:361 (postMessage), 418 (resolveParseMode reads card)`; slack `index.d.ts:73 (cardToBlockKit)` |
| `webClient` works in single-workspace mode without explicit context | slack `index.d.ts:533` |
| `postChannelMessage(channelId, message: AdapterPostableMessage)` posts at channel root, no thread_ts | slack `index.d.ts:911`, chat `chat-D9UYaaNO.d.ts:710` |
| `dispatchInteractivePayload` fires `chat.onAction` events for block_actions | slack `index.d.ts:625` (note: this is `protected` SDK plumbing — we don't call it; we rely on its effect of emitting `onAction` callbacks) |
| `Card / Section / Actions / Button / Text` factory functions and shapes | chat `jsx-runtime-CFq1K_Ve.d.ts:52 (Button), 100 (Actions), 150 (CardElement), 181 (Card factory), 226 (Section), 241 (Actions factory), 268 (Button factory)` |
| `AssistantThreadStartedEvent` payload shape (channelId, userId, threadTs, context.teamId) | chat `chat-D9UYaaNO.d.ts:2120` |

## What still requires a small spike during early Phase 2

1. **Chat SDK 4.29 telegram d.ts diff vs 4.26** — Phase 0 verification. Spend 10 minutes on a structured diff before bumping (we already have the 4.29 d.ts cached at `/tmp/tg-inspect/package/dist/index.d.ts`; need to compare against whatever the project locks today).
2. **`@chat-adapter/tests` package availability** — `npm view @chat-adapter/tests version` before Phase 4 commits. If absent, fall back to hand-rolled mocks (matches existing telegram test style).
3. **Slack adapter actions block button cap** — verify whether the SDK's `cardToBlockKit` chunks button groups itself when an `ActionsElement` has more than 5 children. If not, `richMenuToCard` chunks at our layer. 5-line spike.
4. **Slack manifest `features.assistant_view` schema** — confirm the exact shape against current Slack manifest docs. The manifest in §3 is a starting point.

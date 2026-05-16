# Rich UI Surface Design

> Status: Design
> Date: 2026-05-16
> Target: Roundhouse gateway / Telegram now, Slack and Discord later

## 1. Problem Statement

Today, command modules own Telegram UI details themselves.

Current pattern in `/model` and `/topic`:
- inspect `thread.adapter.telegramFetch`
- extract chat id with `extractTelegramChatId(thread)`
- build raw Telegram `sendMessage` payloads with `reply_markup`
- catch transport failure and fall back to `postWithFallback(thread, text)`

That leaks Telegram into gateway command code at multiple sites:
- [src/gateway/model-command.ts](/home/ec2-user/repos/roundhouse/src/gateway/model-command.ts)
- [src/gateway/topic-command.ts](/home/ec2-user/repos/roundhouse/src/gateway/topic-command.ts)
- [src/gateway/inline-keyboard.ts](/home/ec2-user/repos/roundhouse/src/gateway/inline-keyboard.ts)
- command registration in [src/gateway/gateway.ts](/home/ec2-user/repos/roundhouse/src/gateway/gateway.ts) still has to wire action handlers around a Telegram callback protocol

This scales poorly:
- every new menu command reimplements the same transport branching
- Telegram callback encoding becomes gateway knowledge
- Slack/Discord would force copy-paste variants or command-level transport branching
- the current bug is a direct symptom: command code assumes transport data lives on the thread object in a Telegram-specific shape

The topic-session failure is the clearest example. A named-topic route rewrites session identity to `topic:<chatId>:<name>`. Somewhere in that synthetic routing path, the thread loses its transport capabilities, so `/topic` falls back to text exactly where its menu path is most important.

The architectural issue is not “`/topic` forgot to hydrate the adapter.” The issue is:
- commands should not know how Telegram menus are posted
- session routing should not strip transport state from a thread

## 2. Proposed Architecture

### 2.1 Core idea

Commands return a transport-agnostic response object. The gateway asks the active `TransportAdapter` to render it.

Rules:
- command modules return data, not transport calls
- gateway owns dispatch
- transports render rich UI if supported
- unsupported transports degrade to `response.text`
- `CommandDescriptor.actions` remains the callback routing mechanism

### 2.2 Rich response type

Keep the first abstraction narrow: text plus optional menu.

```ts
export interface RichButton {
  label: string;
  actionId: string;
  value: string;
  selected?: boolean;
}

export interface RichMenuSection {
  title?: string;
  columns?: 1 | 2 | 3;
  buttons: RichButton[];
}

export interface RichMenu {
  title?: string;
  body?: string;
  sections: RichMenuSection[];
}

export interface RichResponse {
  text: string;
  menu?: RichMenu;
}
```

Opinionated constraints:
- `text` is mandatory and is the canonical fallback
- buttons carry gateway action ids, not platform callback payloads
- menu layout is descriptive, not platform-specific
- no Telegram HTML, no Slack blocks, no Discord components in gateway code

This is enough for `/model`, `/topic`, `/crons`, `/dismiss`, and most “pick one action” surfaces. If Slack later needs richer cards, add another optional top-level surface type; do not contaminate the base menu shape early.

### 2.3 Command contract

Extend `CommandDescriptor.invoke` and `actions` so they may return a `RichResponse`.

```ts
export type CommandResult = void | RichResponse;

export interface CommandDescriptor {
  triggers: readonly string[];
  stage?: CommandStage;
  acceptsArgs?: boolean;
  invoke: (inv: CommandInvocation) => Promise<CommandResult> | CommandResult;
  actions?: Record<string, (inv: ActionInvocation) => Promise<CommandResult> | CommandResult>;
}
```

Implications:
- pure menu commands become data builders
- action handlers can also return `RichResponse` if they want to confirm state or re-render the menu
- legacy commands can keep returning `void` during migration

### 2.4 Gateway dispatch

Add one gateway helper:

```ts
private async postCommandResult(thread: ChatThread, result: CommandResult) {
  if (!result) return;
  await this.transport.postRich(thread, result);
}
```

Dispatch path:
- `invoke()` returns `void`: command handled its own posting, legacy path
- `invoke()` returns `RichResponse`: gateway calls `transport.postRich(thread, result)`
- `transport.postRich()` renders native UI if possible
- default implementation falls back to `postMessage(thread, response.text)`

This keeps the `CommandDescriptor` pattern intact. Descriptors stay the extension point; they just describe UI as data instead of issuing transport calls themselves.

### 2.5 TransportAdapter change

Add a first-class rich-post method.

```ts
export interface TransportAdapter {
  readonly name: string;
  enrichPrompt(text: string): string;
  postMessage(thread: ChatThread, text: string): Promise<void>;
  postRich(thread: ChatThread, response: RichResponse): Promise<void>;
  registerCommands(token: string): Promise<void>;
  ownsThread(thread: ChatThread): boolean;
  notify(chatIds: number[], text: string): Promise<void>;
  createThread(chatId: number): ChatThread;
  isPairingPending(): Promise<boolean>;
  handlePairing(thread: ChatThread, message: IncomingMessage): Promise<PairingResult | null>;
}
```

Behavior:
- Telegram: render inline keyboard from `response.menu`
- Slack/Discord later: map the same menu to buttons/components
- text-only adapters: ignore `menu`, send `response.text`

### 2.6 Callback routing stays decoupled

Do not move callback ownership into transports.

Keep:
- `CommandDescriptor.actions`
- gateway startup validation with `collectAndValidateActions()`
- gateway-level `chat.onAction(actionId, handler)`

Only change the payload boundary:
- commands define `actionId` on buttons
- adapter turns `RichButton` into platform callback payload
- adapter or chat SDK maps platform callback back to `actionId` and `value`
- gateway invokes the descriptor action handler

That preserves the current command ownership model and keeps callback semantics platform-neutral.

### 2.7 Fix the topic-session adapter-loss bug at the source

Do not fix this in `/topic`. Fix routing.

Required rule:
- transport thread identity and agent session identity must not be conflated

Recommended shape:

```ts
export interface ChatThread {
  id: string; // platform thread id, stable
  platformThreadId?: string; // optional alias during migration
  post(text: string): Promise<void>;
  [key: string]: unknown;
}
```

Routing rule:
- keep `thread.id` as the transport-owned id, e.g. `telegram:12345`
- compute `agentThreadId` separately, e.g. `topic:12345:deploy`
- if the gateway creates a synthetic routed thread object, it must clone the original thread and preserve adapter/platform fields

Concretely:
- no code should replace a live transport thread with a bare `{ id: "topic:..." }`
- if a synthetic thread is unavoidable, build it through one shared helper such as `preserveThreadTransport(thread, routedId)` in the transport or gateway layer
- commands should always receive a transport-capable thread

This bug exists because route state is currently allowed to erase transport state. That must become impossible by construction.

## 3. Code Sketches

### 3.1 Shared types

```ts
// src/transports/types.ts
export interface RichButton {
  label: string;
  actionId: string;
  value: string;
  selected?: boolean;
}

export interface RichMenuSection {
  title?: string;
  columns?: 1 | 2 | 3;
  buttons: RichButton[];
}

export interface RichMenu {
  title?: string;
  body?: string;
  sections: RichMenuSection[];
}

export interface RichResponse {
  text: string;
  menu?: RichMenu;
}

export interface TransportAdapter {
  readonly name: string;
  enrichPrompt(text: string): string;
  postMessage(thread: ChatThread, text: string): Promise<void>;
  postRich(thread: ChatThread, response: RichResponse): Promise<void>;
  // ...
}
```

### 3.2 `/model` before

Today, `/model` mixes three concerns:
- state mutation
- response construction
- Telegram transport rendering

Sketch of the current hot path:

```ts
if (!target) {
  const adapter = thread?.adapter;
  if (adapter?.telegramFetch) {
    const chatId = extractTelegramChatId(thread);
    await adapter.telegramFetch("sendMessage", {
      chat_id: chatId,
      text: msgText,
      parse_mode: "HTML",
      reply_markup: buildInlineKeyboard(),
    });
    return;
  }

  await postWithFallback(thread, fallbackText);
}
```

### 3.3 `/model` after

`/model` becomes a data producer.

```ts
// src/gateway/model-command.ts
import type { RichResponse } from "../transports";

function buildModelMenu(current: string): RichResponse {
  return {
    text:
      `🤖 *Current model:* ${current}\n\n` +
      `Available:\n` +
      KEYBOARD_MODELS
        .map((alias) => {
          const info = MODEL_ALIASES[alias];
          const marker = alias === current ? " (current)" : "";
          return `- \`${alias}\` → ${info.label}${marker}`;
        })
        .join("\n") +
      `\n\nUsage: \`/model sonnet\``,
    menu: {
      title: "Current model",
      body: current,
      sections: [
        {
          columns: 2,
          buttons: KEYBOARD_MODELS.map((alias) => ({
            label: MODEL_ALIASES[alias].label,
            actionId: MODEL_ACTION_ID,
            value: alias,
            selected: MODEL_ALIASES[alias].label === current,
          })),
        },
      ],
    },
  };
}

export async function handleModel(ctx: ModelCommandContext): Promise<RichResponse | void> {
  const parts = ctx.text.split(/\s+/).slice(1);
  const target = parts[0]?.toLowerCase();
  const settings = readSettings();

  if (!target) {
    return buildModelMenu(getCurrentModel(settings));
  }

  return await applyModelSelection(target, settings);
}
```

Selection handler can also return data:

```ts
export async function applyModelSelection(
  target: string,
  settings: Record<string, unknown> | null,
): Promise<RichResponse> {
  // mutate settings
  return { text: `✅ Switched to *${resolved.label}*` };
}
```

Gateway wiring becomes smaller:

```ts
{
  triggers: ["/model"],
  acceptsArgs: true,
  invoke: ({ text }) => handleModel({ text }),
  actions: {
    [MODEL_ACTION_ID]: ({ value }) => handleModelAction({ value }),
  },
}
```

And action handling can re-use the same return type:

```ts
export async function handleModelAction(event: { value?: string }): Promise<RichResponse | void> {
  const alias = event.value;
  if (!alias || !MODEL_ALIASES[alias]) return;
  return applyModelSelection(alias, null);
}
```

### 3.4 Gateway diff sketch

```ts
// src/gateway/command-registry.ts
export type CommandResult = void | RichResponse;

export interface CommandDescriptor {
  // ...
  invoke: (inv: CommandInvocation) => Promise<CommandResult> | CommandResult;
  actions?: Record<string, (inv: ActionInvocation) => Promise<CommandResult> | CommandResult>;
}
```

```ts
// src/gateway/gateway.ts
for (const desc of inTurnCommands) {
  if (matchesDescriptor(desc, trimmed, matchers)) {
    const result = await desc.invoke(inv);
    await this.postCommandResult(thread, result);
    return;
  }
}

for (const { actionId, handler } of collectAndValidateActions(allDescriptors)) {
  this.chat.onAction(actionId, async (event: any) => {
    const result = await handler({ value: event.value, thread: event.thread });
    await this.postCommandResult(event.thread, result);
  });
}
```

### 3.5 TelegramAdapter `postRich`

```ts
// src/transports/telegram/telegram-adapter.ts
import { encodeTelegramCallbackData, toTelegramInlineKeyboard } from "./rich-ui";

async postRich(thread: ChatThread, response: RichResponse): Promise<void> {
  if (!response.menu) {
    await this.postMessage(thread, response.text);
    return;
  }

  const telegramThread = thread as any;
  const telegramFetch = telegramThread?.adapter?.telegramFetch;
  const chatId = telegramThread?.platformThreadId?.split(":")[1] ?? telegramThread?.id?.split(":")[1];

  if (!telegramFetch || !chatId) {
    await this.postMessage(thread, response.text);
    return;
  }

  try {
    const first = response.menu.sections[0];
    await telegramFetch("sendMessage", {
      chat_id: chatId,
      text: buildTelegramMenuHtml(response),
      parse_mode: "HTML",
      reply_markup: toTelegramInlineKeyboard(response.menu),
    });
  } catch (err) {
    console.warn("[roundhouse] telegram postRich failed, falling back:", (err as Error).message);
    await this.postMessage(thread, response.text);
  }
}
```

Notes:
- Telegram callback encoding moves out of `src/gateway/inline-keyboard.ts`
- that file should either disappear or move under `src/transports/telegram/`
- gateway no longer knows Telegram callback payload format

### 3.6 Text-only adapter `postRich`

```ts
async postRich(thread: ChatThread, response: RichResponse): Promise<void> {
  await this.postMessage(thread, response.text);
}
```

That is the intended degradation path.

## 4. Migration Plan

Keep each PR narrow and non-breaking.

### PR 1: Introduce abstraction

Scope:
- add `RichResponse` types
- add `TransportAdapter.postRich()`
- add gateway `postCommandResult()`
- allow `CommandDescriptor.invoke/actions` to return `CommandResult`
- move Telegram callback encoding helpers into `src/transports/telegram/`
- add a shared routing helper that preserves transport fields on synthetic threads

Non-breaking rule:
- existing commands may still call `postWithFallback`
- `postCommandResult()` only runs when a handler returns a value

Target size:
- under 300 lines if the transport-preserving helper is kept small

### PR 2: Migrate `/model`

Scope:
- convert [src/gateway/model-command.ts](/home/ec2-user/repos/roundhouse/src/gateway/model-command.ts) to return `RichResponse`
- remove direct `telegramFetch` usage from the command
- keep action id and behavior unchanged

Result:
- one-file command authoring model proven on a simple menu

### PR 3: Migrate `/topic` and fix thread rewrite bug at source

Scope:
- convert [src/gateway/topic-command.ts](/home/ec2-user/repos/roundhouse/src/gateway/topic-command.ts) to return `RichResponse`
- remove Telegram imports from the command
- land the routing-layer fix so topic-scoped flows always retain transport state
- add a regression test for named-topic `/topic` menu rendering

This PR is where the current bug actually gets eliminated.

### PR 4: Migrate `/crons` and future interactive commands

Scope:
- move `/crons` selection UI onto the same `RichResponse` surface
- add `/dismiss` or future menu commands without touching transport code

Steady-state outcome:
- new command-with-menu changes only its command file plus one line in the descriptor list

## 5. Trade-offs and Risks

### Locks in

- `text` remains the canonical response format
- command interactivity is modeled around button-style actions keyed by `actionId`
- gateway owns rendering dispatch, not commands

That is a good lock-in. It centralizes platform complexity where it belongs.

### Leaves open

- Slack/Discord can render the same menu with their own native components
- richer surfaces can be added later as another optional field, not a rewrite
- action handlers can later support message edits instead of always posting a new message

### Risks

- the first menu shape may be too narrow for future card-heavy Slack UX
- Telegram HTML formatting and markdown fallback can drift if built separately
- if callback payload encoding remains partly in gateway, coupling will survive under a new name
- migration can stall halfway, leaving mixed patterns temporarily

Mitigations:
- keep `RichResponse` intentionally small
- generate rich and fallback text from the same command state
- move all callback payload serialization into the transport package
- migrate the current Telegram menu commands quickly after the abstraction lands

## 6. Anti-Patterns Avoided

- Command modules importing transport-specific types or helpers such as `telegramFetch`, Telegram callback encoding, or Slack block payloads.
- Per-command fallback ladders that try rich UI, catch transport failure, then send plain text themselves.
- Hydration shims that patch missing `thread.adapter` at individual registration sites or command entry points.
- Overloading `thread.id` with agent session ids like `topic:...` and treating that as a transport thread.
- Adding a generic “platform payload” escape hatch to `RichResponse`; that would reintroduce transport leakage immediately.

## Recommendation

Adopt a narrow `RichResponse` now and move rendering into `TransportAdapter.postRich()`.

That solves the real problem:
- command modules define intent
- transports define presentation
- routing preserves transport state

It fixes the current `/topic` bug at the correct layer and gives Slack/Discord a clean extension seam instead of another round of command-level branching.

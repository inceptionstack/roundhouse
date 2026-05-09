# Transport Adapter Design

> Date: 2026-05-09
> Status: Partial (enrichPrompt, postMessage, registerCommands, ownsThread, notify done; handlePairing, resolveAuthor, createProgress deferred)
> Branch: refactor/transport-adapter

## Goal

Extract a `TransportAdapter` interface from gateway.ts that encapsulates all Telegram-specific behavior. The gateway becomes a transport-agnostic router between transports and agents with shared memory/state.

## Interface

```typescript
/**
 * A transport adapter handles platform-specific concerns:
 * - Message formatting (input enrichment, output rendering)
 * - Bot command registration
 * - Pairing/onboarding flows
 * - Notification delivery
 * - Thread identity resolution
 */
export interface TransportAdapter {
  /** Transport name (e.g. "telegram", "slack") */
  readonly name: string;

  /** Enrich an outgoing prompt before sending to agent */
  enrichPrompt(text: string): string;

  /** Post a message to a thread, using platform-native formatting */
  postMessage(thread: ChatThread, text: string): Promise<void>;

  /** Register bot commands with the platform */
  registerCommands(token: string): Promise<void>;

  /** Handle platform-specific pairing flow. Returns true if message was consumed. */
  handlePairing(thread: ChatThread, message: IncomingMessage, config: GatewayConfig): Promise<boolean>;

  /** Resolve the author identity from a platform message */
  resolveAuthor(thread: ChatThread, message: IncomingMessage): { name: string; id: string } | null;

  /** Check if a thread belongs to this transport */
  ownsThread(thread: ChatThread): boolean;

  /** Send notifications to configured chat IDs */
  notify(chatIds: number[], text: string): Promise<void>;

  /** Create a progress/typing indicator */
  createProgress(thread: ChatThread, token: string): ProgressHandle | null;
}

export interface ProgressHandle {
  update(text: string): Promise<void>;
  stop(): void;
}
```

## Extraction Plan

### What moves from gateway.ts → TelegramTransportAdapter:

1. **`enrichPrompt()`** — appends `[Format your final answer to be telegram-friendly.]`
2. **`postMessage()`** — `isTelegramThread` check + `postTelegramHtml` call (lines 621-623)
3. **`registerCommands()`** — the `registerBotCommands()` method (lines 640-660)
4. **`handlePairing()`** — the `handlePendingPairing()` method (lines 96-170)
5. **`resolveAuthor()`** — author resolution logic from `handleNewMessage` (lines 117-130)
6. **`ownsThread()`** — `isTelegramThread()` check
7. **`notify()`** — `sendTelegramToMany()` wrapper
8. **`createProgress()`** — `createProgressMessage()` wrapper

### What stays in gateway.ts (transport-agnostic):

- Agent adapter lifecycle (create, prompt, stream)
- Thread queue / concurrency management
- Memory system (flush, compact, pressure)
- Command routing (/new, /stop, /status, etc.)
- Config loading
- Allowed user authorization

### File Structure

```
src/transports/
├── types.ts              # TransportAdapter interface + ProgressHandle
├── telegram/
│   ├── adapter.ts        # TelegramTransportAdapter implements TransportAdapter
│   ├── format.ts         # (existing) Markdown → HTML
│   ├── html.ts           # (existing) HTML streaming
│   ├── progress.ts       # (existing) Typing indicators
│   ├── pairing.ts        # (existing) Nonce-based pairing
│   ├── notify.ts         # (existing) Notification delivery
│   └── bot-commands.ts   # (existing) Command definitions
└── index.ts              # Transport registry/factory
```

## Gateway Integration

```typescript
// gateway.ts uses transport adapter via composition
class Gateway {
  private transport: TransportAdapter;

  constructor(config) {
    // For now, always Telegram. Future: resolve from config.
    this.transport = new TelegramTransportAdapter(config);
  }

  // Before sending to agent:
  private prepareAgentMessage(...) {
    if (agentMessage.text) {
      agentMessage.text = this.transport.enrichPrompt(agentMessage.text);
    }
  }

  // After receiving from agent:
  private postWithFallback(thread, text) {
    return this.transport.postMessage(thread, text);
  }
}
```

## Constraints

- No behavioral changes — pure structural refactoring
- All 370 tests must pass
- Gateway still works exactly the same from outside
- Transport adapter is injected at construction, not selected per-message
- Existing utility files (format.ts, html.ts, etc.) stay — adapter composes them

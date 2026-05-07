# Chat Transport Modularization — Future Plan

Roundhouse currently has soft Telegram couplings that should be abstracted before
adding Slack, Discord, or TUI transports.

---

## Current State (acceptable for single-adapter)

| Area | Coupling | Severity |
|---|---|---|
| `isCommand()` / `isCommandWithArgs()` | Handles Telegram `@botname` suffix | Low — falls through to exact match |
| `telegram-progress.ts` | Edit-in-place only works on Telegram | Medium — no-op fallback for others |
| `/start` command skip | Telegram-only lifecycle event | Low — harmless for others |
| `registerBotCommands()` | Calls Telegram Bot API directly | Medium — adapter concern |
| `notifyStartup()` | Hard-coded to `sendTelegramToMany()` | Medium — acknowledged in code |

---

## Proposed Refactoring (when adding 2nd transport)

### 1. Command Router abstraction

```typescript
interface CommandRouter {
  /** Register a command with its handler */
  register(cmd: string, handler: CommandHandler): void;
  /** Try to match and execute a command from raw text */
  dispatch(text: string, ctx: CommandContext): Promise<boolean>;
}

interface CommandContext {
  thread: Thread;
  authorName: string;
  progress: ProgressReporter;  // adapter-agnostic
}

interface CommandHandler {
  requiresAllowlist: boolean;
  execute(ctx: CommandContext, args?: string): Promise<void>;
}
```

Each command lives in `src/commands/` (already started with `update.ts`).
The router handles prefix matching; adapters supply their own normalization
(Telegram strips `@botname`, Slack strips `/`, TUI passes raw).

### 2. ProgressReporter interface (replace telegram-progress.ts)

```typescript
interface ProgressReporter {
  /** Send initial status (all adapters) */
  start(text: string): Promise<void>;
  /** Update status (edit-in-place if supported, otherwise append) */
  update(text: string): Promise<void>;
  /** Final status */
  done(text: string): Promise<void>;
}
```

Each adapter provides its own implementation:
- **Telegram**: edit message in place (current behavior)
- **Slack**: update message via `chat.update` API
- **Discord**: edit embed
- **TUI**: overwrite terminal line (spinner)

### 3. Adapter lifecycle hooks

```typescript
interface ChatAdapter {
  // ... existing ...

  /** Register commands with the platform (e.g., Telegram setMyCommands, Slack manifest) */
  registerCommands?(commands: CommandDefinition[]): Promise<void>;

  /** Send notification to configured channels (startup, errors, etc.) */
  notify?(chatIds: number[] | string[], message: string): Promise<void>;

  /** Create a progress reporter for a given thread */
  createProgress(thread: Thread, initialText: string): Promise<ProgressReporter>;
}
```

### 4. Migration steps

1. Extract remaining inline commands (`/restart`, `/compact`, `/status`, `/new`) to `src/commands/`
2. Create `CommandRouter` with adapter-aware normalization
3. Move `registerBotCommands` into `TelegramAdapter.registerCommands()`
4. Move `notifyStartup` → `adapter.notify()`
5. Replace `createProgressMessage()` with `adapter.createProgress()`
6. Remove `telegram-progress.ts` (folded into adapter)

### 5. What's already correct (no changes needed)

- `src/bundle.ts` — pure provisioning, zero transport awareness
- `src/commands/update.ts` — receives `UpdateProgress` interface, not a thread
- Command auth checks — use `allowedUsers` / `allowedUserIds` (transport-agnostic)
- Agent routing — `AgentRouter` / `AgentAdapter` have no transport coupling
- Memory system — operates on thread IDs, doesn't know about Telegram

---

## Timeline

Not needed until a second chat transport is actively being built.
Current architecture is correct for single-adapter use — the soft couplings
are contained and documented. When the time comes, follow steps 1-6 above.

# roundhouse

A multi-platform chat gateway that routes messages through a single configured AI agent.

One gateway instance = one agent target (pi, Kiro, etc.), configured at install time.
Multiple chat inputs (Telegram, Slack, Discord via [Vercel Chat SDK](https://chat-sdk.dev)) all feed into that same agent.

## Install

```bash
npm install -g @inceptionstack/roundhouse
```

## Architecture

```
 ┌─────────────────────────────────────────────────┐
 │                 Vercel Chat SDK                  │
 │  ┌───────────┐ ┌───────────┐ ┌──────────────┐   │
 │  │ Telegram  │ │   Slack   │ │   Discord    │   │
 │  └─────┬─────┘ └─────┬─────┘ └──────┬───────┘   │
 │        └──────────────┼──────────────┘            │
 └───────────────────────┬──────────────────────────┘
                         │
               ┌─────────┴──────────┐
               │      Gateway       │
               │                    │
               │  • user allowlist  │
               │  • message split   │
               │  • typing indicator│
               └─────────┬──────────┘
                         │
               ┌─────────┴──────────┐
               │    AgentRouter     │
               │                    │
               │  today: single     │
               │  agent pass-through│
               │                    │
               │  future: per-thread│
               │  multi-agent, etc. │
               └─────────┬──────────┘
                         │
               ┌─────────┴──────────┐
               │   AgentAdapter     │  ← ONE, configured at install time
               │                    │
               │  e.g. Pi agent on  │
               │  THIS machine with │
               │  persistent        │
               │  sessions on disk  │
               └────────────────────┘
```

See [architecture.md](architecture.md) for full system diagrams, data flow, config model, and module dependency graph.

### Design decisions

- **One gateway = one agent target.** The `agent` block in config picks the type and its settings. All chat inputs route to this single agent instance.
- **Multiple chat inputs into the same agent.** Telegram and Slack messages go to the same agent, each on their own session thread (`telegram:<id>`, `slack:<id>`).
- **AgentRouter is a seam.** Today it's `SingleAgentRouter` (hardcoded pass-through). The interface exists so we can later swap in per-thread routing, multi-agent, or load-balanced strategies without changing the gateway or adapters.
- **AgentAdapter is the only abstraction we own.** The chat side is Vercel Chat SDK — we don't wrap it. The agent side is our `AgentAdapter` interface: `prompt(threadId, text) → AgentResponse`.
- **Config-driven.** `gateway.config.json` (or `--config` flag, or env vars) determines everything at startup. No runtime reconfiguration.
- **Persistent sessions.** Each thread gets its own session file on disk. Gateway restarts resume from the same file. Pi CLI can join the same session.

## Quick start

### 1. Create a Telegram bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. `/newbot` → pick a name and username
3. Copy the **bot token**

### 2. Run (dev mode)

```bash
git clone https://github.com/inceptionstack/roundhouse.git
cd roundhouse
npm install
export TELEGRAM_BOT_TOKEN="your-token"
export ALLOWED_USERS="your_telegram_username"
npm start
```

### 3. Or install globally and run as a daemon

```bash
npm install -g @inceptionstack/roundhouse
export TELEGRAM_BOT_TOKEN="your-token"
export ALLOWED_USERS="your_username"
roundhouse install    # installs as systemd service, starts automatically
```

## CLI

```
roundhouse <command>

Commands:
  start               Start the gateway (foreground)
  tui [thread]        Open agent TUI on a gateway session
  install             Install as a systemd daemon (requires sudo)
  uninstall           Remove the systemd daemon
  update              Update from npm + restart daemon
  status              Show daemon status (rich detail view)
  logs                Tail daemon logs
  stop                Stop the daemon
  restart             Restart the daemon
  config              Show config path and contents
```

### `roundhouse status`

Shows detailed daemon info including version, state, PID, uptime, memory, agent type and version, platforms, allowed users, notify chats, debug flags, and config paths.

### `roundhouse tui`

Opens the configured agent's interactive TUI, resumed to a gateway chat session. This lets you continue the same conversation from Telegram in your terminal.

```bash
roundhouse tui                    # pick from all threads
roundhouse tui telegram           # filter to telegram threads
roundhouse tui telegram_c12345    # exact thread match
```

## Config

Place `gateway.config.json` in `~/.config/roundhouse/` (created by `roundhouse install`), or in the project root, or use `--config path`:

```json
{
  "agent": {
    "type": "pi",
    "cwd": "/home/you/project"
  },
  "chat": {
    "botUsername": "my_bot",
    "allowedUsers": ["your_username"],
    "adapters": {
      "telegram": { "mode": "polling" }
    }
  }
}
```

Without a config file, defaults are used with env vars (`TELEGRAM_BOT_TOKEN`, `BOT_USERNAME`, `ALLOWED_USERS`).

### Config reference

| Field | Description |
|-------|-------------|
| `agent.type` | Agent backend: `"pi"` (more coming) |
| `agent.cwd` | Working directory for the agent |
| `agent.sessionDir` | Override session storage path |
| `chat.botUsername` | Bot display name for Chat SDK |
| `chat.allowedUsers` | Telegram usernames / user IDs allowed (empty = allow all) |
| `chat.notifyChatIds` | Telegram chat IDs to notify on startup (env: `NOTIFY_CHAT_IDS`) |
| `chat.adapters.telegram` | `{ "mode": "polling" \| "webhook" \| "auto" }` |

Secrets stay in env vars: `TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`, etc.

## Joining a session from pi CLI

Sessions are stored at `~/.pi/agent/gateway-sessions/<thread>/`. Resume from CLI:

```bash
# Via roundhouse (recommended — auto-discovers sessions)
roundhouse tui

# Or directly via pi
pi --resume ~/.pi/agent/gateway-sessions/<thread_dir>/<session>.jsonl
```

Messages from Telegram/Slack and from the CLI share the same context.

## Telegram bot commands

Roundhouse automatically registers these commands with Telegram on startup:

| Command | Description |
|---------|-------------|
| `/new` | Start a fresh conversation (resets the agent session for this chat) |
| `/compact` | Compact session context to free up tokens |
| `/status` | Show gateway status: version, agent, model, context usage, uptime, etc. |
| `/restart` | Restart the gateway service (requires `allowedUsers` to be configured) |

These appear in Telegram's `/` command menu automatically.

### `/status` details

Shows a rich status view including:
- Roundhouse and agent versions
- Current model (from active session or configured default)
- Context token usage with visual progress bar
- Active sessions, platforms, uptime, memory
- Debug flags and allowed users

### `/compact`

Manually triggers context compaction for the current chat's session. Shows before/after token counts. Useful when conversations get long and you want to free up context window space without starting a new session.

### Follow-up notifications

When extensions (e.g. code review) queue follow-up work after the agent responds, the gateway shows:
- ⏳ "Hold on — waiting for follow-up messages..." (after 2s delay)
- ✅ "All done — waiting for your input." (when processing completes)

Fast operations that complete within 2 seconds show no extra messages.

## Extensions

### Code review extension

The code review extension has moved to its own package: [pi-autoreview](https://github.com/inceptionstack/pi-autoreview). Install it with:

```bash
pi install git:github.com/inceptionstack/pi-autoreview
```

## Adding a new agent backend

1. Create `src/agents/kiro.ts` implementing `AgentAdapter`
2. Register in `src/agents/registry.ts`: `registry.set("kiro", createKiroAgentAdapter)`
3. Set `"agent": { "type": "kiro" }` in config

```typescript
import type { AgentAdapter, AgentAdapterFactory } from "../types";

export const createKiroAgentAdapter: AgentAdapterFactory = (config) => {
  return {
    name: "kiro",
    async prompt(threadId, text) {
      // your implementation
      return { text: "response" };
    },
    async dispose() {},
  };
};
```

## Adding a new chat platform

Add the Chat SDK adapter package and wire it in `gateway.ts`:

```typescript
if (config.slack) {
  const { createSlackAdapter } = await import("@chat-adapter/slack");
  adapters.slack = createSlackAdapter();
}
```

No other changes needed — the gateway's unified handler covers all platforms.

## Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point, config loading, startup |
| `src/gateway.ts` | Owns Chat SDK, wires events → router → agent |
| `src/router.ts` | `AgentRouter` interface + `SingleAgentRouter` |
| `src/types.ts` | Core interfaces: `AgentAdapter`, `AgentStreamEvent`, `AgentRouter`, `GatewayConfig` |
| `src/util.ts` | Pure utilities: `splitMessage`, `isAllowed`, `threadIdToDir`, `startTypingLoop` |
| `src/cli/cli.ts` | CLI: start, install, tui, update, logs, etc. |
| `src/agents/pi.ts` | Pi agent adapter (persistent sessions via pi SDK) |
| `src/agents/registry.ts` | Agent type → factory registry |
| `src/config.ts` | Shared config loading, defaults, env overrides |
| `test/` | Unit tests (vitest, 48 passing) |

## CI/CD

Tests run on every push/PR. Publishing to npm happens automatically on tag push:

```bash
npm version patch    # bumps version, creates git tag
git push origin main --tags   # triggers publish workflow
```

Requires `NPM_TOKEN` secret in GitHub repo settings.

## Testing

```bash
npm test          # run once
npm run test:watch # watch mode
```

## License

MIT

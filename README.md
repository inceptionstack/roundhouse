# roundhouse

A multi-platform chat gateway that routes messages through a single configured AI agent.

One gateway instance = one agent target (pi, Kiro, etc.), configured at install time.
Multiple chat inputs (Telegram, Slack, Discord via [Vercel Chat SDK](https://chat-sdk.dev)) all feed into that same agent.

## Install

```bash
npm install -g @inceptionstack/roundhouse
roundhouse setup --telegram
roundhouse start  # Auto-starts via LaunchAgent (macOS) or systemd (Linux)
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

## Bundle

When you run `roundhouse setup`, the following are installed automatically:

- **30+ Skills** (agent knowledge): Synced from [loki-skills](https://github.com/inceptionstack/loki-skills) (AWS, infrastructure, DevOps patterns)
- **CLI Tools**: `mcporter` (MCP server bridge), `@playwright/cli` (browser automation), `uv`/`uvx` (Python package runner)
- **Extensions** (copied to `~/.pi/agent/extensions/` if not present; never overwrites user copies): `web-search` (Tavily)
- **Extension packages** (registered in `settings.json`): `pi-hard-no` (code review), `pi-branch-enforcer` (branch protection)
- **Config**: MCP server definitions copied to `~/.mcporter/mcporter.json`

This gives the agent access to:
- 15K+ AWS APIs via `mcporter call aws-mcp.*`
- AWS documentation, CDK patterns, pricing data
- Browser automation: navigate pages, fill forms, take screenshots
- Real-time web search
- All skills auto-discovered at session start

### Setup time

Full setup takes ~5-10 minutes on first run (includes Chromium download ~186MB). Subsequent runs are faster (skills re-sync only).

### Skills location

All skills are synced to `~/.pi/agent/skills/`. Your agent can reference them directly by name (e.g., "use the aws-mcp skill to...").

### Design decisions

- **One gateway = one agent target.** The `agent` block in config picks the type and its settings. All chat inputs route to this single agent instance.
- **Multiple chat inputs into the same agent.** Telegram and Slack messages go to the same agent, each on their own session thread (`telegram:<id>`, `slack:<id>`).
- **AgentRouter is a seam.** Today it's `SingleAgentRouter` (hardcoded pass-through). The interface exists so we can later swap in per-thread routing, multi-agent, or load-balanced strategies without changing the gateway or adapters.
- **AgentAdapter is the only abstraction we own.** The chat side is Vercel Chat SDK — we don't wrap it. The agent side is our `AgentAdapter` interface: `prompt(threadId, message) → AgentResponse`.
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

## Slack quick start

Slack is supported in **socket mode** (single workspace, v1). No public URL required — the gateway connects to Slack via WebSocket.

### 1. Create the Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app manifest**.
2. Pick your workspace. Paste the manifest that `roundhouse setup --slack` prints inline (and writes to `/tmp/roundhouse-slack-manifest.yaml` for easy paste). The same YAML lives in the source tree at `src/transports/slack/manifest.yaml` for reference.
3. **Install to Workspace**, then on the **Basic Information** page:
   - Generate an **App-Level Token** with the `connections:write` scope. Copy the `xapp-…` value.
   - Open **OAuth & Permissions**, copy the **Bot User OAuth Token** (`xoxb-…`).

### 2. Run setup

```bash
roundhouse setup --slack
# (interactive — will prompt for tokens and your Slack username)
```

Or non-interactive (e.g. SSM / cloud-init):

```bash
SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-… \
  roundhouse setup --slack --non-interactive --user your_slack_handle
```

### 3. Pair

The setup writes a pending-pairing file (`~/.roundhouse/slack-pairing.json`) and starts the gateway. To complete pairing, **open a new DM with the bot** in Slack (click the bot in your sidebar or search Apps → @your-bot, then send any message). The first message from one of the configured `allowedUsers` completes pairing.

> ⚠️ Slack only fires `message.im` for *existing* DM channels. If you've never DM'd the bot before, the assistant_thread_started event takes care of it — the bot's manifest enables Slack's Assistants API which fires that event when you click "Message" on the bot's profile.

### Slack feature support

| Feature | Supported |
|---|---|
| Plain text | Yes (markdown) |
| Block Kit menus (buttons, actions) | Yes (via the SDK's transport-agnostic Card model) |
| Streaming | Yes (post-then-edit fallback; native AI Assistant streaming is a v2 enhancement) |
| File attachments | Yes (uses Slack's authenticated `url_private` download) |
| Reactions / pins / scheduled messages | No (out of scope for v1) |
| Multi-workspace OAuth | No (single-workspace only in v1) |
| Webhook mode (no socket) | No (socket-only in v1; needs a public URL otherwise) |
| Slash commands as Slack-native commands | No (use roundhouse's `/new`, `/restart`, etc. as plain text) |

Telegram and Slack can run in the **same gateway instance** — configure both under `chat.adapters` and roundhouse routes per-thread.

## CLI

```
roundhouse <command>

Commands:
  setup               One-command install & configure (also works via npx)
  pair                Pair Telegram account for notifications
  start               Start the gateway daemon
  run                 Run the gateway in foreground
  tui [thread]        Open agent TUI on a gateway session
  install             Install as a systemd daemon (requires sudo)
  uninstall           Remove the systemd daemon
  update              Update from npm + restart daemon
  status              Show daemon status (rich detail view)
  logs                Tail daemon logs
  stop                Stop the daemon
  restart             Restart the daemon
  config              Show config path and contents
  agent <message>     Send a message to the agent and print response
  doctor [--fix]      Check system health and configuration
  cron <command>      Manage scheduled jobs (add, list, trigger, etc.)
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

Place `gateway.config.json` in `~/.roundhouse/` (created by `roundhouse install`), or in the project root, or use `--config path`:

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
| `agent.type` | Agent backend: `"pi"`, `"kiro"` |
| `agent.cwd` | Working directory for the agent |
| `agent.sessionDir` | Override session storage path |
| `chat.botUsername` | Bot display name for Chat SDK |
| `chat.allowedUsers` | Telegram / Slack usernames allowed (empty = allow all) |
| `chat.allowedUserIds` | Immutable user IDs (Telegram numeric, Slack `Uxxx`); paired during setup |
| `chat.notifyChatIds` | Chat IDs to notify on startup (Telegram numeric, Slack `Cxxx`/`Dxxx`) |
| `chat.adapters.telegram` | `{ "mode": "polling" \| "webhook" \| "auto" }` |
| `chat.adapters.slack` | `{ "mode": "socket" }` (v1: socket mode only; tokens via `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` env) |
| `voice.stt.enabled` | Enable automatic voice transcription (default: off unless configured) |
| `voice.stt.chain` | STT provider chain, e.g. `["whisper"]` |
| `voice.stt.providers.whisper` | `{ "model": "small", "timeoutMs": 30000 }` |

Secrets stay in env vars: `TELEGRAM_BOT_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `ANTHROPIC_API_KEY`, etc.

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
| `/verbose` | Toggle tool status messages on/off for this chat |
| `/status` | Show gateway status: version, agent, model, context usage, uptime, etc. |
| `/cancel` | Stop the current agent run (abort tools, LLM calls, compaction) |
| `/restart` | Restart the gateway service (requires `allowedUsers` to be configured) |
| `/doctor` | Run health checks and show system status |
| `/crons` | Manage scheduled jobs (list, trigger, pause, resume) |
| `/jobs` | List scheduled jobs (alias for /crons) |

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

### `/verbose`

Toggles verbose mode for the current chat. When ON, shows tool call status messages (e.g. "⚡ Running `bash`…"). When OFF (default), tool calls execute silently — you only see the agent's text responses. State shown in `/status`.

### `/cancel`

Aborts the current agent run for this chat — stops any in-progress tool calls, LLM generation, and compaction. The session is preserved; send another message to continue the conversation.

### Follow-up notifications

When extensions (e.g. code review) queue follow-up work after the agent responds, the gateway shows:
- ⏳ "Hold on — waiting for follow-up messages..." (after 2s delay)
- ✅ "All done — waiting for your input." (when processing completes)

Fast operations that complete within 2 seconds show no extra messages.

## File attachments

Roundhouse handles voice messages, images, documents, and other file attachments from Telegram:

1. Files are downloaded and saved to `~/.roundhouse/incoming/<thread>/<message>/`
2. A structured `AgentMessage` with typed `MessageAttachment[]` metadata is passed to the agent
3. The agent receives file paths, MIME types, sizes, and can inspect files with its tools
4. Files are marked as untrusted user-provided input

### Limits

| Limit | Value |
|-------|-------|
| Max file size | 20 MB per file |
| Max attachments | 5 per message |
| Filename length | 100 characters (sanitized to ASCII) |

Supported types: voice messages, audio, images, video, documents (PDF, etc.)

The incoming directory can be overridden with `ROUNDHOUSE_INCOMING_DIR` environment variable.

### How the agent sees attachments

The Pi adapter formats attachments as a fenced JSON manifest:

```
Chat attachments saved locally. Inspect these files with tools before making claims about their contents.
```json
[
  {
    "id": "att_a1b2c3d4",
    "type": "audio",
    "name": "audio.ogg",
    "localPath": "/home/user/.roundhouse/incoming/telegram_c123/1745.../0-audio.ogg",
    "mime": "audio/ogg",
    "sizeBytes": 43520,
    "untrusted": true
  }
]
```

Other agent adapters can format attachments differently — the `AgentMessage.attachments` array provides structured data.

### Voice transcription (STT)

Roundhouse can automatically transcribe voice messages using [OpenAI Whisper](https://github.com/openai/whisper) running locally. No cloud services or API keys required.

**Setup:**
```bash
pip install openai-whisper
```

If whisper/ffmpeg aren't installed when a voice message arrives, roundhouse automatically injects a prompt into the agent's turn asking it to install the missing dependencies. The user is notified that setup is in progress.

**Enable in config:**
```json
{
  "voice": {
    "stt": {
      "enabled": true,
      "mode": "on",
      "chain": ["whisper"],
      "autoTranscribe": {
        "voiceMessages": true,
        "audioFiles": false,
        "maxDurationSec": 120
      },
      "providers": {
        "whisper": {
          "type": "whisper",
          "model": "small",
          "timeoutMs": 30000
        }
      }
    }
  }
}
```

When enabled, voice messages are automatically transcribed before being sent to the agent. The agent sees both the transcript and the raw audio file path:

```json
{
  "id": "att_a1b2c3d4",
  "type": "audio",
  "localPath": "/home/user/.roundhouse/incoming/.../0-audio.ogg",
  "transcript": {
    "text": "This will also work in Hebrew",
    "language": "hebrew",
    "provider": "whisper-small",
    "approximate": true
  }
}
```

For voice-only messages (no typed text), the transcript becomes the message text sent to the agent.

Whisper model sizes: `tiny` (fast, English-only reliable), `base`, `small` (recommended — good multilingual), `medium`, `large` (slow but most accurate).

Transcripts are always marked `approximate: true` — the agent is instructed to use the raw file if exact wording matters.

## Cron Jobs (Scheduled Tasks)

Roundhouse includes a built-in cron scheduler for running agent prompts on a schedule.

### CLI Commands

```
roundhouse cron add <id> [flags]    Create a scheduled job
roundhouse cron list                List all jobs
roundhouse cron show <id>           Show job details + recent runs
roundhouse cron trigger <id>        Run a job now
roundhouse cron runs <id>           Show run history
roundhouse cron edit <id> [flags]   Modify a job
roundhouse cron pause <id>          Disable a job
roundhouse cron resume <id>         Re-enable a job
roundhouse cron delete <id>         Delete a job
```

### Schedule Types

```bash
# Standard cron with timezone
roundhouse cron add daily-report --cron "0 8 * * *" --tz Asia/Jerusalem --prompt "..."

# Fixed interval
roundhouse cron add health-check --every 6h --prompt "..."

# One-shot (relative or absolute)
roundhouse cron add reminder --at 30m --prompt "..."
roundhouse cron add meeting --at 2026-04-28T14:00:00 --tz Asia/Jerusalem --prompt "..."
```

### Notifications

Add `--telegram <chatId>` to send results to Telegram:

```bash
roundhouse cron add aws-costs --cron "0 8 * * *" --tz Asia/Jerusalem \\
  --prompt "Check current AWS costs and summarize." \\
  --telegram 123456789
```

### Telegram Commands

| Command | Description |
|---------|-------------|
| `/crons` or `/jobs` | List all scheduled jobs |
| `/crons trigger <id>` | Run a job now |
| `/crons pause <id>` | Disable a job |
| `/crons resume <id>` | Re-enable a job |

### Conversational Setup

Tell the agent: *"set a cron daily 8am Israel time to give me current AWS costs"* — the agent will run `roundhouse cron add` via its bash tool.

### Heartbeat

Edit `~/.roundhouse/HEARTBEAT.md` with recurring tasks. The scheduler reads it every 30 minutes and runs the instructions as an agent prompt. If the file is empty or contains only the default template, no action is taken.

### Config

Job configs stored as JSON in `~/.roundhouse/crons/`. State in `~/.roundhouse/cron-state/`. Run history in `~/.roundhouse/cron-runs/`.

## Extensions

### Code review extension

The code review extension has moved to its own package: [pi-autoreview](https://github.com/inceptionstack/pi-autoreview). Install it with:

```bash
pi install git:github.com/inceptionstack/pi-autoreview
```

## Adding a new agent backend

1. Create `src/agents/myagent/myagent-adapter.ts` extending `BaseAdapter`
2. Register in `src/agents/registry.ts`
3. Set `"agent": { "type": "myagent" }` in config

```typescript
import type { AgentAdapterFactory, AgentMessage, AgentResponse, AgentStreamEvent } from "../../types.js";
import { BaseAdapter } from "../base-adapter.js";

class MyAgentAdapter extends BaseAdapter {
  readonly name = "myagent";

  async prompt(threadId: string, message: AgentMessage): Promise<AgentResponse> {
    return { text: "response" };
  }

  async *promptStream(threadId: string, message: AgentMessage): AsyncIterable<AgentStreamEvent> {
    yield { type: "text_delta", text: "response" };
    yield { type: "agent_end" };
  }

  async dispose(): Promise<void> {}
}

export const createMyAgentAdapter: AgentAdapterFactory = (config) => new MyAgentAdapter();
```

## Adding a new chat platform

Three small wiring points (the gateway code itself never branches on platform):

1. **Register the SDK adapter factory** in `src/transports/chat-adapters.ts`:
   ```ts
   chatAdapterFactories.discord = async () => {
     const { createDiscordAdapter } = await import("@chat-adapter/discord");
     return (cfg) => createDiscordAdapter({ /* …forward env vars explicitly… */ });
   };
   ```
2. **Implement `TransportAdapter`** in `src/transports/discord/discord-adapter.ts`. The contract (`src/transports/types.ts`) covers `postMessage`, `postRich`, `progress`, `stream`, `notify`, `createThread`, `ownsThread`, `ownsChatId`, `encodeParentThreadId`, `formatNotifySession`, plus pairing hooks. The Slack adapter is the cleanest reference impl.
3. **Add the delegate** in `buildTransportDelegates` (top of `src/gateway/gateway.ts`):
   ```ts
   if (config.discord) delegates.push(new DiscordAdapter());
   ```

The `CompositeTransportAdapter` automatically routes per-thread methods by `ownsThread` and partitions `notify(chatIds, …)` by `ownsChatId`. No changes needed in the gateway's message handler.

## Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point, config loading, startup |
| `src/gateway/gateway.ts` | Owns Chat SDK, wires events → router → agent |
| `src/router.ts` | `AgentRouter` interface + `SingleAgentRouter` |
| `src/types.ts` | Core interfaces: `AgentAdapter`, `AgentStreamEvent`, `AgentRouter`, `GatewayConfig` |
| `src/util.ts` | Pure utilities: `splitMessage`, `isAllowed`, `threadIdToDir`, `startTypingLoop` |
| `src/transports/types.ts` | `TransportAdapter` contract |
| `src/transports/composite.ts` | Multi-transport routing |
| `src/transports/chat-adapters.ts` | Chat SDK adapter factory registry |
| `src/transports/telegram/` | Telegram transport adapter |
| `src/transports/slack/` | Slack transport adapter (socket mode) |
| `src/transports/rich-helpers.ts` | `richMenuToCard`, `stripMarkdownToPlain`, `buildSelectableMenu` |
| `src/cli/cli.ts` | CLI: start, run, install, tui, update, logs, etc. |
| `src/cli/setup/` | `setup --telegram` and `setup --slack` flows |
| `src/cli/env-file.ts` | Shared env file parsing, serialization, and quoting |
| `src/cli/systemd.ts` | Shared systemd service management (unit generation, install, status) |
| `src/cli/launchd.ts` | macOS LaunchAgent management (plist generation, install, status) |
| `src/cli/doctor.ts` | CLI doctor command |
| `src/cli/doctor/runner.ts` | Shared doctor runner (CLI + gateway) |
| `src/cli/doctor/checks/` | Individual health check modules |
| `src/cron/` | Cron scheduler, runner, store, schedule, template, format |
| `src/cron/helpers.ts` | Shared cron constants and utilities |
| `src/agents/pi/pi-adapter.ts` | Pi agent adapter (persistent sessions via pi SDK) |
| `src/agents/kiro/kiro-adapter.ts` | Kiro CLI agent adapter (ACP over stdio) |
| `src/agents/base-adapter.ts` | Abstract base class — adapter interface contract |
| `src/agents/registry.ts` | Agent type → factory registry |
| `src/config.ts` | Shared config loading, defaults, env overrides |
| `test/` | Unit + integration tests (vitest, 678 passing) |

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

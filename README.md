# roundhouse

A multi-platform chat gateway that routes messages through a single configured AI agent.

One gateway instance = one agent target (pi, Kiro, etc.), configured at install time.
Multiple chat inputs (Telegram, Slack, Discord via [Vercel Chat SDK](https://chat-sdk.dev)) all feed into that same agent.

## Install

```bash
npm install -g @inceptionstack/roundhouse
roundhouse setup --slack      # or: roundhouse setup --telegram
roundhouse start              # Auto-starts via LaunchAgent (macOS) or systemd (Linux)
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

### 4. Or run the gateway only, without the bundle (macOS)

`roundhouse setup` also installs skills, CLI tools and extensions. To run just the gateway against a pi you already have:

```bash
git clone https://github.com/inceptionstack/roundhouse.git && cd roundhouse
npm ci --ignore-scripts
ln -s "$PWD/bin/roundhouse.mjs" ~/.local/bin/roundhouse
mkdir -m 700 ~/.roundhouse
# ~/.roundhouse/gateway.config.json  (mode 600): agent + chat.allowedUsers + adapters.telegram
# ~/.roundhouse/.env                 (mode 600): TELEGRAM_BOT_TOKEN="..."
roundhouse pair --user your_username   # tap the link; records your numeric id
roundhouse install                     # LaunchAgent only
```

## Security model

Whoever gets a message accepted by the gateway drives an agent with shell access as the user running it. There is no sandbox.

- **Access is by paired ID.** On Telegram, usernames count only until pairing records an ID, and are matched against the real @username. Once any ID is recorded, names in `allowedUsers` grant nothing, so pair everyone who should get in. An empty allowlist refuses everyone.
- **Slack pairing is weaker than Telegram's.** It has no one-time code: the first Slack user whose display name matches a configured name is paired. Complete Slack pairing right after setup, in a workspace you trust.
- **The agent can read everything its user can**, including `~/.roundhouse/.env`. Run it as a dedicated user, or in a container or VM, if that matters.
- **Content is not instructions, but nothing enforces that.** Files, web pages, attachments and voice transcripts reach the model as text. Keep `soul.md` / `tools.md` explicit about what needs your confirmation.
- **`roundhouse setup` and `/update` install unpinned software** (latest npm packages, a skills repo at its default branch, the uv installer). Set `chat.allowUpdateCommand: false` and use the gateway-only install above on machines where that is not acceptable.

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
  install             Install the service only (LaunchAgent on macOS; no packages)
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
| `chat.allowedUserIds` | Immutable user IDs (Telegram numeric, Slack `Uxxx`); filled in by pairing. Once this has an entry, only these IDs are accepted and usernames are ignored |
| `chat.allowedUsers` | Telegram usernames accepted until an ID is paired, matched against the real @username, never the display name. Ignored once `allowedUserIds` has an entry. On Slack a name never grants access (its "username" is a display name anyone can set): Slack users get in by paired ID only |
| `chat.allowAll` | `true` lets anyone use the bot when both lists are empty. Default: an empty allowlist refuses everyone |
| `chat.dmOnly` | `true` answers in one-to-one chats only (Telegram private chats, Slack direct messages) and ignores groups, channels and topics |
| `chat.bootTurn` | `false` skips the greeting agent turn on every start (default `true`) |
| `chat.allowUpdateCommand` | `false` disables `/update` from chat (default `true`) |
| `chat.notifyChatIds` | Chat IDs to notify on startup (Telegram numeric, Slack `Cxxx`/`Dxxx`) |
| `chat.adapters.telegram` | `{ "mode": "polling" \| "webhook" \| "auto" }` |
| `chat.adapters.slack` | `{ "mode": "socket" }` (v1: socket mode only; tokens via `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` env) |
| `voice.stt.enabled` | Enable automatic voice transcription (default: off unless configured) |
| `voice.stt.chain` | STT provider chain, e.g. `["whisper"]` |
| `voice.stt.providers.whisper` | `{ "model": "small", "timeoutMs": 30000 }` |
| `memory.compact.softPercent` / `hardPercent` | Fractions of the conversation model's context window at which the agent is asked to save memory (default `0.45`) and at which the session is compacted (default `0.60`) |
| `memory.compact.softTokens` / `hardTokens` | Optional absolute caps on the same two thresholds, in tokens. Default: none |
| `memory.compact.models` | Per-model overrides of those four, keyed by `provider/model-id` |
| `memory.compact.flushModel` | Model for the pre-compaction flush and the summary. Default: the conversation model |
| `memory.compact.enabled` | `false` turns roundhouse's proactive compaction off; pi still compacts by itself when the window is nearly full |

### When a conversation is compacted

Compaction summarizes older history so the conversation keeps fitting in the model's context window. Roundhouse does it earlier than pi would, and first asks the agent to save what matters to its memory files.

The thresholds follow the model. With the defaults, a 200K-token model saves memory at 90K and compacts at 120K; a 1M-token model at 450K and 600K. `/status` shows both numbers for the current chat. To keep a large-window model on a tighter budget, cap it:

```json
{
  "memory": {
    "compact": {
      "models": {
        "amazon-bedrock/us.anthropic.claude-opus-5-5": { "softTokens": 250000, "hardTokens": 300000 }
      }
    }
  }
}
```

A larger context costs more per turn, most of all on the first message after a pause long enough for the provider's prompt cache to expire, when the whole conversation is read again at full price.

`flushModel` names a second, usually cheaper model for the flush turn and the summary. For the flush turn it has no prompt cache for the conversation, so it reads all of it again each time (the summary request is uncached whichever model runs it). It is skipped once the conversation is larger than its own window.

While the conversation sits between the two thresholds, the agent is asked to save memory again only after it has grown by a third of the gap between them, and what it writes is not fed back into the conversation.

Roundhouse checks the thresholds between turns. pi's own compaction (`compaction.reserveTokens` in pi's settings) acts inside a turn and does not flush memory first; if you raised that reserve, keep roundhouse's `hardPercent` below the point where pi would act.

Secrets stay in env vars: `TELEGRAM_BOT_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `ANTHROPIC_API_KEY`, etc.

## Joining a session from pi CLI

Sessions are stored at `~/.roundhouse/sessions/<thread>/`. Resume from CLI:

```bash
# Via roundhouse (recommended — auto-discovers sessions)
roundhouse tui

# Or directly via pi
pi --resume ~/.roundhouse/sessions/<thread_dir>/<session>.jsonl
```

Messages from Telegram/Slack and from the CLI share the same context.

## Telegram bot commands

Roundhouse automatically registers these commands with Telegram on startup:

| Command | Description |
|---------|-------------|
| `/new` | Start a fresh conversation. The previous one stays on disk |
| `/model [name]` | Show the models, or switch this conversation and the default to one |
| `/think [level]` | Show or set the thinking level of this conversation |
| `/compact` | Compact session context to free up tokens |
| `/verbose` | Toggle tool status messages on/off for this chat |
| `/status` | Show gateway status: version, agent, model, context usage, uptime, etc. |
| `/cancel` | Stop the current agent run (abort tools, LLM calls, compaction) |
| `/stop [question]` | Stop the current agent run, then have a read-only sub-agent review what it did so far and report here |
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

### `/stop`

Ends the turn in progress the way `/cancel` does, then hands what the agent did so far to a reviewer: a sub-agent that can read and search files and nothing else (`read`, `grep`, `find`, `ls`: no shell, no edits, no MCP, and none of the working directory's `AGENTS.md`/`CLAUDE.md`, prompt templates, themes or project settings, which the agent under review could have written). The reviewer gets the turn as a file (the exchange just before it, so that a request like "yes" can be understood; then your request, what the agent said, each tool call and what came back; long output shortened, every line behind a `│` so tool output cannot pass for the transcript's own structure, and obvious secrets such as bot tokens, API keys, passphrases and private keys removed) and answers in six parts: what was asked, what is done, what was in progress, problems, what is left behind to undo, and a suggestion. Add a question after the command (`/stop why did it touch the router?`) and the reviewer answers that too.

The report is posted in the chat as it is (secrets removed again, and titled with the time of the stop it is about), usually within a minute or two, and **no agent turn starts because of it**: the agent that was stopped does not start working again. With your next message the agent is told that the turn was stopped on purpose, and with the first message after the report arrives it is given the report to weigh as data. Each comes once; they are kept in memory, so a restart drops them, and a stop that you never write after is forgotten after 12 hours.

Edge cases: with nothing running, `/stop` says so. Before the agent has your request in its conversation (it is still fetching an attachment, waiting for the turn before it, or getting ready) there is nothing of the turn to review, and only the stop happens: the request is dropped and never runs (it used to run after the memory save it had been waiting behind), and the agent is then told you cancelled a message it never saw. Every stopped turn gets its own review, up to two running at a time; a third turn stopped while both still run is stopped but not reviewed, and you are told. A second `/stop` on a turn that is already stopped (or was cancelled) and is still winding down tells the agent to stop again and starts nothing else. roundhouse's own memory-save prompt is not taken for a request of yours: a stop while memory is being saved reviews the turn that led to it. A turn so long that its request was compacted away is reviewed from the compaction on, and the transcript says so. If the reviewer fails or runs out of its 10 minutes, you are told, and the turn it was given stays in `~/.roundhouse/subagents/<run>/turn.md`; after a delivered report that file is deleted (the rest of the run folder, with the report in `stdout.log`, stays, mode 0700). `/stop` needs an agent that can describe its turn (pi can; kiro cannot, and is only stopped). The report is posted to the chat, not to a forum topic or Slack thread, so use it in a private chat (`chat.dmOnly`).

### Follow-up notifications

When extensions (e.g. code review) queue follow-up work after the agent responds, the gateway shows:
- ⏳ "Hold on — waiting for follow-up messages..." (after 2s delay)
- ✅ "All done — waiting for your input." (when processing completes)

Fast operations that complete within 2 seconds show no extra messages.

## While the agent is working

Messages are received while a turn runs. Commands about the turn in progress or the gateway (`/cancel`, `/stop`, `/status`, `/model`, `/think`, `/verbose`, `/doctor`, `/crons`, `/restart`, `/later`) are handled at once; `/model` and `/think` answer at once and take effect when the turn ends. Everything else waits its turn in the order sent: ordinary messages, `/new`, `/topic`, `/compact`, and commands meant for the agent.

If the gateway is restarted or dies before it has finished your requests, they are not run again. The next gateway lists the requests that were cut off or still waiting; say "continue" or send them again.

## Prompt cache and long pauses

A conversation is re-read by the model on every turn, and providers discount the part they still have cached. With the default five-minute cache, the first message after a longer pause pays for the whole conversation again, which is what a large context mostly costs in a chat. Setting `PI_CACHE_RETENTION=long` in `~/.roundhouse/.env` asks the provider for its longer cache lifetime (an hour on Anthropic models, direct or on Bedrock) at a higher price for cache writes. For a chat with pauses of minutes rather than seconds it is usually the cheaper setting.

## File attachments

Roundhouse handles voice messages, images, documents, and other file attachments from Telegram:

1. Files are downloaded and saved to `~/.roundhouse/incoming/<thread>/<message>/`. With pi, up to five images per message are also passed to the model directly, so a screenshot is seen without a tool call
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
| `test/` | Unit + integration tests (vitest) |

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

`npm ci` installs a pre-commit hook that blocks commits containing secrets, and CI scans the full git history with gitleaks. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT

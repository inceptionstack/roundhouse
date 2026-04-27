# Architecture

## Overview

Roundhouse is a gateway that sits between **chat platforms** (Telegram, Slack, Discord) and a **single AI agent backend** (pi, Kiro, etc.).

One gateway instance is configured for exactly one agent target at install time. Multiple chat platforms can feed into that same agent simultaneously.

## System diagram

```
                    ┌─────────────────────────────────────────────────────┐
                    │                   Vercel Chat SDK                   │
                    │                                                     │
                    │   ┌────────────┐  ┌────────────┐  ┌─────────────┐  │
  Telegram users ──▶│   │  Telegram  │  │   Slack    │  │   Discord   │  │◀── Discord users
                    │   │  Adapter   │  │  Adapter   │  │   Adapter   │  │
  Slack users ─────▶│   └─────┬──────┘  └─────┬──────┘  └──────┬──────┘  │
                    │         │               │                │         │
                    │         └───────────────┼────────────────┘         │
                    │                         │                          │
                    │    onDirectMessage / onNewMention /                 │
                    │    onSubscribedMessage                              │
                    └─────────────────────────┬──────────────────────────┘
                                              │
                                              ▼
                                  ┌───────────────────────┐
                                  │       Gateway          │
                                  │                        │
                                  │  • User allowlist      │
                                  │  • Message splitting   │
                                  │  • Typing indicators   │
                                  │  • Error handling      │
                                  └───────────┬────────────┘
                                              │
                                              ▼
                                  ┌───────────────────────┐
                                  │     AgentRouter        │
                                  │                        │
                                  │  SingleAgentRouter     │
                                  │  (pass-through today)  │
                                  │                        │
                                  │  Future:               │
                                  │  • MultiAgentRouter    │
                                  │  • UserChoiceRouter    │
                                  │  • FallbackRouter      │
                                  └───────────┬────────────┘
                                              │
                                              ▼
                                  ┌───────────────────────┐
                                  │     AgentAdapter       │
                                  │                        │
                                  │  Configured at install │
                                  │  time via config file  │
                                  │                        │
                                  │  ┌─────────────────┐   │
                                  │  │   Pi Agent      │   │
                                  │  │                 │   │
                                  │  │  • pi SDK       │   │
                                  │  │  • persistent   │   │
                                  │  │    .jsonl       │   │
                                  │  │    sessions     │   │
                                  │  │  • per-thread   │   │
                                  │  │    isolation    │   │
                                  │  └─────────────────┘   │
                                  │                        │
                                  │  (or Kiro, Raw LLM,    │
                                  │   custom agent, etc.)  │
                                  └────────────────────────┘
                                              │
                                              ▼
                                  ┌────────────────────────┐
                                  │   Session storage       │
                                  │                         │
                                  │  ~/.pi/agent/           │
                                  │    gateway-sessions/    │
                                  │      telegram_c<id>/    │
                                  │        <session>.jsonl  │
                                  │      slack_c<id>/       │
                                  │        <session>.jsonl  │
                                  └────────────────────────┘
```

## Data flow

```
User sends "list files" on Telegram
         │
         ▼
┌─ Vercel Chat SDK ────────────────────────────────────────────┐
│  Telegram adapter receives update via polling                │
│  Normalizes to: { thread.id, message.text, message.author } │
│  Fires onDirectMessage(thread, message)                      │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌─ Gateway ────────────────────────────────────────────────────┐
│  1. Check isAllowed(message.author, allowedUsers)            │
│  2. Resolve agent via router.resolve(thread.id)              │
│  3. thread.startTyping()                                     │
│  4. Save attachments to ~/.roundhouse/incoming/<thread>/      │
│  5. Build AgentMessage { text, attachments }                  │
│  6. agent.promptStream(thread.id, agentMessage)               │
│     └─▶ Pi adapter formats text + JSON attachment manifest    │
│     └─▶ Pi SDK creates/resumes session                       │
│         └─▶ LLM processes, tools execute                     │
│         └─▶ Streams AgentStreamEvent back                    │
│  7. Stream text deltas via thread.handleStream()              │
└──────────────────────────────────────────────────────────────┘
                               │
                               ▼
            User receives reply on Telegram
```

## Key interfaces

```typescript
interface AgentMessage {
  text: string;
  attachments?: MessageAttachment[];
}

interface MessageAttachment {
  id: string;
  mediaType: "audio" | "image" | "file" | "video";
  name: string;
  localPath: string;
  mime: string;
  sizeBytes: number;
  untrusted: true;
  transcript?: AttachmentTranscript;
}

interface AttachmentTranscript {
  text: string;
  provider: string;
  language?: string;
  confidence?: number;
  approximate: true;
  status: "completed" | "failed";
  error?: string;
  durationMs?: number;
}

interface AgentAdapter {
  name: string;
  prompt(threadId: string, message: AgentMessage): Promise<AgentResponse>;
  promptStream?(threadId: string, message: AgentMessage): AsyncIterable<AgentStreamEvent>;
  restart?(threadId: string): Promise<void>;
  compact?(threadId: string): Promise<{ tokensBefore: number; tokensAfter: number | null } | null>;
  abort?(threadId: string): Promise<void>;
  getInfo?(threadId?: string): Record<string, unknown>;
  dispose(): Promise<void>;
}

interface AgentResponse {
  text: string;
  metadata?: Record<string, unknown>;
}

interface AgentRouter {
  resolve(threadId: string): AgentAdapter;
  dispose(): Promise<void>;
}
```

## Config model

```
gateway.config.json
├── agent                     # Exactly ONE agent target
│   ├── type: "pi"            # Selects factory from registry
│   ├── cwd: "/home/user"     # Agent working directory
│   └── sessionDir: "..."     # Override session storage
│
└── chat                      # Multiple chat inputs
    ├── botUsername: "my_bot"
    ├── allowedUsers: [...]   # Auth filter (userName or userId)
    ├── notifyChatIds: [...]   # Telegram chat IDs for startup notifications
    └── adapters
        ├── telegram: { mode: "polling" }
        ├── slack: { ... }    # (future)
        └── discord: { ... }  # (future)

└── voice                     # Optional voice features
    └── stt
        ├── enabled: true
        ├── mode: "on" | "off"
        ├── autoInstall: false   # auto-install whisper via pip3
        ├── chain: ["whisper"]    # Provider chain (try in order)
        ├── autoTranscribe
        │   ├── voiceMessages: true
        │   ├── audioFiles: false
        │   └── maxDurationSec: 120
        └── providers
            └── whisper: { model: "small", timeoutMs: 30000 }
```

Secrets (`TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`) are always env vars, never in config.

## Startup sequence

```
1. Load config (--config flag → gateway.config.json → env var defaults)
2. Look up agent.type in registry → get factory function
3. factory(agentConfig) → AgentAdapter instance
4. Wrap in SingleAgentRouter
5. Create Gateway(router, config)
6. gateway.start():
   a. Build Chat SDK adapters from config (lazy import)
   b. Create Chat instance with all adapters
   c. Wire onDirectMessage / onNewMention / onSubscribedMessage → handle()
   d. chat.initialize() — starts polling / webhooks
   e. registerBotCommands() — register /new, /restart, /status with Telegram
   f. notifyStartup() — send Telegram notification to configured notifyChatIds
   g. Start CronSchedulerService — loads jobs, catches up missed runs, ticks every 60s
7. Running. Ctrl+C → gateway.stop() → router.dispose() → agent.dispose()
```

## Session threading

Each chat platform thread gets its own agent session:

```
Telegram DM with Alice    →  threadId = "telegram:123456789"  →  session A
Slack DM with Alice       →  threadId = "slack:U12345"         →  session B
Telegram group mention  →  threadId = "telegram:-100123456"  →  session C
```

These are **separate sessions** by design. Cross-platform session unification (mapping multiple platform identities to one session) is a future capability.

Sessions persist as `.jsonl` files. The gateway resumes them on restart. Pi CLI can join any session with:

```bash
pi --resume ~/.pi/agent/gateway-sessions/<thread_dir>/<session>.jsonl
```

## Router extensibility

The `AgentRouter` interface is a seam for future multi-agent routing:

| Router | Behavior |
|--------|----------|
| `SingleAgentRouter` | All threads → one agent (current) |
| `MultiAgentRouter` | Map thread prefixes to different agents |
| `UserChoiceRouter` | User sends `/agent kiro` to switch |
| `FallbackRouter` | Try primary agent, fall back to secondary |
| `RoundRobinRouter` | Load balance across agent instances |

The gateway and agent adapters don't change — only the router.

## Module dependency graph

```
index.ts
  ├── config.ts (loadConfig, applyEnvOverrides)
  ├── agents/registry.ts
  │     └── agents/pi.ts
  │           └── util.ts (threadIdToDir)
  ├── router.ts
  ├── gateway.ts
  │     └── util.ts (splitMessage, isAllowed, threadIdToDir, generateAttachmentId)
  │     └── voice/stt-service.ts
  │           └── voice/providers/whisper.ts
  │           └── voice/types.ts
  └── types.ts (shared interfaces, pure types only)

cli/cli.ts
  ├── config.ts (DEFAULT_CONFIG, CONFIG_PATH, loadConfig, etc.)
  ├── agents/registry.ts (getAgentSdkPackage)
  ├── cli/doctor.ts → cli/doctor/runner.ts → cli/doctor/checks/*
  ├── cli/cron.ts → cron/store.ts, cron/runner.ts, cron/helpers.ts
  └── (node:fs, node:child_process for daemon management)

gateway.ts also imports:
  → cli/doctor/runner.ts for /doctor command
  → cron/scheduler.ts → cron/runner.ts → cron/store.ts
  → cron/helpers.ts, cron/format.ts
  → notify/telegram.ts
```

No circular dependencies. `types.ts` and `config.ts` are pure leaf modules.
`util.ts` is a leaf module with runtime helpers (`node:crypto` for attachment IDs).

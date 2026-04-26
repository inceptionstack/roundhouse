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
│  4. agent.prompt(thread.id, "list files")                    │
│     └─▶ Pi SDK creates/resumes session                       │
│         └─▶ LLM processes, tools execute                     │
│         └─▶ Returns AgentResponse { text: "..." }            │
│  5. splitMessage(response.text, 4000)                        │
│  6. thread.post(chunk) for each chunk                        │
└──────────────────────────────────────────────────────────────┘
                               │
                               ▼
            User receives reply on Telegram
```

## Key interfaces

```typescript
interface AgentAdapter {
  name: string;
  prompt(threadId: string, text: string): Promise<AgentResponse>;
  promptStream?(threadId: string, text: string): AsyncIterable<AgentStreamEvent>;
  restart?(threadId: string): Promise<void>;
  getInfo?(): Record<string, unknown>;
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
  │     └── util.ts (splitMessage, isAllowed)
  └── types.ts (shared interfaces)

cli/cli.ts
  ├── config.ts (DEFAULT_CONFIG, CONFIG_PATH, loadConfig, etc.)
  ├── agents/registry.ts (getAgentSdkPackage)
  └── (node:fs, node:child_process for daemon management)
```

No circular dependencies. `util.ts`, `types.ts`, and `config.ts` are leaf modules.

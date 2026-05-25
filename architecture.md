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
  readonly name: string;
  prompt(threadId: string, message: AgentMessage): Promise<AgentResponse>;        // required
  promptStream(threadId: string, message: AgentMessage): AsyncIterable<AgentStreamEvent>; // required
  dispose(): Promise<void>;                                                       // required
  promptWithModel?(threadId: string, message: AgentMessage, modelId: string): Promise<AgentResponse>;
  restart?(threadId: string): Promise<void>;
  compact?(threadId: string): Promise<{ tokensBefore: number; tokensAfter: number | null } | null>;
  compactWithModel?(threadId: string, modelId: string): Promise<{ tokensBefore: number; tokensAfter: number | null } | null>;
  abort?(threadId: string): Promise<void>;
  getInfo?(threadId?: string): Record<string, unknown>;
}

// New adapters extend BaseAdapter (src/agents/base-adapter.ts) which
// provides default implementations for optional methods.
// Each adapter lives in its own directory: pi/pi-adapter.ts, kiro/kiro-adapter.ts

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
        ├── slack: { mode: "socket" }   # SLACK_BOT_TOKEN/SLACK_APP_TOKEN env
        └── discord: { ... }             # (future)

└── voice                     # Optional voice features
    └── stt
        ├── enabled: true
        ├── mode: "on" | "off"
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
Slack DM with Alice       →  threadId = "slack:D12345:"        →  session B
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

## Transport composition

A single gateway can run multiple chat platforms concurrently (Telegram + Slack today). The wiring:

```
                     ┌────────────────────────────────────────────┐
                     │  CompositeTransportAdapter (this.transport) │
                     │                                            │
                     │  delegates: [TelegramAdapter, SlackAdapter] │
                     └─────────────┬───────────────┬──────────────┘
                                   │               │
                ownsThread/ownsChatId routing      │
                                   ▼               ▼
                     ┌────────────────────┐  ┌────────────────────┐
                     │  TelegramAdapter   │  │   SlackAdapter      │
                     │                    │  │                     │
                     │  ownsThread:       │  │  ownsThread:        │
                     │   adapter.tg-      │  │   id startsWith     │
                     │   Fetch present    │  │   "slack:"          │
                     │  ownsChatId: numeric│  │  ownsChatId: C/D/G/U │
                     └────────────────────┘  └────────────────────┘
```

Routing rules implemented in `src/transports/composite.ts`:

| Method | Routing |
|--------|---------|
| `postMessage`, `postRich`, `progress`, `stream`, `enrichPrompt` | by `ownsThread(thread)` |
| `notify(chatIds, …)` | partition by `ownsChatId`, fan out |
| `createThread(chatId)` | by `ownsChatId` |
| `encodeParentThreadId`, `formatNotifySession` | by `ownsChatId` |
| `registerCommands`, `dispose` | fan out to all delegates |
| `handlePairing` | first delegate that returns non-null; result tagged with delegate name so the gateway tracks `pairingComplete` per-transport |
| `shouldIgnoreMessage` | by `ownsThread` (Telegram drops `/start`, Slack has no equivalent) |

The gateway code reads `this.transport.foo()` and never branches on platform; adding a third transport is a TransportAdapter implementation + one entry in `chatAdapterFactories` + one entry in `buildTransportDelegates`.

ID types are heterogeneous union `(string | number)[]` to support both numeric (Telegram) and string (Slack `Uxxx`/`Cxxx`) identifiers in the same allowlist / notify list.

## Module dependency graph

```
src/
├── index.ts                         # Entry: loads config → creates agent → starts gateway
│   ├── config.ts                    # loadConfig, applyEnvOverrides, path constants
│   ├── router.ts                    # SingleAgentRouter (future: Multi/Fallback/UserChoice)
│   ├── types.ts                     # AgentAdapter, AgentMessage, AgentStreamEvent interfaces
│   └── agents/
│       ├── registry.ts              # Agent factory lookup, adapter definitions
│       ├── base-adapter.ts          # BaseAdapter abstract class (shared defaults)
│       ├── index.ts                 # Barrel re-export
│       ├── pi/
│       │   ├── pi-adapter.ts        # Pi factory: sessions, prompt/stream, lifecycle
│       │   └── message-format.ts    # Pure: formatMessage, extractCustomMessage
│       └── kiro/
│           ├── kiro-adapter.ts      # Kiro class: ACP protocol, tool dispatch
│           ├── session.ts           # Session lifecycle
│           ├── tool-names.ts        # Tool name mapping
│           └── acp/                 # Agent Communication Protocol client
│               ├── client.ts
│               ├── process.ts
│               ├── types.ts
│               └── index.ts
│
├── gateway.ts                       # Gateway class: chat SDK wiring, handleAgentTurn
│   ├── gateway/
│   │   ├── commands.ts              # 9 command handlers (/new, /stop, /status, etc.)
│   │   ├── streaming.ts            # Agent event → Telegram message stream mapper
│   │   ├── attachments.ts          # File save, validation, size limits
│   │   ├── helpers.ts              # isCommand, resolveAgentThreadId, getSystemResources, toolIcon
│   │   └── index.ts                # Barrel re-export
│   ├── cron/scheduler.ts            # Tick loop, catch-up, job dispatch
│   ├── memory/                      # Session memory hooks (flush, compact, inject)
│   └── voice/
│       ├── stt-service.ts           # STT orchestration (provider chain)
│       └── providers/whisper.ts     # Whisper CLI provider
│
├── cli/
│   ├── cli.ts                       # CLI dispatcher: start/stop/status/logs/doctor/cron/setup
│   ├── agent-command.ts             # `roundhouse agent` — one-shot prompt pipeline
│   ├── service-manager.ts           # ServiceManager interface + Launchd/Systemd impls
│   ├── shell.ts                     # Shell execution utilities
│   ├── cron.ts                      # Thin dispatcher → cron-commands.ts
│   ├── cron-commands.ts             # 10 cron command handlers (add/list/show/trigger/...)
│   ├── detect.ts                    # Agent environment detection
│   ├── env-file.ts                  # .env parser/serializer
│   ├── systemd.ts                   # systemd unit generation, systemctl wrappers
│   ├── launchd.ts                   # macOS plist generation, launchctl wrappers
│   ├── setup.ts                     # Setup dispatcher (300 lines): cmdSetup, cmdPair, help
│   ├── setup/
│   │   ├── steps.ts                 # 11 step functions (preflight → postflight)
│   │   ├── flows.ts                 # Interactive + non-interactive orchestrators
│   │   ├── runtime.ts               # Agent resolution, StepLog bridge
│   │   ├── args.ts                  # Argument parser
│   │   ├── helpers.ts               # Atomic writes, exec wrappers
│   │   ├── types.ts                 # SetupOptions, StepLog interface
│   │   ├── prompts.ts               # TTY prompt helpers (text, masked, choice)
│   │   ├── logger.ts                # JSON/text logger for non-interactive diagnostics
│   │   ├── telegram.ts              # Telegram API: validate token, pair, register commands
│   │   └── index.ts                 # Barrel export
│   ├── qr.ts                        # QR code generation for pairing links
│   └── doctor/                      # Health checks (8 check modules + runner)
│
├── cron/                            # Cron job engine
│   ├── store.ts                     # Job CRUD, run history persistence
│   ├── runner.ts                    # Execute job → agent prompt → record result
│   ├── scheduler.ts                 # Tick loop with catch-up
│   ├── schedule.ts, durations.ts    # Parsing: cron expressions, intervals
│   ├── template.ts                  # Variable substitution in prompts
│   ├── format.ts, helpers.ts        # Display formatting, validation
│   ├── constants.ts, types.ts       # Shared constants and interfaces
│
├── memory/                          # Roundhouse-managed session memory
│   ├── lifecycle.ts                 # Flush/compact orchestration
│   ├── policy.ts                    # Pressure detection, token thresholds
│   ├── prompts.ts                   # LLM prompts for summarization
│   ├── files.ts                     # Memory file I/O
│   ├── bootstrap.ts, inject.ts      # Session bootstrapping, context injection
│   ├── state.ts, types.ts           # State tracking, interfaces
│
├── transports/                      # Transport adapter layer
│   ├── types.ts                     # TransportAdapter interface + PairingResult
│   ├── index.ts                     # Barrel export
│   └── telegram/                    # Telegram implementation
│       ├── telegram-adapter.ts      # TelegramAdapter (implements TransportAdapter)
│       ├── format.ts                # Markdown → Telegram HTML converter
│       ├── html.ts                  # HTML streaming + entity utilities
│       ├── progress.ts              # Typing indicator + progress edits
│       ├── bot-commands.ts          # Bot command definitions
│       ├── pairing.ts               # Nonce-based Telegram pairing protocol
│       └── notify.ts                # Send messages to notify chat IDs
│
├── provisioning/
│   └── bundle.ts                    # Skill/extension bundle provisioning
│
└── util.ts                          # Runtime helpers (crypto, path)
```

**Repo-root directories (outside `src/`):**
```
skills/                              # Bundled skills (shipped in package)
├── roundhouse-cron/SKILL.md         # Cron job skill for pi
└── pr-merge-discipline/SKILL.md    # PR merge workflow skill
```

**Dependency rules:**
- No circular dependencies
- `types.ts`, `config.ts`, `util.ts` are pure leaf modules
- `provisioning/bundle.ts` is a leaf (only `node:*` imports)
- Gateway modules (`gateway/*.ts`) import from `../transports` (via TransportAdapter interface), `../types`, `../config`, `../util`, `../memory/*`
- Gateway holds a `TransportAdapter` instance — all platform-specific operations go through this interface
- `transports/telegram/progress.ts` is still imported directly by gateway (deferred from adapter extraction)
- `gateway/streaming.ts` imports `transports/telegram/html.ts` directly (deferred — streaming is tightly coupled to Telegram HTML wire format)
- `cron/runner.ts` imports `transports/telegram/notify` directly (deferred — will route through adapter when multi-transport lands)
- CLI modules never import from `gateway/` (separation of concerns)
- CLI setup modules (`cli/setup/*.ts`) import from `transports/telegram/` directly (by design — setup is inherently transport-specific)
- Agent adapters depend on their SDK + `../../types`, `../../config`, `../../util`

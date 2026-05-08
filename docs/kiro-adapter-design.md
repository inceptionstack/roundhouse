# Kiro CLI Adapter for Roundhouse — Design & Implementation Guide

**Audience:** a coding agent with access to this repo (roundhouse) but no access to other
kiro-cli integrations. The goal is to add `src/agents/kiro.ts` (and friends) so that
`"agent": { "type": "kiro" }` in `gateway.config.json` works end-to-end and reaches as
close to parity with the Pi adapter as kiro-cli's API allows.

This document is the spec. It encodes every non-obvious lesson required to make kiro-cli
behave well under a chat gateway — lessons that are expensive to learn by trial and error,
especially around event synthesis, hook lifetimes, tool-name prefixes, and process
hygiene. Read it end-to-end before writing code.

---

## 1. Mission

Roundhouse today speaks to Pi via `@mariozechner/pi-coding-agent`'s in-process SDK. We
want it to also speak to **kiro-cli** — a subprocess CLI that exposes its LLM session
over **ACP (Agent Control Protocol)**, a JSON-RPC-over-stdio protocol.

Unlike Pi, kiro-cli cannot be loaded as a library. The adapter must:

1. Spawn `kiro-cli` as a child process per session.
2. Drive it over ACP (JSON-RPC newline-delimited on stdin/stdout).
3. Translate ACP events into Roundhouse's `AgentStreamEvent` union.
4. Install and maintain `~/.kiro/agents/roundhouse.json` so kiro-cli loads with the
   right model, allowlists, MCP servers, and hooks.
5. Re-implement, on the gateway side, every behavior that Pi gives us for free but that
   kiro-cli either doesn't expose or exposes asymmetrically — most importantly the hook
   event lifecycle.

### Non-goals

- **No Pi-feature emulation.** Features that kiro-cli simply cannot do (tool-input
  mutation, tool-result mutation, custom tool registration inside the CLI, custom
  slash commands, pi-style extension `custom_message` bubbles, `draining`/follow-up
  messages) are documented as gaps. Do not try to fake them.
- **No breaking changes to the `AgentAdapter` interface.** If the shape doesn't fit,
  prefer a no-op implementation over widening `src/types.ts`.

---

## 2. What kiro-cli is, from the outside

You only need to know these facts. You do not need to understand kiro-cli internals.

- **Invocation:** `kiro-cli chat --agent <name> --acp` starts a long-running process
  that speaks ACP over stdio. `<name>` refers to an agent config at
  `~/.kiro/agents/<name>.json`.
- **Installation:** `kiro-cli` is distributed as a standalone binary. Roundhouse's
  setup flow must verify it's on `PATH`. It is not on npm; surface a clear error if
  missing and point at the kiro-cli install docs.
- **Transport:** each line on stdout is a JSON-RPC message (request, response, or
  notification). Each line on stdin is a JSON-RPC message from us. Content-Length
  framing is **not** used — plain newlines.
- **Session lifetime:** one kiro-cli process can host multiple sessions via
  `session/new` / `session/load`, keyed by a `sessionId` it returns. A session stays
  alive until the process exits or `session/cancel` is issued.

### ACP methods you will call

| Method | Purpose |
|---|---|
| `initialize` | Handshake. Send first. Receive protocol capabilities. |
| `session/new` | Create a session. Returns a `sessionId`. |
| `session/load` | Resume by id (optional — see §9 on persistence). |
| `session/prompt` | Send the user's text. Streams events back. |
| `session/cancel` | Abort the in-flight turn. |
| `_kiro.dev/commands/execute` | Run a built-in slash command such as `/compact`. |
| `permission/response` | Reply `approved`/`rejected` to a permission request. |

### ACP notifications/events you will receive

Normalize them into this internal union before mapping to `AgentStreamEvent`:

| ACP event (conceptual) | Description |
|---|---|
| `text_chunk` | Streamed assistant text. Accumulate for `prompt()`; forward as delta for `promptStream()`. |
| `thinking_chunk` | Optional reasoning trace. Drop by default; expose behind a verbose flag later. |
| `tool_call` | Tool is about to run (after permission). Has `title`, `tool_call_id`, `tool_input`, `tool_kind`. |
| `tool_result` | Tool finished. Has `tool_call_id`, `output`, `exit_code`. |
| `permission_request` | Kiro is asking whether a tool may run. You decide, then reply. |
| `complete` | Turn finished. Carries `stop_reason`: `end_turn`, `cancelled`, `max_turns`, `error`. |
| `session/update` | Assorted metadata (context usage, model switches). Track for `getInfo`. |

**Critical fact:** ACP does **not** emit events for `AgentSpawn`, `UserPromptSubmit`,
`PreToolUse`, `PostToolUse`, or `Stop`. Those are kiro-cli **hook** concepts that fire
inside the CLI process and are invisible to you. You must **synthesize** them
gateway-side. See §5.

---

## 3. Kiro hooks, in one page

kiro-cli supports five hook events, configured per-agent in the agent's JSON config
file at `~/.kiro/agents/<name>.json` under a `"hooks"` key:

```json
{
  "hooks": {
    "agentSpawn":       [ { "command": "/abs/path/hook.sh" } ],
    "userPromptSubmit": [ { "command": "/abs/path/hook.sh" } ],
    "preToolUse":       [ { "matcher": "execute_bash", "command": "/abs/path/hook.sh" } ],
    "postToolUse":      [ { "matcher": "*",            "command": "/abs/path/hook.sh" } ],
    "stop":             [ { "command": "/abs/path/hook.sh" } ]
  }
}
```

### Wire contract (same for all events)

- Hook receives a **JSON event on stdin**:
  ```json
  {
    "hook_event_name": "PreToolUse",
    "cwd": "/absolute/working/dir",
    "prompt": "<for UserPromptSubmit only>",
    "tool_name": "<for PreToolUse/PostToolUse>",
    "tool_input": { },
    "tool_response": { }
  }
  ```
- **Exit 0** → success. Stdout is captured; for `AgentSpawn` and `UserPromptSubmit`,
  kiro-cli injects stdout into the LLM's context. For `PreToolUse`, exit 0 means
  "allow". For `Stop` and `PostToolUse`, stdout is informational only.
- **Exit 2** → (PreToolUse only) **block** the tool. Stderr is returned to the LLM
  as the reason.
- **Other exit codes** → warning logged; tool proceeds as normal.
- Default timeout **30 s**; past that kiro-cli kills the hook.

### Tool-name matcher syntax

`matcher` is a string, interpreted by kiro-cli with these forms:

- `"read"`, `"execute_bash"` — canonical tool names
- `"shell"` is an alias for `"execute_bash"`
- `"@git"` — all tools from the `git` MCP server
- `"@git/status"` — a specific MCP tool
- `"@builtin"` — all built-in tools
- `"*"` — all tools
- missing/empty → all tools (for tool-hook events)

### What Kiro hooks cannot do

Compared to Pi extensions, hooks **cannot**:

- mutate tool input or tool output
- register new tools or slash commands
- emit arbitrary custom messages to the user
- maintain state (each hook invocation is a new process)
- access any in-CLI API — they only observe + optionally block

Anything in that list must happen **inside Roundhouse** (the adapter or gateway),
not inside kiro-cli. That shapes the rest of this document.

---

## 4. Adapter contract and file layout

### Files to create

```
src/agents/kiro.ts                       # AgentAdapterFactory + AgentAdapter impl (top-level)
src/agents/kiro/acp/client.ts            # JSON-RPC stdio transport, request/response/notify
src/agents/kiro/acp/types.ts             # Discriminated union of ACP events, stop reasons
src/agents/kiro/acp/process.ts           # Spawn, stderr scrape, exit handling, orphan guard
src/agents/kiro/session.ts               # SessionEntry (sessionId, lastUsed, inFlight), reaper
src/agents/kiro/install-config.ts        # Read/write ~/.kiro/agents/roundhouse.json, merge hooks
src/agents/kiro/hooks/manager.ts         # In-process HookManager: auto-approve/deny/auto-reply/transforms
src/agents/kiro/hooks/store.ts           # ScriptHookStore persisted to ~/.roundhouse/kiro-hooks.json
src/agents/kiro/hooks/runner.ts          # runScriptHook: spawn shell, pipe JSON stdin, enforce timeout
src/agents/kiro/hooks/security.ts        # isSensitivePath, isDeniedCommand, validateHookCommand
src/agents/kiro/tool-names.ts            # normalize "Running: <x>" / "Reading <x>" titles
src/agents/kiro/context-usage.ts         # parse token counters from session/update events
```

### Registry wiring (`src/agents/registry.ts`)

```ts
import { createKiroAgentAdapter } from "./kiro";

definitions.set("kiro", {
  type: "kiro",
  name: "Kiro",
  factory: createKiroAgentAdapter,
  available: true,
  packages: [
    { name: "Kiro CLI", packageName: "kiro-cli", install: "global", binary: "kiro-cli" },
  ],
  sdkPackage: undefined, // not on npm; kiro-cli binary is a prereq
  configDefaults: { cwd: homedir() },
  configDirs: [
    resolve(homedir(), ".kiro", "agents"),
    resolve(homedir(), ".kiro", "settings"),
  ],
});
```

### `AgentAdapter` method mapping

All methods follow the Pi adapter's `threadQueues` pattern: one `enqueue(threadId, …)`
per call so overlapping prompts on the same thread serialize. Kiro sessions, like Pi
sessions, are not safe for concurrent prompts.

| Adapter method | Implementation |
|---|---|
| `name` | `"kiro"` |
| `prompt(threadId, msg)` | enqueue → `doPrompt` → subscribe to ACP events → accumulate `text` → return `AgentResponse` |
| `promptStream(threadId, msg)` | enqueue → async-iterable factory that yields `AgentStreamEvent`s as ACP events arrive |
| `abort(threadId)` | `session/cancel`; adapter also aborts any in-flight hooks |
| `restart(threadId)` | dispose session, kill the process if it hosts only this session, drop the map entry |
| `compact(threadId)` | `_kiro.dev/commands/execute` with `/compact`, parse result, return `{ tokensBefore, tokensAfter }` |
| `compactWithModel(threadId, modelId)` | see §10 — requires a secondary flush agent |
| `promptWithModel(threadId, msg, modelId)` | see §10 |
| `getInfo(threadId?)` | see §11 |
| `dispose()` | close all sessions, clear maps, clear reaper interval |

### `AgentStreamEvent` mapping

| ACP event | Stream event emitted | Notes |
|---|---|---|
| `text_chunk` | `{ type: "text_delta", text }` | |
| `thinking_chunk` | *drop* | (future: stream behind a flag) |
| `permission_request` | *(no stream event yet)* | first fire `PreToolUse` hooks; on exit 2 reject; on exit 0 approve; then ACP will send `tool_call` |
| `tool_call` | `{ type: "tool_start", toolName: normalize(title), toolCallId }` | `toolName` must be normalized (§6) |
| `tool_result` | `{ type: "tool_end", toolName, toolCallId, isError: exitCode !== 0 }` | after emission, fire `PostToolUse` hooks |
| `complete` (`end_turn`) | `{ type: "turn_end" }` → fire `Stop` hooks → `{ type: "agent_end" }` | in that order |
| `complete` (`cancelled`/`error`/`max_turns`) | `{ type: "agent_end" }` | no `Stop` hook for cancelled; log and emit |

**Do not emit** `custom_message`, `draining`, or `drain_complete` for kiro. The
gateway's `handleStreaming` switch already ignores unknown types.

---

## 5. Hook event synthesis — the central insight

This is the single most important lesson in this document.

**ACP does not emit hook events to the client.** kiro-cli fires its own bundled +
user-configured hooks inside the CLI process. The client (us) cannot observe those
firings. But Roundhouse needs hook-like extensibility for its own ecosystem — otherwise
the Kiro adapter is strictly less capable than the Pi adapter.

### The two-layer hook model

Build **two parallel hook systems**, both using the same Kiro-shaped JSON event and
exit-code contract from §3.

#### Layer A — Script hooks inside kiro-cli (written to `~/.kiro/agents/<name>.json`)

- Configured at install time.
- Bundled hooks (shipped with roundhouse) + user hooks (from `gateway.config.json`)
  get merged and written to the agent JSON.
- These fire inside kiro-cli. Side-effects (audit logs, metrics) are observable only
  by looking at their outputs.
- Use this layer for things that **must** run in kiro-cli's process context, e.g.
  writing to files that kiro-cli's own tools later read, or blocking a tool before
  kiro-cli even constructs the approval request.

#### Layer B — Script hooks inside Roundhouse (persisted to `~/.roundhouse/kiro-hooks.json`)

- Registered at runtime by the user via a CLI or dashboard (future) — for now just
  read the JSON file on startup.
- Fire on events **synthesized** in the adapter:

| Layer B event | When the adapter fires it |
|---|---|
| `AgentSpawn` | Immediately after `session/new` succeeds for a new thread |
| `UserPromptSubmit` | Before `session/prompt`, with the user's text |
| `PreToolUse` | On every `permission_request`, before replying |
| `PostToolUse` | On every `tool_result` |
| `Stop` | On `complete` with stop_reason=`end_turn`, before emitting `agent_end` |

- **Exit 0 stdout** for `AgentSpawn` / `UserPromptSubmit` is injected into the next
  prompt like this (preserve these exact delimiters — they let the LLM distinguish
  injected context from user input):
  ```
  [Hook context]
  <stdout of first hook>

  <stdout of second hook>
  [End hook context]

  <original user message>
  ```
- **Exit 2 on `PreToolUse`** in Layer B causes the adapter to send
  `permission/response` with `rejected` and broadcast a tool-blocked message. The
  `tool_call` event that would have followed is never emitted.
- **Stderr on exit 2** is surfaced to the LLM as the rejection reason (piped back
  through the `permission/response` payload).
- `PostToolUse` and `Stop` stdout is logged but not injected.

#### Why both layers?

Layer A is the only way to block a tool when Roundhouse is not running (cron jobs,
standalone kiro-cli invocations). Layer B is the only way to hook events in a chat
context, because kiro-cli doesn't give the client a PreToolUse signal — only a
permission request — so we synthesize the event ourselves at that synthesis point.

### The `HookManager` on top of Layer B

Roundhouse should also implement an **in-process HookManager** that operates on the
same stream but without spawning subprocesses. It handles things that don't need a
shell script:

- **auto_approve_tools** — patterns (`"@git/*"`, `"read"`, `"*contains*"`); matches
  short-circuit permission requests with `approved` and no user prompt
- **auto_deny_tools** — always-enforced deny list for dangerous commands
- **auto_replies** — message patterns that reply directly, skipping kiro-cli
- **transforms** — prefix/suffix prepend to matched messages
- **context_rules** — keyword triggers that inject a static block

Config lives in `gateway.config.json` under `agent.hooks`:

```json
{
  "agent": {
    "type": "kiro",
    "hooks": {
      "auto_approve_tools": ["read", "grep", "glob", "@builtin"],
      "auto_deny_tools":    ["rm -rf /*", "git push.*--force.*"],
      "auto_replies":       [ { "pattern": "ping", "reply": "pong", "exact": true } ],
      "transforms":         [ { "pattern": "deploy", "prefix": "[DEPLOY]" } ],
      "context_rules":      [ { "triggers": ["aws", "ec2"], "context": "Default region is us-east-1." } ]
    }
  }
}
```

Evaluation order: **auto-deny** overrides **auto-approve**; auto-reply → transforms →
context rules → Layer B hooks.

---

## 6. Tool-name normalization (the hidden footgun)

kiro-cli ACP decorates tool titles with human-friendly prefixes before emitting
`tool_call`:

- `execute_bash` → title looks like `"Running: ls -la /etc"`
- `fs_read` / `ReadFile` → title looks like `"Reading /etc/hosts"`

If you match matchers like `"execute_bash"` or `"ls"` against the raw title, they
will never hit. You must normalize both the title and the matcher.

```ts
const TITLE_PREFIXES = ["Running: ", "Reading "];

export function normalizeToolName(raw: string): string {
  for (const p of TITLE_PREFIXES) if (raw.startsWith(p)) return raw.slice(p.length);
  return raw;
}

export function toolMatches(pattern: string, name: string): boolean {
  if (pattern === "*") return true;
  // fnmatch-style: prefix*, *suffix, *contains*
  return fnmatch(name.toLowerCase(), pattern.toLowerCase());
}
```

**Always match against both** the raw title *and* the normalized name, so patterns
like `"Running: *"` continue to work for users who grep verbosely.

---

## 7. Config file we write — `~/.kiro/agents/roundhouse.json`

The install-config builder is responsible for producing this file. It is the only
handshake point between roundhouse and kiro-cli's policy engine.

```jsonc
{
  "name": "roundhouse",
  "description": "Roundhouse chat-gateway agent",
  "model": "<provider/model-id chosen at setup>",
  "tools": [ "execute_bash", "fs_read", "fs_write", "grep", "glob", "web_fetch", "web_search" ],
  "allowedTools": [ "fs_read", "grep", "glob", "web_fetch", "web_search" ],
  "toolsSettings": {
    "execute_bash": { "autoAllowReadonly": true, "deniedCommands": [ /* see §7.1 */ ] },
    "shell":        { "deniedCommands": [ /* same list */ ] }
  },
  "includeMcpJson": false,
  "mcpServers": { /* optional, see §13 */ },
  "hooks": { /* merged bundled + user, see §8 */ }
}
```

### 7.1 Denied-commands list

Treat security-critical fields as **non-overridable by user config**. Always use the
bundled defaults, even if a project-level override exists. A minimum baseline the
adapter should ship with (extend as needed):

- credential exfiltration: `.*echo.*\$AWS_(SECRET|ACCESS|SESSION).*`, `.*printenv.*AWS.*`
- SSM/metadata: `.*curl.*169\.254\.169\.254.*`
- destructive AWS: `aws .* delete-.*`, `aws s3 rb.*`, `aws s3 rm.*`
- destructive fs: `rm -rf /.*`, `rm -rf ~.*`, `dd if=.*`, `mkfs.*`
- destructive git: `git push.*--force.*`, `git reset --hard.*`
- package/infra: `terraform destroy.*`, `cdk destroy.*`, `pulumi destroy.*`
- IAM: `aws iam (create-access-key|delete-.*).*`

Mirror the list under both `execute_bash` and `shell` keys.

---

## 8. User-defined `kiro_hooks` merge rules

Users can declare hooks in `~/.roundhouse/gateway.config.json`:

```json
{
  "agent": {
    "type": "kiro",
    "kiro_hooks": {
      "preToolUse": [ { "matcher": "*", "command": "/abs/path/audit.sh" } ]
    }
  }
}
```

The install-config builder merges these into the agent JSON. Merge rules (**do not
skip**, these are security-critical):

1. **Bundled hooks always first, always present.** User hooks are appended. Users
   cannot remove bundled hooks — only add alongside.
2. **Valid events only:** `preToolUse`, `postToolUse`, `userPromptSubmit`,
   `agentSpawn`, `stop`. Unknown event types → warn and skip.
3. **Dedupe by `(command, matcher)`** tuple — the same hook must not be written twice.
4. **Validate `command`:**
   - must be a non-empty string
   - must match regex `^[a-zA-Z0-9/_.-]+$` (no shell metacharacters)
   - must be an absolute path
   - resolve symlinks with `realpath`, then reject if the resolved path is inside a
     sensitive location (see §8.1)
   - reject if the file doesn't exist or isn't a regular file
5. **Validate `matcher`:** optional, but if present must be a string, max 200 chars,
   match regex `^[a-zA-Z0-9_.*\-]+$`.
6. **Caps:** at most 10 user hooks per event; at most 20 user hooks total. Warn
   loudly when a cap is hit; do not silently drop.
7. **Strip unknown fields** — keep only `command` and `matcher`. Users may try to
   inject `timeout_ms: 0` or other fields; reject everything else.
8. **Atomic write** — write to a tempfile then rename.

### 8.1 Sensitive paths

Reject hook commands under any of:

```
~/.ssh, ~/.aws, ~/.gnupg, ~/.gpg, ~/.netrc, ~/.git-credentials,
~/.npmrc, ~/.pypirc, ~/.docker/config.json, ~/.kube/config,
~/.roundhouse/.env
```

Also reject `/etc/shadow`, `/etc/passwd`, `/etc/sudoers*`, and anything under
`/proc/` or `/sys/`. The same function (`isSensitivePath`) should guard file reads
from any other adapter code.

### 8.2 Security audit logging

Every merge attempt (accepted or rejected) should append a structured line to
`~/.roundhouse/logs/hook-merge-audit.jsonl` so a user can later ask "why isn't my
hook running?" and find the rejection reason.

---

## 9. Session persistence across gateway restarts

Pi uses `.jsonl` session files resumable via `SessionManager.continueRecent`. Kiro's
ACP uses `sessionId` strings that are process-scoped: when kiro-cli restarts,
previous IDs are gone.

**Strategy:**

- Persist `sessionId` per thread at `~/.roundhouse/sessions/<threadIdToDir>/kiro.json`
  alongside `{ sessionId, createdAt, lastUsed }`.
- On gateway startup, do **not** pre-create sessions. Wait for the first prompt on
  each thread, then:
  1. Spawn kiro-cli (if no process yet).
  2. Try `session/load` with the persisted id.
  3. On failure (id not found), `session/new`, persist the new id, fire
     `AgentSpawn` hooks.
- If kiro-cli versions change and `session/load` always fails, that's a known
  limitation — equivalent to a new session every restart. Document it; don't try to
  emulate durable sessions.

Reuse `threadIdToDir` from `src/util.ts` for directory naming (so `telegram:123` and
`telegram_123` don't collide).

---

## 10. Model swap for flush turns

Pi supports in-memory model swaps via `session.agent.state.model`. Roundhouse
memory's flush path (`src/memory/lifecycle.ts`) uses this to run compact turns on a
cheaper model.

Kiro ACP has no per-call model swap. Use this approach instead:

### Two-agent strategy (recommended)

At setup time, write **two** agent configs:

- `~/.kiro/agents/roundhouse.json` — the normal agent
- `~/.kiro/agents/roundhouse-flush.json` — same config but `model` set to the flush
  model (default same Haiku-class model that Pi uses)

Keep a **second kiro-cli process** spawned lazily only for flush turns. In
`promptWithModel` / `compactWithModel`:

1. Ensure the flush process exists (spawn if needed).
2. Ensure a session exists in it for the thread (new one is fine — flush turns
   don't need cross-turn history; the flush prompt is self-contained).
3. Run the prompt / compact there.
4. Leave the flush process running until the reaper idles it out (same 30-min idle
   policy as the main process).

This avoids the race window of rewriting agent config mid-turn. If the user
configures `flushModel: null`, fall through to `prompt` / `compact` on the main
process.

---

## 11. `getInfo` contract

This powers the memory subsystem's mode detection (`src/memory/lifecycle.ts:29-34`)
and `/status` command output. Return:

```ts
{
  version: string,              // from `kiro-cli --version`, cached at module load
  model: string,                // "<provider>/<id>" from ~/.kiro/agents/roundhouse.json
  activeSessions: number,
  cwd: string,

  // Context usage — parse from ACP session/update events; null if unknown
  contextTokens: number | null,
  contextWindow: number | null,
  contextPercent: number | null,

  // Memory mode detection — default Full
  hasMemoryExtension: boolean,  // true only if a memory MCP server is in the tools list
  memoryTools: string[],        // ["memory_search", "memory_remember", ...] if MCP present

  // For dashboard / diagnostics
  extensions: string[],         // names of registered layer-B hooks
}
```

**Default `hasMemoryExtension: false`** so the memory layer runs in Full mode and
injects `MEMORY.md`. If the user installs a memory MCP server (e.g.
`@some-memory-mcp`) and it appears in `tools` after setup, flip the flag to `true`
and list the tools it provides. The memory code needs no changes — it already
branches on these fields.

---

## 12. Process hygiene (do not skip)

Hooks and kiro-cli are all subprocesses. Orphans compound. Apply these rules
uniformly across `acp/process.ts` and `hooks/runner.ts`:

1. **Start new session:** use `{ detached: true }` (node) / `start_new_session=True`
   (python equivalent) so the child has its own process group.
2. **Kill the group:** on timeout or forced abort, `process.kill(-pid, "SIGKILL")`
   (leading minus = process group). This reaps shell children spawned by `/bin/sh -c`.
3. **Finite timeout for hooks:** 30 s default per hook; kill the whole group on
   timeout; record `last_status: "timeout"` in the hook store.
4. **Drain stdout/stderr before exit:** buffer 1 MB max per stream. Hooks that
   overflow are killed.
5. **On adapter dispose:** send SIGTERM to kiro-cli, wait up to 5 s, then SIGKILL
   the group. Do this even on an unhandled exception path — wrap the main adapter
   lifecycle in a `try/finally`.
6. **Reap idle sessions:** run a 60 s interval that disposes sessions whose
   `lastUsed` is older than `maxIdleMs` (default 30 min) and whose `inFlight` is 0.

---

## 13. MCP server integration (optional but recommended)

kiro-cli reads MCP server configs from `~/.kiro/settings/mcp.json`. If Roundhouse
wants to ship the same MCP servers the Pi bundle provides (see
`docs/bundle-design.md`), write them there at setup time.

Setup flow:

1. Read `pi/config/mcporter.json` (the roundhouse bundle definitions).
2. Translate to kiro-cli's MCP schema (`{ command, args, env }` — nearly the same).
3. Write `~/.kiro/settings/mcp.json` atomically.
4. In `~/.kiro/agents/roundhouse.json`, set `includeMcpJson: true` so kiro-cli picks
   them up, and add the server names to `tools`/`allowedTools` as `@<server>`.

If Roundhouse doesn't bundle MCP servers at all, skip this section entirely.

---

## 14. Message formatting

Copy the Pi adapter's `formatMessage` verbatim: attachments become a fenced JSON
manifest appended to the user's text, with the same preamble:

> Chat attachments saved locally. Inspect files with tools before making claims.
> Transcripts are approximate; use the raw file if exact wording matters.

kiro-cli doesn't care about the format — it just sees text — but the gateway relies
on this exact shape for attachment handling.

For memory injection, use the same `injectMemoryIntoMessage` utility that the Pi
path uses. No changes needed there.

---

## 15. Setup wiring (`src/cli/setup.ts`)

Extend `resolveAgentForSetup`:

```ts
if (agent.type === "kiro") {
  agent.configure = async (ctx) => {
    // 1. Verify kiro-cli is on PATH; fail with actionable message if not.
    // 2. mkdir -p ~/.kiro/agents ~/.kiro/settings
    // 3. Read existing ~/.kiro/agents/roundhouse.json if present.
    // 4. Build config: merge bundled defaults + current `ctx.model` + user kiro_hooks
    //    from gateway.config.json.
    // 5. Atomically write agent JSON.
    // 6. If flush model is configured, also write ~/.kiro/agents/roundhouse-flush.json.
    // 7. Optional (§13): write ~/.kiro/settings/mcp.json.
    // 8. Log an SEL audit event with the hook counts added.
  };
  agent.installExtension = undefined; // kiro-cli has no extensions; --extension should error
}
```

The existing guard in `setup.ts` already errors on `--extension` for agents that
don't support them (`Agent "${agent.type}" does not support extensions`). No
additional guard needed.

---

## 16. Parity scorecard vs Pi

Use this table to decide whether a user-reported issue is a **gap** (not fixable)
or a **bug** (fixable).

| Pi capability | Kiro adapter | Notes |
|---|---|---|
| Persistent per-thread session | ✅ | via `session/load` + `sessionId` on disk |
| Streaming text | ✅ | `text_chunk` |
| Tool start/end | ✅ | `tool_call` / `tool_result` after normalization |
| Abort | ✅ | `session/cancel` |
| Compact | ✅ | `/compact` slash command |
| Context usage telemetry | ✅ | from ACP `session/update` |
| Tool blocking via exit 2 | ✅ | via Layer A (install-time) or Layer B (runtime) |
| Context injection via hook stdout | ✅ | `AgentSpawn` / `UserPromptSubmit` |
| Auto-approve / auto-deny / auto-reply / transforms / context_rules | ✅ | HookManager (in-process, §5) |
| Memory Full mode | ✅ | default `hasMemoryExtension: false` |
| Memory Complement mode | ⚠️ | only if user installs a memory MCP server |
| Flush-model compact | ⚠️ | via secondary agent config (§10) |
| `custom_message` bubbles | ❌ | no kiro equivalent |
| `draining` / `drain_complete` | ❌ | kiro has no follow-up messages |
| Tool **input** mutation | ❌ | kiro limitation |
| Tool **result** mutation | ❌ | kiro limitation |
| `registerTool` (kiro-internal) | ❌ | use MCP servers instead |
| `registerCommand` | ❌ | not applicable (gateway-level commands already live above adapter) |

If a user asks for any of the ❌ items, the answer is: "kiro-cli does not support
this; the adapter cannot add it without kiro-cli changes. Use an MCP server
(for tools) or a gateway-level command instead."

---

## 17. Tests to write

Place under `test/` following the existing vitest convention. All tests should use
a fake ACP process (write a small helper that pipes JSON-RPC lines on a duplex
stream) — do **not** spawn a real `kiro-cli` in unit tests.

1. `test/kiro-adapter.test.ts`
   - `prompt` accumulates text_chunk correctly and returns full text
   - `promptStream` yields events in ACP order
   - `tool_call` arrives → `PreToolUse` fires → approved → `tool_start` emitted
   - `permission_request` with hook exit 2 → `permission/response` rejected, no
     `tool_start` emitted
   - `complete` with stop_reason=end_turn → `turn_end` → Stop hook fires → `agent_end`
   - `abort` issues `session/cancel` and resolves cleanly
   - two concurrent prompts on the same thread serialize via threadQueues
2. `test/kiro-install-config.test.ts`
   - bundled hooks always present after merge
   - user hook with non-absolute path rejected
   - user hook with shell metacharacters rejected
   - user hook with matcher > 200 chars rejected
   - dedup by `(command, matcher)`
   - per-event and global caps enforced
   - atomic write (write tempfile then rename)
3. `test/kiro-tool-names.test.ts`
   - `"Running: ls -la"` normalizes to `"ls -la"`
   - `"Reading /etc/hosts"` normalizes to `"/etc/hosts"`
   - matcher `"execute_bash"` matches canonical, not the prefixed title
   - matcher `"Running: *"` matches the raw title form
4. `test/kiro-hooks-runner.test.ts`
   - exit 0 stdout returned
   - exit 2 stderr returned with `blocked: true`
   - timeout kills the whole process group (assert with a hook that forks a
     grandchild and a helper that greps `ps` for it afterwards)
   - JSON event arrives on stdin in the expected shape
5. `test/kiro-hook-manager.test.ts`
   - auto_approve_tools short-circuits permission requests
   - auto_deny overrides auto_approve
   - auto_replies match exact / contains correctly
   - context_rules inject expected block

---

## 18. Open questions (resolve before merging)

1. **Flush model: two-agent vs. config rewrite?** This doc picks two-agent (§10).
   Get explicit buy-in before implementing the alternative, because rolling it back
   is expensive.
2. **Thinking chunks.** Drop by default. Expose behind `ROUNDHOUSE_SHOW_THINKING=1`
   later? Flag not in this PR.
3. **Kiro MCP bundle.** If Roundhouse's MCP bundle story expands, revisit §13. For
   v1, keep it off unless a user opts in.
4. **Cron + kiro-cli.** The existing cron runner (`src/cron/runner.ts`) assumes
   `agent.prompt` works out of a long-lived adapter. Verify it does not try to
   spawn a second adapter instance that would fight the main one over
   `~/.kiro/agents/roundhouse.json`. Document the answer in `src/cron/runner.ts`
   comments.
5. **`kiro-cli --version` parsing.** Read the format once during adapter boot,
   cache, and guard against parse failures — never let a version-read error prevent
   the adapter from starting.

---

## 19. Implementation order (suggested)

Merge in three PRs to keep review tractable:

**PR 1 — ACP transport + minimal adapter.**
Files: `src/agents/kiro.ts`, `src/agents/kiro/acp/*`, `src/agents/kiro/session.ts`,
`src/agents/kiro/tool-names.ts`, registry entry. Ship `prompt`, `promptStream`,
`abort`, `restart`, `dispose`, `getInfo` (returning `hasMemoryExtension: false`).
Tests: adapter + tool-names.

**PR 2 — Hook subsystem (Layer B + HookManager).**
Files: `src/agents/kiro/hooks/*`, wire into the ACP event loop in `kiro.ts`. Tests:
hooks-runner, hook-manager.

**PR 3 — Install-time hooks (Layer A) + setup wiring.**
Files: `src/agents/kiro/install-config.ts`, setup.ts branch, bundled defaults.
Tests: install-config merge rules.

**Later:** compact + flush model, MCP bundle integration.

---

## 20. What you should not ship in v1

- Custom matcher syntax for Layer A hooks (use kiro-cli's native `matcher` only).
- Dashboard CRUD for Layer B hooks — for now read `~/.roundhouse/kiro-hooks.json`
  on startup; CRUD is a future PR.
- Vector memory integration. `hasMemoryExtension: false` is enough.
- Voice, transcription, TTS — already gateway-level.
- Any attempt to re-implement Pi's `custom_message` via clever hook stdout. It
  won't work cleanly and the user would see a worse version of what they already
  have on Pi. Be honest about the gap.

---

## Appendix A — Minimal ACP transport sketch

```ts
// src/agents/kiro/acp/client.ts (abbreviated)
export class AcpClient extends EventEmitter {
  constructor(private proc: ChildProcessWithoutNullStreams) {
    super();
    this.proc.stdout.on("data", (buf) => this.ondata(buf));
    this.proc.on("exit", (code) => this.emit("exit", code));
  }

  private buf = "";
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private nextId = 1;

  private ondata(chunk: Buffer) {
    this.buf += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if ("id" in msg && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) reject(msg.error); else resolve(msg.result);
        } else if (msg.method) {
          this.emit(msg.method, msg.params);
        }
      } catch (e) {
        this.emit("parse_error", e, line);
      }
    }
  }

  async call<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    this.proc.stdin.write(payload + "\n");
    return new Promise<T>((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method: string, params: unknown) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
}
```

That is enough to get `initialize`, `session/new`, `session/prompt`, and event
consumption. The rest is orchestration.

---

**End of spec.** If any section here conflicts with what you observe in kiro-cli
during integration, trust observation and update this doc — the contract above is
derived from documented kiro-cli behavior as of the time of writing, but the CLI
evolves.

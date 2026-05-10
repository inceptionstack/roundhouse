# Sub-Agent Orchestrator Design

**Status:** Draft  
**Date:** 2026-05-10

## Goal

Build a Roundhouse-owned sub-agent orchestrator for Phase 1 background jobs.

This layer sits above adapters and owns:
- delegation briefs
- run directory layout
- child process lifecycle
- persisted status
- completion routing back to the correct user thread

Phase 1 is intentionally narrow:
- detached child processes only
- `pi` CLI sessions only
- brief-based delegation, not session forking
- no git/worktree assumptions
- no cost tracking
- no streaming API

## Non-Goals

Phase 1 does not include:
- `run()` / `runParallel()` / `AsyncIterable`
- in-process ephemeral adapters
- session forks
- workspace isolation
- file overlap enforcement
- token or cost accounting
- adapter-agnostic execution backends

Those can be added later without changing the core run-state model.

## Core API

Phase 1 exposes exactly three operations:

```ts
type SubAgentRole = "review" | "research" | "scout" | "implementation";

interface RoutingInfo {
  transport: "telegram";
  chatId: string;
  topicId?: string;
  parentThreadId: string;
}

interface SpawnSpec {
  role: SubAgentRole;
  task: string;
  cwd: string;
  routing: RoutingInfo;
  context?: {
    briefing?: string;
    targetFiles?: string[];
    completionContract?: string;
  };
  model?: string;
  timeoutMs?: number;
}

interface RunStatus {
  runId: string;
  role: SubAgentRole;
  cwd: string;
  routing: RoutingInfo;
  status: "running" | "complete" | "failed" | "timeout";
  pid: number;
  startedAt: string;
  deadlineAt?: string;
  completedAt?: string;
  exitCode?: number;
  spawnClockTicks: string;
}

interface SubAgentOrchestrator {
  spawn(spec: SpawnSpec): Promise<string>;
  status(runId: string): Promise<RunStatus | null>;
  list(): Promise<RunStatus[]>;
  abort(runId: string): Promise<void>;
}
```

Notes:
- `spawn(spec)` returns `runId` immediately after the child process is launched and state is persisted.
- `status(runId)` returns one persisted run state or `null` if the run does not exist.
- `list()` returns all known runs.
- `abort(runId)` sends `SIGTERM` to the recorded PID if the run is still active.
- Parallelism is achieved by calling `spawn()` multiple times.

## Roles

Roundhouse owns the role vocabulary. Phase 1 keeps these four roles:
- `review`
- `research`
- `scout`
- `implementation`

The orchestrator builds the brief and chooses the role prompt prefix. The child process still receives one plain initial prompt.

## Execution Model

Every sub-agent run is a detached `pi` CLI session with its own run directory.

There is no in-process adapter execution in Phase 1.

### Child Process Contract

For each spawned run, the orchestrator:

1. Creates a run directory.
2. Writes `brief.md` into that directory.
3. Optionally writes `settings.json` into that directory when `spec.model` is set.
4. Launches `pi` as a detached child process.
5. Records the child PID and initial status in `status.json`.

The child process is the `pi` CLI executable configured to use the run directory as its session storage.

Required launch shape:

```bash
pi --session-dir <runDir> "<contents of brief.md>"
```

Required Node launch shape:

```ts
spawn("pi", ["--session-dir", runDir, brief], {
  cwd: spec.cwd,
  detached: true,
  stdio: ["ignore", stdoutFd, stderrFd]
});
```

Requirements:
- `--session-dir` must point at the run directory for this run.
- the child process working directory must be `spec.cwd`
- the brief is injected as the initial prompt by passing the full brief text to `pi`
- stdout/stderr should be redirected to files in the run directory for debugging
- the process must be detached so Roundhouse can restart without killing active children
- if `spec.model` is set, the orchestrator writes a `settings.json` override into `runDir` before launch so the `pi` session uses that model
- if `spec.model` is omitted, no model override is written and `pi` inherits its default model resolution

`pi` model selection is session-dir based in Phase 1. The orchestrator does not pass a model flag on the CLI.

## Run Directory Layout

Each run gets its own directory under a Roundhouse-managed root, for example:

```text
<dataRoot>/subagents/<runId>/
  brief.md
  settings.json
  status.json
  stdout.log
  stderr.log
```

`settings.json` is required only when `spec.model` is set. Additional debug files are optional.

## Brief Format

Children get a brief, not a fork of the parent session.

That keeps delegation portable, deterministic, and small. The brief should be concise and explicit enough that the child can act without hidden parent state.

Minimum brief structure:

```md
# Role
implementation

# Task
<user task for the child>

# Working Directory
<cwd>

# Context
<optional briefing>

# Target Files
- <optional file path>

# Done When
<optional completion contract>
```

If a section is empty, omit it.

## Status Persistence

`status.json` is the source of truth for run lifecycle state.

Phase 1 schema:

```json
{
  "runId": "01J...",
  "role": "implementation",
  "cwd": "/workspace/project",
  "routing": {
    "transport": "telegram",
    "chatId": "123456",
    "topicId": "42",
    "parentThreadId": "telegram:123456:42:987"
  },
  "status": "running",
  "pid": 12345,
  "startedAt": "2026-05-10T12:00:00.000Z",
  "deadlineAt": "2026-05-10T12:05:00.000Z",
  "completedAt": "2026-05-10T12:03:10.000Z",
  "exitCode": 0,
  "spawnClockTicks": "123456789"
}
```

Field rules:
- `status` is one of `running`, `complete`, `failed`, `timeout`
- `pid` is the child process PID
- `startedAt` is when Roundhouse spawned the child
- `deadlineAt` is the absolute timeout deadline derived from `timeoutMs`; omit it only for runs with no timeout policy
- `completedAt` is set only after the run finishes or times out
- `exitCode` is set only after process exit is observed
- `spawnClockTicks` is the Linux `/proc/<pid>/stat` field 22 value captured at spawn time

Phase 1 intentionally keeps the schema narrow. In particular:
- no token counts
- no cost
- no partial progress
- no synthesized summaries in `status.json`

Use atomic writes for `status.json` updates.

## Status Transitions

Allowed lifecycle:

```text
running -> complete
running -> failed
running -> timeout
```

Interpretation:
- `complete`: process exited with code `0`
- `failed`: process exited with non-zero code, or state is inconsistent
- `timeout`: Roundhouse terminated the process because its timeout elapsed

`abort(runId)` is an action, not a persisted status value. After abort:
- send `SIGTERM`
- wait for exit observation
- persist `failed` or `timeout` depending on why the process was terminated

Recommended rule:
- manual `abort()` -> `failed`
- orchestrator-enforced timeout -> `timeout`

## Timeouts

Each run may specify `timeoutMs`.

If omitted, the default is **15 minutes** (900000ms). This is configurable in deployment settings but 15 minutes is the hardcoded fallback if no config exists.

Timeout policy must be persisted as `deadlineAt` in `status.json` at spawn time. Recovery logic must use `deadlineAt`, not an in-memory timer start, so restarts preserve the original timeout.

When a timeout is reached:

1. Re-validate that `/proc/<pid>` still exists and that field 22 still matches `spawnClockTicks`.
2. If validation fails, do not signal anything. Mark the run `failed`, set `completedAt`, and record that the original child was already gone or the PID was reused.
3. If validation succeeds, send `SIGTERM` to the child PID.
4. Mark the run `timeout` once process exit is confirmed.
5. Set `completedAt`.
6. Persist the observed `exitCode` if available.

Phase 1 does not require escalation to `SIGKILL`, though implementation may add a short grace period and then force kill if needed.

## Abort Semantics

`abort(runId)` looks up the run from `status.json`.

If `status` is not `running`, it is a no-op.

If `status` is `running`:

1. Re-validate that `/proc/<pid>` still exists and that field 22 still matches `spawnClockTicks`.
2. If validation fails, do not signal anything. Mark the run `failed` and set `completedAt`.
3. If validation succeeds, send `SIGTERM` to `pid`.
4. Let the normal exit watcher finalize state.

Phase 1 abort is strictly PID-based. There is no adapter-level cancellation protocol.

## Concurrency

Phase 1 allows multiple concurrent implementation agents and makes no attempt to prevent file conflicts.

Conflicts are the user's responsibility.

Optional concurrency limiting may be configured in deployment settings, but it is not part of the design contract.

Suggested `settings.json` shape:

```json
{
  "subagents": {
    "maxConcurrentRuns": null,
    "defaultTimeoutMs": 900000
  }
}
```

Interpretation:
- `maxConcurrentRuns: null` means no limit
- if set to a number, the orchestrator may reject new `spawn()` calls once that many runs are active

Default: no concurrency limit.

## Linux PID Validation

PID reuse must be handled carefully across Roundhouse restarts.

`startedAt` is not sufficient for PID identity checking because wall-clock time does not match `/proc/<pid>/stat` process start ticks.

Phase 1 Linux-only approach:

1. At spawn time, read `/proc/<pid>/stat` field 22.
2. Store that value in `spawnClockTicks`.
3. On restart, status refresh, timeout, or abort, read the current `/proc/<pid>/stat` and parse it by stripping everything through the final `") "` boundary first, then splitting the remainder on spaces. Field indexes are counted from that remainder, so Linux state is field 3 and starttime is field 22 in the original file.
4. Treat the PID as the same child only if `/proc/<pid>` exists, the parsed state is not `Z`, and the current starttime matches `spawnClockTicks`.

If `/proc/<pid>` is missing, the process is not running.

If `/proc/<pid>` exists but field 22 differs, the PID has been reused and the original child is gone.

If `/proc/<pid>/stat` field 3 is `Z`, treat the child as exited.

This validation is Linux-specific and acceptable for Phase 1.

There is no "spawned recently enough" fallback in Phase 1. On Linux, `spawnClockTicks` is mandatory and must be covered by Vitest cases, including command names that contain spaces or parentheses and zombie-state parsing.

## Restart Recovery

On Roundhouse startup, the orchestrator scans all run directories and reloads `status.json`.

For each run with `status: "running"`:

1. Recreate timeout handling from persisted `deadlineAt`.
2. Validate whether the recorded PID still refers to the original child.
3. If yes, keep the run as `running` and monitor it via polling.
4. If no, mark it `failed` unless another completion path already finalized it.

This prevents orphaned `running` entries after a gateway crash or restart.

## Thread Routing

Completion routing must be persisted with the run, not reconstructed from memory.

`status.json` must contain:

```json
{
  "routing": {
    "transport": "telegram",
    "chatId": "123456",
    "topicId": "42",
    "parentThreadId": "telegram:123456:42:987"
  }
}
```

Why this matters:
- Roundhouse may restart before the child finishes
- multiple chats and topics may be active concurrently
- the watcher needs exact routing data to post completion into the correct thread

Both `chatId`/`topicId` and `parentThreadId` are persisted because Telegram topic routing needs the concrete destination, while `parentThreadId` is the stable Roundhouse thread identity used for parent-thread message injection and correlation.

The completion watcher uses only persisted routing metadata and run state. It must not rely on in-memory request context.

## Completion Watcher

Phase 1 needs a watcher that observes background children and posts completion back to the original thread.

The watcher is explicitly hybrid:
- for children spawned by the current Roundhouse process, use `child.on("exit")`
- for recovered `running` entries loaded after restart, use interval polling against `/proc`

Watcher responsibilities:
- detect child process exit
- update `status.json`
- route a completion message using `routing`

Minimum completion behavior:
- on exit code `0`, mark `complete`
- on non-zero exit, mark `failed`
- on timeout-driven termination, mark `timeout`

Polling behavior for recovered runs:
- treat `/proc/<pid>` disappearance as exited
- treat `spawnClockTicks` mismatch as PID reuse and finalize as `failed`
- treat `/proc/<pid>/stat` field 3 equal to `Z` as exited

Active in-process children should not be polled for normal completion detection; `child.on("exit")` is the primary path for them. Polling exists for recovered runs after restart and for pre-signal PID validation in timeout or abort flows.

The watcher may include a short human-readable completion message in the parent thread, but that message is not part of the persisted schema.

## Error Handling

`spawn()` should fail before returning a `runId` if:
- `cwd` does not exist
- `pi` executable is unavailable
- the run directory cannot be created
- `brief.md` cannot be written
- the child process fails to launch
- deployment concurrency policy rejects the run

If the child launches successfully, `spawn()` must persist `status.json` before returning.

## Why This Layer Exists

Roundhouse should own orchestration even though Phase 1 execution is `pi`-specific.

That preserves the useful architectural split:
- Roundhouse owns roles, briefs, routing, state, and policy
- execution backends can change later

This keeps the Phase 1 implementation simple without giving up long-term control of the abstraction.

## Implementation Summary

Someone implementing this should build:

1. A `spawn(spec)` path that creates a run directory, writes `brief.md`, optionally writes `settings.json` for `spec.model`, starts detached `pi --session-dir <runDir> "<brief>"` with `cwd: spec.cwd`, captures PID plus `/proc/<pid>/stat` field 22, writes `status.json` including `deadlineAt`, and attaches `child.on("exit")` for that in-process child.
2. A `status(runId)` path and a `list()` path that read persisted run state and refresh `running` entries using Linux PID validation.
3. An `abort(runId)` path that validates the stored PID against `spawnClockTicks` before any `SIGTERM`, failing the run without signaling if the original child is already gone.
4. A hybrid watcher/recovery path that uses `child.on("exit")` for active children, interval polling for recovered runs, and posts completion to the persisted `routing` target.

Phase 2 can add optional git worktrees for isolation, but Phase 1 should assume arbitrary working directories and shared filesystem access.

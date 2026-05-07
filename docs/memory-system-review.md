# Roundhouse Memory System — Code Review & Future Fixes

## Overview

The memory system is ~780 lines across 8 files (`src/memory/`), well-tested (165 lines in `test/memory.test.ts`). It handles memory injection, compaction triggers, and two operating modes.

---

## Efficiency & Optimization

### 1. Redundant File Reads (MEDIUM)

**Location**: `lifecycle.ts` — `prepareMemoryForTurn` and `finalizeMemoryForTurn`

Every turn does:
- `prepareMemoryForTurn`: reads all memory files + computes digest
- `finalizeMemoryForTurn`: reads all memory files AGAIN + computes digest

That's **2x full file reads per turn** (MEMORY.md + memory-rules.md + daily notes). On a busy Telegram thread with rapid back-and-forth, this is unnecessary I/O.

**Fix**: Cache the snapshot in the `PreparedTurn` result and pass it through to `finalizeMemoryForTurn`. Only re-read in finalize if the agent's response included tool calls that could have modified memory files (check turn metadata).

### 2. SHA-256 on Every Turn (LOW)

**Location**: `files.ts` — `hashEntries()`

SHA-256 is overkill for a 48KB content digest that's only compared for equality. A faster hash (xxhash, fnv) would suffice, but at 48KB the difference is negligible (~1ms). Not worth changing.

### 3. Daily Note Resolution (LOW)

**Location**: `files.ts` — `resolveMemoryFiles` calls `getRecentDates(recentDays)` every turn.

With default `recentDays=1`, this resolves today + yesterday. The dates don't change within a turn, but the function is called fresh each time. Could cache per-minute. Negligible impact.

---

## DRY Violations

### 4. Mode Resolution Repeated (MEDIUM)

**Location**: `lifecycle.ts` — `getMode(agent)` called separately in:
- `prepareMemoryForTurn` (line ~60)
- `finalizeMemoryForTurn` (line ~130)
- `flushMemoryThenCompact` (line ~170)

Each call goes through `agent.getInfo?.() → determineMemoryMode()`. The mode doesn't change within a session — it's determined at session creation time.

**Fix**: Resolve mode once at session start and thread it through as a parameter, or memoize in the adapter.

### 5. Config Defaults Scattered (LOW)

Default values live in two places:
- `policy.ts`: `DEFAULT_SOFT_PERCENT`, `DEFAULT_HARD_PERCENT`, etc.
- `files.ts`: `DEFAULTS.mainFile`, `DEFAULTS.dailyDir`
- `types.ts`: defaults documented in JSDoc comments

**Fix**: Consolidate into a single `defaults.ts` or into `types.ts` as exported constants.

### 6. "Unknown" Mode Handling (LOW)

Three places handle `mode === "unknown"`:
- `prepareMemoryForTurn`: treats unknown same as complement (no injection)
- `flushMemoryThenCompact`: treats unknown same as full (`buildFlushPrompt("full")`)
- Comment says "defaults to Full behavior" but implementation is inconsistent

**Fix**: Pick one policy. Recommend: unknown → full (inject memory, include preferences in flush). Update all three sites.

---

## SRP Violations

### 7. `lifecycle.ts` Has Too Many Responsibilities (MEDIUM)

`lifecycle.ts` (245 lines) handles:
1. Mode detection (`determineMemoryMode`)
2. Pre-turn preparation (read files, decide injection, inject)
3. Post-turn finalization (re-read files, detect changes)
4. Pressure classification delegation
5. Full flush-and-compact orchestration (prompt → compact → state update)

Items 1, 2-3, and 5 are three distinct responsibilities.

**Fix**: Extract `flushMemoryThenCompact` into a separate `compact.ts` module. Keep lifecycle focused on per-turn prepare/finalize. Mode detection could move to `types.ts` (it's a pure function on data).

### 8. State Persistence Coupled to Thread Encoding (LOW)

**Location**: `state.ts` — imports `threadIdToDir` from `../util`

The state module knows about Telegram thread ID encoding. If a second platform is added, this coupling becomes a problem.

**Fix**: Accept a `stateKey: string` parameter instead of `threadId`, let callers encode. Low priority since roundhouse is currently Telegram-only.

---

## Missing Error Boundaries

### 9. Silent Swallowing in `readMemorySnapshot` (LOW)

**Location**: `files.ts` line 73 — `catch {}` silently skips missing files.

This is intentional (daily notes may not exist), but a file permission error or disk failure would also be swallowed silently. Consider logging at debug level.

### 10. State Corruption Recovery (LOW)

**Location**: `state.ts` — `loadThreadMemoryState` returns `{}` on any error.

A corrupted JSON file (partial write, disk full) returns empty state, which triggers a fresh injection. This is actually a good self-healing behavior, but could log a warning for observability.

---

## Summary: Priority Fixes

| Priority | Issue | Effort |
|----------|-------|--------|
| MEDIUM | #1 Redundant file reads (2x per turn) | 1h — pass snapshot through PreparedTurn |
| MEDIUM | #4 Mode resolved on every call | 30m — memoize or thread through |
| MEDIUM | #7 lifecycle.ts too many responsibilities | 1h — extract compact.ts |
| LOW | #5 Config defaults scattered | 30m — consolidate |
| LOW | #6 Unknown mode inconsistent | 15m — pick one policy |
| LOW | #8-10 Coupling + error handling | Future cleanup |

---

---

## Future: Expanded Memory File Structure

Currently the memory system uses a minimal file set (MEMORY.md + memory-rules.md + daily notes). The following additional files would enable richer long-term memory:

### Proposed Files

| File | Purpose |
|------|---------|
| `~/projects.md` | Index of active projects with status (links to per-project files) |
| `~/projects/<name>.md` | Per-project state: goals, progress, blockers, architecture decisions |
| `~/user.md` | User profile: communication style, expertise, timezone, preferences |
| `~/mistakes.md` | Log of agent mistakes + corrections ("don't do X because Y") |
| `~/soul.md` | Agent personality, voice, values, interaction style guidelines |
| `~/tools.md` | Tools/systems the user works with, access patterns, credentials locations |

### `projects/` Directory

```
~/projects.md              # Index: project names + one-line status + links
~/projects/telemetron.md   # Goals, architecture, current sprint, blockers
~/projects/roundhouse.md   # Same structure
~/projects/lowkey.md       # Same structure
```

- Front pages reference projects by link (`see [telemetron](projects/telemetron.md)`)
- Project files updated when major milestones hit or blockers change
- Unlike daily notes (ephemeral), project files are durable and accumulate
- Agent reads project files on demand (not injected every turn — too large)

### `user.md`

- Communication preferences (terse vs verbose, language, humor)
- Technical expertise areas
- Timezone, working hours
- How they like to receive bad news / errors

### `mistakes.md`

- Structured log: `| Date | What I did wrong | Correction | Rule |`
- Agent reviews before making similar decisions
- Prevents repeated mistakes across compactions
- Example: "2026-05-06: Said Opus 4.7 when actually using Opus 4.6 — always check settings.json"

### `soul.md`

- Agent's persona/voice for this user
- Tone calibration (formal, casual, technical depth)
- What the agent should/shouldn't do proactively
- Relationship context (long-running collaboration vs one-off)

### `tools.md`

- Systems the user operates (AWS accounts, repos, CI/CD)
- CLI tools and versions
- Credential locations (never actual secrets — just paths/references)
- Common workflows

### Injection Strategy

- **Always injected**: MEMORY.md, memory-rules.md, today's daily, user.md, soul.md
- **Injected on relevant turns**: projects/<name>.md (when user mentions project)
- **Read on demand**: mistakes.md, tools.md, older daily notes
- **Budget**: expand `maxBytes` from 48KB → 64KB to accommodate user.md + soul.md

### Implementation Notes

- `resolveMemoryFiles()` in `files.ts` needs extension to include new always-inject files
- Project file injection requires keyword detection or explicit user mention
- `bootstrapMemoryFiles()` should create templates for user.md, soul.md on first use
- mistakes.md populated by agent self-correction (when user says "no, that's wrong")

---

## Architecture Assessment

**Overall: Well-designed.** The system is clean, well-typed, well-tested. The two-mode design (full/complement) is elegant and future-proof. The proactive compaction with soft/hard/emergency levels is sophisticated. The digest-based change detection avoids unnecessary re-injection.

## Cost & Speed Optimization: Memory Model Selection (HIGH)

### Problem

Memory flush turns use the same model as conversation (currently Opus 4.6 on this instance). These turns are structured tasks (read context → write markdown) that don't need frontier reasoning. This wastes money and adds latency.

### Measurement Plan

Benchmark Bedrock models on memory flush tasks:

| Model | Input cost/1M | Output cost/1M | Expected latency | Quality needed |
|-------|--------------|----------------|------------------|----------------|
| Opus 4.7 | $15 | $75 | ~15-30s | Overkill |
| Sonnet 4.6 | $3 | $15 | ~5-10s | Likely sufficient |
| Sonnet 4.7 | $3 | $15 | ~5-10s | Likely sufficient |
| Haiku 3.5 | $0.25 | $1.25 | ~2-4s | May lose nuance |

**Metrics to capture per flush:**
- Wall-clock time (prompt send → files written)
- Input tokens (memory snapshot + conversation context)
- Output tokens (tool calls to write files)
- Quality score: did it preserve important facts? (manual spot-check)

### Test Protocol

1. Capture 5-10 real flush prompts from production (save the full context that gets sent)
2. Replay each against Opus 4.7, Sonnet 4.6, Sonnet 4.7, Haiku 3.5
3. Compare output quality (MEMORY.md edits, daily note writes)
4. Measure: latency, token counts, cost per flush
5. Estimate monthly cost at current flush frequency (~2-4 flushes/day)

### Implementation (after measurement)

```typescript
// gateway.config.json
{
  "memory": {
    "flushModel": "anthropic.claude-sonnet-4-6-20250514-v1:0",
    // or: "flushModel": "same" (default, use conversation model)
  }
}
```

Options:
- (a) Spawn a separate pi session with the cheap model for flush turns
- (b) Switch model mid-session for the flush turn (if pi supports it)
- (c) Use raw Bedrock API call (bypass pi entirely for structured memory writes)

Option (c) is simplest and fastest — memory writes are well-structured enough to not need the full agent harness.

### Expected Savings

Assuming ~3 flushes/day, ~50K input + ~5K output tokens per flush:
- Opus: ~$0.75 + $0.375 = ~$1.13/day on flushes
- Sonnet: ~$0.15 + $0.075 = ~$0.23/day (5x cheaper)
- Haiku: ~$0.013 + $0.006 = ~$0.02/day (50x cheaper)

---

The biggest wins are reducing per-turn I/O (#1), extracting the compact orchestration (#7), and using a cheaper model for flushes (this section). Neither #1 nor #7 is urgent — the system works correctly today. The model optimization has immediate cost/latency payoff.

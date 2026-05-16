# Refactoring Plan — Roundhouse Clean Code

**Method:** Safe refactoring per Fowler ("Refactoring", 2nd ed.) and Feathers ("Working Effectively with Legacy Code")

**Core principles applied:**
- **Characterization tests first** — Before touching code, write tests that pin existing behavior (Feathers Ch. 13)
- **One refactoring at a time** — Each step is a single named refactoring from the catalog
- **Tests pass after every step** — Green bar between every commit
- **Preserve seams** — Keep existing public API; internal restructuring only
- **Sprout Class over Edit** — When adding new structure, grow it alongside; then migrate callers (Feathers Ch. 6)

---

## Phase 1: Extract Shell Utilities (15 min)

**Motivation:** `whichSync` in `systemd.ts` is imported by `launchd.ts` — wrong module cohesion.

**Refactoring:** *Move Method* (Fowler) → new module

| Step | Technique | Description |
|------|-----------|-------------|
| 1.1 | *Sprout Module* | Create `src/cli/shell.ts` with `whichSync`, `execSilent`, `hasSudoAccess`, `runSudo` |
| 1.2 | *Delegate to new module* | `systemd.ts` re-exports from `shell.ts` (preserves all callers) |
| 1.3 | *Lean on the compiler* | Update `launchd.ts` to import from `shell.ts` directly |
| 1.4 | *Run tests* | 327 tests green |
| 1.5 | *Remove re-exports* | Once all callers updated, remove re-exports from `systemd.ts` |

**Seam preserved:** All existing imports still work via re-export during migration.

---

## Phase 2: Extract ServiceManager Interface (2h)

**Motivation:** 7 CLI commands duplicate `if (darwin) { launchd } else { systemd }` branching.

**Refactoring:** *Extract Interface* + *Replace Conditional with Polymorphism* (Fowler)

| Step | Technique | Description |
|------|-----------|-------------|
| 2.1 | *Write characterization tests* | Add tests for `cmdStop`, `cmdRestart`, `cmdLogs` on both platforms (mock `process.platform`) |
| 2.2 | *Extract Interface* | Define `ServiceManager` in `src/cli/service-manager.ts` with `start`, `stop`, `restart`, `status`, `logs`, `install`, `uninstall` |
| 2.3 | *Sprout Class: LaunchdManager* | Implement interface using existing `launchd.ts` functions |
| 2.4 | *Sprout Class: SystemdManager* | Implement interface using existing `systemd.ts` functions |
| 2.5 | *Extract Method: `getServiceManager()`* | Factory that returns correct impl based on `process.platform` |
| 2.6 | *Inline callers one at a time* | Replace each `cmdStart`, `cmdStop`, etc. to delegate to `getServiceManager()` |
| 2.7 | *Run tests after each inline* | Green bar between each command migration |
| 2.8 | *Remove dead code* | Delete old platform branches from commands |

**Seam preserved:** CLI commands keep same signatures; only internal impl changes.

---

## Phase 3: Extract `cmdAgent` Sub-functions (30 min)

**Motivation:** 130-line function with 5 mixed responsibilities.

**Refactoring:** *Extract Method* (Fowler), repeated

| Step | Technique | Description |
|------|-----------|-------------|
| 3.1 | *Characterization test* | Existing `agent` command tests already cover happy path |
| 3.2 | *Extract Method* | `parseAgentArgs(argv): AgentOptions` — pure arg parsing, easily unit-testable |
| 3.3 | *Extract Method* | `readStdinWithLimit(maxBytes): Promise<string>` — isolated I/O |
| 3.4 | *Extract Method* | `runAgentWithTimeout(agent, opts): Promise<void>` — signal + timer logic |
| 3.5 | *Inline remainder* | `cmdAgent` becomes ~20 lines calling the three extracted functions |
| 3.6 | *Run tests* | Green bar |

---

## Phase 4: Split `gateway.ts` into `src/gateway/` (4h)

**Motivation:** 1281-line god-class with 6+ responsibilities. Untestable as unit.

**Refactoring:** *Extract Class* (Fowler) + *Break Out Method Object* (Feathers Ch. 22)

| Step | Technique | Description |
|------|-----------|-------------|
| 4.1 | *Write characterization tests* | Pin `handleStreaming` output shape, `saveAttachments` behavior, `resolveAgentThreadId` routing |
| 4.2 | *Extract Method Object: streaming* | Move `handleStreaming` + `createTextStream` → `src/gateway/streaming.ts` |
| 4.3 | *Run tests* | Green bar |
| 4.4 | *Extract Module: attachments* | Move `saveAttachments`, MIME map, size constants → `src/gateway/attachments.ts` |
| 4.5 | *Run tests* | Green bar |
| 4.6 | *Extract Module: helpers* | Move `resolveAgentThreadId`, `getChatId`, `isCommand`, `getSystemResources` → `src/gateway/helpers.ts` |
| 4.7 | *Run tests* | Green bar |
| 4.8 | *Extract Module: notifications* | Move `notifyStartup`, `postWithFallback`, `registerBotCommands` → `src/gateway/notifications.ts` |
| 4.9 | *Run tests* | Green bar |
| 4.10 | *Extract Module: command-router* | Move Telegram command handlers (`/status`, `/compact`, `/update`, `/crons`, `/cancel`, `/verbose`, `/doctor`) → `src/gateway/command-router.ts` as a handler map |
| 4.11 | *Run tests* | Green bar |
| 4.12 | *Thin Gateway class* | `Gateway` becomes orchestrator importing from sub-modules (~100 lines) |
| 4.13 | *Move file* | Rename `src/gateway.ts` → `src/gateway/index.ts`, update imports |
| 4.14 | *Run tests* | Green bar |

**Seam preserved:** `export class Gateway` and `import { Gateway } from "./gateway"` unchanged.

---

## Phase 5: Extract Gateway Command Handlers (2h)

**Motivation:** `handleOrAbort` is a 150-line if/else chain mixing auth, dispatch, and formatting.

**Refactoring:** *Replace Conditional with Command Pattern* (Fowler/GoF hybrid)

| Step | Technique | Description |
|------|-----------|-------------|
| 5.1 | *Extract Method* for each command | `handleCompact(thread, agent, ...)`, `handleStatus(thread, ...)`, etc. |
| 5.2 | *Introduce Parameter Object* | `CommandContext { thread, message, agentThreadId, agent, config }` |
| 5.3 | *Build handler registry* | `Map<string, (ctx: CommandContext) => Promise<void>>` |
| 5.4 | *Replace if/else chain* | Lookup in registry, fall through to agent prompt |
| 5.5 | *Run tests* | Green bar |

---

## Phase 6: Split `setup.ts` into `src/cli/setup/` (3h)

**Motivation:** 1496 lines, two duplicate flows sharing ~50% logic.

**Refactoring:** *Extract Class* (Fowler) + *Parameterize Method* (Fowler)

| Step | Technique | Description |
|------|-----------|-------------|
| 6.1 | *Write characterization tests* | Pin `parseSetupArgs` output, `stepConfigure` file writes |
| 6.2 | *Extract Module* | `src/cli/setup/args.ts` ← `parseSetupArgs` |
| 6.3 | *Extract Module* | `src/cli/setup/helpers.ts` ← `atomicWriteJson`, `atomicWriteText`, `execSafe`, `execOrFail` |
| 6.4 | *Extract Module* | `src/cli/setup/steps.ts` ← all `step*` functions |
| 6.5 | *Run tests* | Green bar |
| 6.6 | *Parameterize Method* | Unify interactive/headless into shared step sequence with I/O adapter parameter |
| 6.7 | *Extract Module* | `src/cli/setup/interactive.ts` and `src/cli/setup/headless.ts` — thin orchestrators |
| 6.8 | *Barrel export* | `src/cli/setup/index.ts` exports `cmdSetup`, `cmdPair` |
| 6.9 | *Update import in cli.ts* | Point to new barrel |
| 6.10 | *Run tests* | Green bar |

**Seam preserved:** `import { cmdSetup, cmdPair } from "./setup"` still works (barrel at same path or redirect).

---

## Phase 7: Config Resolver Chain (1h)

**Motivation:** `loadConfig()` has 5 nested try/catches with implicit fallback order.

**Refactoring:** *Replace Nested Conditional with Guard Clauses* + *Extract Method* (Fowler)

| Step | Technique | Description |
|------|-----------|-------------|
| 7.1 | *Characterization test* | Pin behavior: env var > --config > canonical > legacy > cwd > default |
| 7.2 | *Extract Method* for each resolver | `resolveFromEnvVar()`, `resolveFromFlag()`, `resolveFromCanonical()`, `resolveFromLegacy()`, `resolveFromCwd()` |
| 7.3 | *Compose as chain* | Loop over resolvers; first non-null wins |
| 7.4 | *Run tests* | Green bar |

---

## Commit Strategy

Each phase = one squash-ready commit with message like:
```
refactor(cli): extract shell utilities into src/cli/shell.ts

Technique: Move Method (Fowler)
- whichSync, execSilent, hasSudoAccess, runSudo → shell.ts
- systemd.ts re-exports for backward compat
- launchd.ts imports from shell.ts directly
```

Final PR has 7 commits, one per phase. All 327+ tests green at each commit.

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Breaking existing imports | Re-export from old location during transition (Feathers: "preserve the seam") |
| Missing edge cases | Characterization tests pin current behavior before changes |
| Merge conflicts with parallel work | Each phase is independent; can land separately if needed |
| Gateway refactor breaks runtime | Integration test: `roundhouse agent "hello"` after Phase 4 |
| Setup flow changes break UX | Existing setup tests + manual `--dry-run` verification |

---

## Definition of Done

- [ ] All 327+ existing tests pass
- [ ] New characterization tests added (target: 10-15 new tests)
- [ ] No file > 300 lines (except setup/steps.ts which may be ~400)
- [ ] No function > 50 lines
- [ ] Each module has single responsibility nameable in ≤5 words
- [ ] `gateway.ts` → `src/gateway/` directory (6+ files, each <200 lines)
- [ ] `cli.ts` commands delegate to ServiceManager (no platform branching in commands)
- [ ] Zero behavioral changes (pure refactoring, no feature work)

---

## Review Feedback (Sonnet 4.5, 2026-05-08)

### Fixes Applied to Plan

1. **Phase 2.0 added:** Survey all platform checks first — ensure branching only at call sites
2. **Phase 4.10 merged into Phase 5:** Extract command handlers + command pattern together (avoid moving target)
3. **Phase 4.14 explicit:** "Update all imports of `./gateway` across codebase"
4. **Phase 6.9 clarified:** Barrel at `src/cli/setup/index.ts` — Node resolves `./setup` to `./setup/index.ts` automatically
5. **Add to DoD:** `tsc --noEmit` passes at each commit; no new `any` types introduced

### Additional Characterization Tests Needed

- `install`/`uninstall` with file writes (temp dirs)
- Error paths: service already running, systemctl missing, sudo denied
- Stdin >1MB limit behavior
- Timeout kill signal handling
- Auth denial paths (non-allowed users)
- `postWithFallback` markdown→plaintext fallback
- Env file merge logic (preserve existing keys)
- JSON parse errors in config files
- `applyEnvOverrides` behavior
- `isCommand` edge cases (`/start@botname`)

### Additional Risks

| Risk | Mitigation |
|------|-----------|
| Gateway streaming state races | Integration test: overlapping messages to same thread |
| Platform detection in CI | Mock `process.platform` in test setup, not per-test |
| TypeScript import resolution | Run `tsc --noEmit` after each phase |

### Structural Note

Phase 4 split into 4A (streaming/attachments) and 4B (helpers/notifications) to reduce risk per commit.

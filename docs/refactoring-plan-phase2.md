# Refactoring Plan — Phase 2

Phase 1 reduced gateway.ts (1281→695), cli.ts (669→428), and config.ts.
Phase 2 targets the remaining god-files and establishes test coverage for extracted modules.

## Current State (post Phase 1)

| File | Lines | Issues |
|------|-------|--------|
| setup.ts | 1313 | God module (51 functions), >50-line funcs ×10+ |
| pi-adapter.ts | 663 | God class, no tests, mixed concerns |
| kiro-adapter.ts | 456 | 17 methods, >50-line funcs ×3 |
| gateway.ts | 711 | handleAgentTurn 148 lines, start() 185 lines |
| cli.ts | 427 | cmdStatus 70+ lines, printHelp 76+ lines |
| cron.ts (cli) | 296 | cmdCron 249 lines (single function!) |
| telegram-format.ts | 310 | formatTable 118 lines, markdownToTelegramHtml 87 lines |

## Priorities (change frequency × pain)

1. **setup.ts** — changed every release, 1313 lines, 51 functions
2. **pi-adapter.ts** — core agent path, 663 lines, zero tests
3. **gateway.ts handleAgentTurn** — 148 lines, still above threshold
4. **cron.ts** — 249-line function, hard to maintain
5. **telegram-format.ts** — 310 lines, pure functions, easy wins

---

## Phase 2A: Split setup.ts Step Functions (est. 2h)

**Technique:** Sprout Module (Feathers), Extract Method (Fowler)

### Target
Move step functions to `src/cli/setup/steps.ts`:
- `stepPreflight` (83 lines)
- `stepValidateToken` (16 lines)
- `stepStopGateway` (36 lines)
- `stepInstallPackages` (132 lines)
- `stepStoreSecrets` (45 lines)
- `stepInstallBundle` (12 lines)
- `stepConfigure` (114 lines)
- `stepPair` (56 lines)
- `stepRegisterCommands` (6 lines)
- `stepInstallSystemd` (59 lines)
- `stepPostflight` (38 lines)

### Approach
1. Create `src/cli/setup/steps.ts` with shared deps
2. Extract type `BotInfo` and `AgentDefinition` to `types.ts`
3. Move all `step*` functions (600+ lines)
4. setup.ts keeps only `cmdSetup`, `cmdPair`, orchestrators
5. Run tests after each step extraction

### Expected Result
- setup.ts: 1313 → ~500 lines
- steps.ts: ~650 lines (further split in 2B)
- Each step independently testable

---

## Phase 2B: Split setup.ts Orchestrators (est. 1h)

**Technique:** Extract Method, Separate Levels of Abstraction (Martin)

### Target
Move orchestrator functions to `src/cli/setup/flows.ts`:
- `runInteractiveTelegramSetup` (113 lines)
- `runHeadlessTelegramSetup` (157 lines)
- `printDryRun` (40 lines)
- `printSetupHelp` (50 lines)

### Expected Result
- setup.ts: ~500 → ~250 lines (just `cmdSetup` + `cmdPair` dispatch)
- flows.ts: ~360 lines

---

## Phase 2C: Decompose Pi Adapter (est. 3h)

**Technique:** Sprout Class (Feathers), Replace Function with Object (Fowler)

### Current Problems
- 663 lines, factory function with 20+ closures
- Session management mixed with prompt logic
- Formatting (AgentMessage → pi text) mixed with I/O
- Zero test coverage

### Target Structure
```
src/agents/pi/
├── pi-adapter.ts          (~150 lines — adapter shell, implements AgentAdapter)
├── session-pool.ts        (~200 lines — getOrCreate, reap, serialize)
├── message-format.ts      (~80 lines — formatMessage, extractCustomMessage)
├── stream-mapper.ts       (~150 lines — map pi events → AgentStreamEvent)
└── index.ts               (barrel)
```

### Approach
1. Write characterization tests for `formatMessage` and `extractCustomMessage` (pure functions)
2. Extract `message-format.ts` (Move Method)
3. Extract `stream-mapper.ts` (the event subscription → AgentStreamEvent mapping)
4. Extract `session-pool.ts` (getOrCreate, reapIdleSessions, thread queue)
5. pi-adapter.ts becomes thin orchestrator

### Expected Result
- Each file <200 lines
- Pure functions testable without mocking pi SDK
- Adapter shell is 150 lines with clear delegation

---

## Phase 2D: Decompose cmdCron (est. 1h)

**Technique:** Replace Conditional with Command Pattern, Extract Method

### Current Problem
- `cmdCron` is 249 lines: one giant switch/if-else for subcommands (add, remove, list, enable, disable, trigger, pause, resume, history, edit)

### Target Structure
```
src/cli/cron/
├── index.ts        (cmdCron: parse subcommand → dispatch)
├── commands.ts     (individual handlers: addJob, removeJob, listJobs, etc.)
└── format.ts       (output formatting — reuse existing src/cron/format.ts)
```

### Approach
1. Extract each subcommand handler as a named function
2. cmdCron becomes a 30-line dispatcher (switch → handler map)
3. Each handler: 20-40 lines, independently testable

---

## Phase 2E: Telegram Formatting (est. 1h)

**Technique:** Extract Method, Decompose Conditional (Fowler)

### Current Problem
- `formatTable` 118 lines — builds HTML table from markdown
- `markdownToTelegramHtml` 87 lines — complex regex pipeline
- No tests for either

### Approach
1. Write characterization tests (pin current behavior with 10+ fixtures)
2. Extract `formatTable` sub-steps: parseRows, measureColumns, renderHtml
3. Extract regex pipeline steps into named transform functions
4. Add edge-case tests (empty input, nested markdown, Unicode)

### Expected Result
- telegram-format.ts: 310 → ~150 lines
- New: telegram-format-table.ts (~100 lines)
- 15+ unit tests for formatting

---

## Phase 2F: Gateway handleAgentTurn Decomposition (est. 1h)

**Technique:** Extract Method (Fowler)

### Current Problem
- 148 lines mixing: attachments, STT, message transforms, memory, prompt, finalize
- 4 levels of try/catch nesting

### Target
Split into sequential phases, each a private method:
- `prepareAttachments()` — save + notify skipped
- `enrichWithStt()` — transcribe audio
- `executePrompt()` — stream/non-stream with abort
- `finalizeMemory()` — post-turn finalize + pressure

### Expected Result
- handleAgentTurn: 148 → ~40 lines (orchestrator)
- 4 new private methods, each 25-40 lines

---

## Phase 2G: Add Characterization Tests (est. 2h)

**Technique:** Characterization Testing (Feathers Ch. 13)

Priority test targets (zero coverage today):
1. `pi-adapter.ts` — formatMessage, extractCustomMessage (pure)
2. `telegram-format.ts` — markdownToTelegramHtml, formatTable
3. `service-manager.ts` — LaunchdManager, SystemdManager (mock execFileSync)
4. `agent-command.ts` — parseAgentArgs, readStdinWithLimit
5. `cron.ts` — subcommand parsing

### Approach
- Pin existing behavior (not ideal behavior)
- Use snapshot tests where output is complex
- Mock I/O boundaries (execFileSync, fs, network)

### Target: +50 tests minimum

---

## Execution Order

| Phase | Depends On | Estimated |
|-------|-----------|-----------|
| 2A | — | 2h |
| 2B | 2A | 1h |
| 2C | — | 3h |
| 2D | — | 1h |
| 2E | — | 1h |
| 2F | — | 1h |
| 2G | 2C, 2E | 2h |

**Total: ~11h of focused refactoring work**

Phases 2A/2B (setup), 2C (pi-adapter), and 2D-2F are independent tracks.
Phase 2G adds tests for newly extracted modules.

---

## Success Criteria

After Phase 2:
- No file >400 lines (except setup/steps.ts at ~650, split further in Phase 3)
- No function >50 lines
- All pure functions have unit tests
- pi-adapter.ts decomposed into 4 focused modules
- cmdCron decomposed into dispatcher + handlers
- +50 new tests (388 total)

## Rules (carry forward from Phase 1)

1. One refactoring step per commit
2. `npm test` passes after each commit
3. No behavioral changes (pure refactoring)
4. Seams preserved (re-exports for backward compat)
5. Codex review before merge

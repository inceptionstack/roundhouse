# Refactoring Plan: setup.ts (1313 lines → ≤400 per file)

**Target:** `src/cli/setup.ts` — 1313 lines, 19 functions, 5 functions >50 lines
**Methodology:** Feathers (characterize → seams → break deps → extract)

## Analysis

### Smells Detected

| Smell | Severity | Location |
|-------|----------|----------|
| God Module | FAIL (1313 lines) | setup.ts as a whole |
| Long Method | FAIL (157 lines) | `runHeadlessTelegramSetup` |
| Long Method | FAIL (134 lines) | `stepInstallPackages` |
| Long Method | FAIL (117 lines) | `runInteractiveTelegramSetup` |
| Long Method | FAIL (113 lines) | `stepConfigure` |
| Long Method | FAIL (100 lines) | `stepPreflight` |
| Mutable Module State | WARN | `let log/step/ok/warn/fail` reassigned by headless flow |
| Mixed Abstraction | WARN | Orchestrators mix flow logic with UI formatting |

### Dependency Map

```
setup.ts imports:
  ./setup/helpers (atomicWriteJson, atomicWriteText, execSafe, execOrFail)
  ./setup/types (SetupOptions, StepStatus, PI_SETTINGS_PATH, ...)
  ./setup/args (parseSetupArgs)
  ./systemd (whichSync, systemctl, generateUnit, ...)
  ./launchd (isLaunchAgentRunning)
  ./env-file (envQuote, parseEnvFile, unquoteEnvValue)
  ./detect (detectEnvironment, formatDetectionResults)
  ../agents/registry (getAgentDefinition, listAvailableAgentTypes)
  ../bundle (provisionBundle)
  ../config (ROUNDHOUSE_DIR, CONFIG_PATH, ENV_FILE_PATH, fileExists)
  ../commands (BOT_COMMANDS)
  ../pairing (createPairingNonce, createPairingLink, ...)
  ./setup-telegram (validateBotToken, pairTelegram, ...)
  ./setup-prompts (promptText, promptMasked)
  ./setup-logger (createTextLogger, createJsonLogger, ...)
  ./qr (printQr)
```

### Key Constraint: Mutable Logger

The 5 `let` variables (`log`, `step`, `ok`, `warn`, `fail`) are module-level mutable state.
`runHeadlessTelegramSetup` reassigns them to JSON logger variants.
All step functions use them via closure.

**This is the #1 blocker for extraction.** Steps can't move to another file unless the logger is injected.

## Plan: 4 Phases (Green Bar Discipline)

### Phase A: Inject logger into step functions (enables extraction)

**Technique:** Parameterize Method (Feathers #19)

1. Define `SetupLogger` interface in `setup/types.ts`:
   ```typescript
   interface SetupLog {
     log(msg: string): void;
     step(n: string, label: string): void;
     ok(msg: string): void;
     warn(msg: string): void;
     fail(msg: string): void;
   }
   ```

2. Add `logger: SetupLog` as first parameter to each step function.
3. Replace bare `log()`/`ok()`/`warn()`/`fail()` calls with `logger.log()` etc.
4. Pass logger from orchestrators (which create it).
5. Remove module-level `let` variables.
6. **Tests pass** — behavioral preservation (same output, different wiring).

**Risk:** Mechanical, tedious, but safe. 325 call sites to prefix with `logger.`.
**Mitigation:** sed/regex in a single pass, then compile-check.

### Phase B: Extract step functions → `setup/steps.ts`

**Technique:** Sprout Module (Fowler), Move Method

Once logger is injected, steps have no closure dependency on setup.ts.
Move these 11 functions (≈700 lines) to `src/cli/setup/steps.ts`:

- `stepPreflight` (100 lines)
- `stepValidateToken` (15 lines)
- `stepStopGateway` (35 lines)
- `stepInstallPackages` (134 lines)
- `stepStoreSecrets` (42 lines)
- `stepInstallBundle` (11 lines)
- `stepConfigure` (113 lines)
- `stepPair` (55 lines)
- `stepRegisterCommands` (5 lines)
- `stepInstallSystemd` (58 lines)
- `stepPostflight` (38 lines)

After: `setup.ts` drops from 1313 → ≈600 lines.

### Phase C: Extract orchestrator flows → `setup/flows.ts`

**Technique:** Extract Method (Fowler)

Move these 2 functions (≈280 lines) to `src/cli/setup/flows.ts`:

- `runInteractiveTelegramSetup` (117 lines)
- `runHeadlessTelegramSetup` (157 lines)

After: `setup.ts` drops from ≈600 → ≈320 lines (under threshold!).

### Phase D: Split `stepInstallPackages` (134 lines)

**Technique:** Extract Method within steps.ts

Split into 3 focused helpers inside `steps.ts`:
- `installAgentPackages` (30 lines)
- `installPsst` (70 lines) — bun + psst-cli + vault init
- `installUserExtensions` (15 lines)

After: no function in setup/ exceeds 100 lines. Only `stepConfigure` at 113 lines remains as stretch goal.

## Expected Result

| File | Lines |
|------|-------|
| `src/cli/setup.ts` | ≈320 (dispatcher + helpers + printDryRun + printSetupHelp) |
| `src/cli/setup/steps.ts` | ≈650 (11 step functions) |
| `src/cli/setup/flows.ts` | ≈280 (2 orchestrators) |
| `src/cli/setup/types.ts` | ≈60 (+SetupLog interface) |
| `src/cli/setup/helpers.ts` | 66 (unchanged) |
| `src/cli/setup/args.ts` | 109 (unchanged) |

Total: same 1313 lines, spread across files with clear responsibilities.
No file >650 lines (steps.ts is acceptable — it's 11 cohesive functions sharing a namespace).

## Execution Order

1. **Phase A first** — this is the seam-breaking work. Once done, B and C are mechanical moves.
2. **B before C** — steps are the leaves; flows call steps.
3. **D last** — optional polish, only if time allows.
4. **Commit after each phase** (4 commits total).

## Test Strategy

- 39 existing tests (16 setup + 23 telegram-setup) verify behavior
- No new characterization tests needed — orchestrators call external APIs (Telegram) and can't be unit-tested without mocks
- All 4 phases are purely structural → existing tests cover regression

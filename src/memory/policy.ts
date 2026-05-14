/**
 * memory/policy.ts — Memory injection and compaction policy decisions
 *
 * Pure functions — no side effects, easy to test.
 */

import type { MemoryConfig, ThreadMemoryState, PressureLevel } from "./types";
import { formatDate } from "./files";

// ── Defaults ─────────────────────────────────────────

const DEFAULT_SOFT_PERCENT = 0.45;
const DEFAULT_SOFT_TOKENS = 130_000;
const DEFAULT_HARD_PERCENT = 0.50;
const DEFAULT_HARD_TOKENS = 150_000;
const DEFAULT_EMERGENCY_THRESHOLD = 32_768;
const DEFAULT_COOLDOWN_MS = 10 * 60_000; // 10 minutes

// Headroom reserved for the summarization payload itself when compact runs.
// The summarizer prompt serializes ALL discarded history (everything older
// than ~20k of recent tokens) plus scaffolding plus previous summary, then
// asks the model to summarize. If the prompt itself overflows the model
// context, compact() throws. 50k is the empirical headroom that fits a
// typical summarization prompt on Claude family.
const COMPACT_HEADROOM_TOKENS = 50_000;

// Why 130k/150k as the default absolute thresholds against a 200k window:
// see COMPACT_HEADROOM_TOKENS above and
// ~/.roundhouse/workspace/compaction-loop-diagnosis.md (Bug B).
// For smaller-window models, classifyContextPressure() clamps the absolute
// thresholds to `window - HEADROOM` so they never exceed the window.

// ── Injection policy ─────────────────────────────────

export interface InjectionDecision {
  inject: boolean;
  reason: string;
}

/**
 * Decide whether to inject memory into this turn.
 * Called ONLY in Full mode (when agent has no memory extension).
 */
export function shouldInjectMemory(
  state: ThreadMemoryState,
  currentDigest: string,
  now: Date = new Date(),
): InjectionDecision {
  // Force flag (after compact, new session, manual)
  if (state.forceInjectReason) {
    return { inject: true, reason: state.forceInjectReason };
  }

  // No previous injection — first time for this thread
  if (!state.lastInjectedDigest) {
    return { inject: true, reason: "first-injection" };
  }

  // Memory files changed (cron wrote, another thread wrote, user edited)
  if (currentDigest !== state.lastInjectedDigest) {
    return { inject: true, reason: "changed" };
  }

  // Date boundary — new daily note
  const today = formatDate(now);
  if (state.lastSeenLocalDate && state.lastSeenLocalDate !== today) {
    return { inject: true, reason: "date-boundary" };
  }

  return { inject: false, reason: "unchanged" };
}

// ── Context pressure ─────────────────────────────────

export interface ContextInfo {
  contextTokens: number | null;
  contextWindow: number | null;
  contextPercent: number | null;
}

/**
 * Classify context pressure level.
 * Used in BOTH modes (complement and full) for proactive compaction.
 */
export function classifyContextPressure(
  info: ContextInfo,
  config?: MemoryConfig["compact"],
): PressureLevel {
  const tokens = info.contextTokens;
  const window = info.contextWindow;
  const percent = info.contextPercent;

  // Can't classify without data
  if (tokens == null || window == null) return "none";

  const remaining = window - tokens;
  const emergencyThreshold = config?.emergencyThresholdTokens ?? DEFAULT_EMERGENCY_THRESHOLD;

  // Emergency: running out of room
  if (remaining <= emergencyThreshold) return "emergency";

  const pctDecimal = percent != null ? percent / 100 : tokens / window;

  // Clamp absolute thresholds so they never exceed `window - HEADROOM`.
  // Defends against future smaller-window models where the configured
  // 150k/130k absolute thresholds would otherwise sit above the window.
  // The percent thresholds already scale with window naturally.
  const headroom = COMPACT_HEADROOM_TOKENS;
  const ceiling = Math.max(0, window - headroom);

  // Hard threshold
  const hardPct = config?.hardPercent ?? DEFAULT_HARD_PERCENT;
  const hardTok = Math.min(config?.hardTokens ?? DEFAULT_HARD_TOKENS, ceiling);
  if (pctDecimal >= hardPct || tokens >= hardTok) return "hard";

  // Soft threshold (clamped one step below hard so soft fires first).
  const softPct = config?.softPercent ?? DEFAULT_SOFT_PERCENT;
  const softTok = Math.min(config?.softTokens ?? DEFAULT_SOFT_TOKENS, Math.max(0, hardTok - 1));
  if (pctDecimal >= softPct || tokens >= softTok) return "soft";

  return "none";
}

/**
 * Check whether a soft flush should be skipped due to cooldown.
 */
export function isSoftFlushOnCooldown(state: ThreadMemoryState, config?: MemoryConfig["compact"]): boolean {
  if (!state.lastSoftFlushAt) return false;
  const cooldownMs = config?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const elapsed = Date.now() - new Date(state.lastSoftFlushAt).getTime();
  return elapsed < cooldownMs;
}

// ── Pressure comparison ───────────────────────────────────

const PRESSURE_SEVERITY: Record<PressureLevel, number> = { none: 0, soft: 1, hard: 2, emergency: 3 };

/** Return the higher-severity pressure level. */
export function maxPressure(a: PressureLevel | undefined, b: PressureLevel): PressureLevel {
  const sa = PRESSURE_SEVERITY[a ?? "none"] ?? 0;
  const sb = PRESSURE_SEVERITY[b] ?? 0;
  return sa > sb ? (a ?? "none") : b;
}

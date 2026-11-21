/**
 * memory/policy.ts — Memory injection and compaction policy decisions
 *
 * Pure functions — no side effects, easy to test.
 */

import type { MemoryConfig, ThreadMemoryState, PressureLevel } from "./types";
import { formatDate } from "./files";

// ── Defaults ─────────────────────────────────────────

// Thresholds are fractions of the conversation model's context window, so
// they follow the model: 90k / 120k on a 200k model, 450k / 600k on a 1M one.
// (They used to be capped at 130k / 150k absolute, which suited 200k models
// and made a 1M model compact at 15% full.) Absolute caps are still honoured
// when configured, for someone who wants to bound cost per turn.
const DEFAULT_SOFT_PERCENT = 0.45;
const DEFAULT_HARD_PERCENT = 0.60;
const DEFAULT_EMERGENCY_THRESHOLD = 32_768;
const DEFAULT_COOLDOWN_MS = 10 * 60_000; // 10 minutes

// Headroom reserved for the summarization payload itself when compact runs.
// The summarizer prompt serializes ALL discarded history (everything older
// than ~20k of recent tokens) plus scaffolding plus previous summary, then
// asks the model to summarize. If the prompt itself overflows the model
// context, compact() throws. 50k is the empirical headroom that fits a
// typical summarization prompt on Claude family. No threshold is ever placed
// above `window - HEADROOM`, whatever the percentages say.
export const COMPACT_HEADROOM_TOKENS = 50_000;

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
  /** Conversation model as "provider/model-id", for per-model overrides. */
  model?: string | null;
}

type CompactConfig = NonNullable<MemoryConfig["compact"]>;

/**
 * The compaction settings that apply to one model: the base settings with
 * that model's entry under `compact.models` laid over them.
 */
export function resolveCompactConfig(config: MemoryConfig["compact"], model?: string | null): CompactConfig {
  const base = config ?? {};
  const override = model && base.models && Object.hasOwn(base.models, model) ? base.models[model] : undefined;
  return override ? { ...base, ...override } : base;
}

export interface ContextThresholds {
  /** Token count at which the agent is asked to save memory (no compaction). */
  soft: number;
  /** Token count at which memory is flushed and the session compacted. */
  hard: number;
  /** Free tokens at or below which compaction runs without a flush first. */
  emergencyRemaining: number;
}

/**
 * Where the thresholds sit, in tokens, for a model with this context window.
 * Each is the smallest of: its fraction of the window, its absolute cap if one
 * is configured, and the ceiling that leaves room for the summarizer.
 */
export function contextThresholds(
  window: number,
  config?: MemoryConfig["compact"],
  model?: string | null,
): ContextThresholds {
  const c = resolveCompactConfig(config, model);
  const ceiling = Math.max(0, window - COMPACT_HEADROOM_TOKENS);
  const hard = Math.min(
    Math.floor((c.hardPercent ?? DEFAULT_HARD_PERCENT) * window),
    c.hardTokens ?? Number.POSITIVE_INFINITY,
    ceiling,
  );
  // Soft sits below hard, so the reminder to save memory comes first.
  const soft = Math.min(
    Math.floor((c.softPercent ?? DEFAULT_SOFT_PERCENT) * window),
    c.softTokens ?? Number.POSITIVE_INFINITY,
    Math.max(0, hard - 1),
  );
  return { soft, hard, emergencyRemaining: c.emergencyThresholdTokens ?? DEFAULT_EMERGENCY_THRESHOLD };
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

  // Can't classify without data
  if (tokens == null || window == null) return "none";

  const t = contextThresholds(window, config, info.model);

  // Emergency: running out of room
  if (window - tokens <= t.emergencyRemaining) return "emergency";
  if (tokens >= t.hard) return "hard";
  if (tokens >= t.soft) return "soft";
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

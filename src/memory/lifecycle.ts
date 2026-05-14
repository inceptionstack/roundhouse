/**
 * memory/lifecycle.ts — Memory lifecycle for gateway turns
 *
 * Two modes:
 * - Full: inject memory, track digest, flush before compact
 * - Complement: only flush before compact (agent extension handles memory)
 *
 * Both modes share proactive compaction logic.
 */

import type { AgentAdapter, AgentMessage } from "../types";
import type { MemoryConfig, MemoryFileSet, MemoryMode, MemorySnapshot, PreparedTurn, PressureLevel, ThreadMemoryState, CompactResult } from "./types";
import { resolveMemoryFiles, readMemorySnapshot, formatDate } from "./files";
import { loadThreadMemoryState, saveThreadMemoryState } from "./state";
import { shouldInjectMemory, classifyContextPressure, isSoftFlushOnCooldown } from "./policy";
import { buildMemoryInjection, injectMemoryIntoMessage } from "./inject";
import { buildFlushPrompt } from "./prompts";
import { bootstrapMemoryFiles } from "./bootstrap";
import { isContextOverflowError } from "../agents/shared/error-classifiers";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Telemetry helper ─────────────────────────────────

interface CompactLogEntry {
  threadId: string;
  level: string;
  effectiveLevel: string;
  flushSkipped: boolean;
  tokensBefore: number | null;
  tokensAfter: number | null;
  flushMs: number;
  compactMs: number;
  totalMs: number;
  model: string;
  status: "ok" | "failed";
  error: string | null;
}

/**
 * Append a compact telemetry entry. Fire-and-forget.
 * Schema is uniform across success/failure (status discriminator) so
 * downstream parsers don't have to handle missing fields.
 */
function appendCompactLog(entry: CompactLogEntry): void {
  const logDir = join(homedir(), ".roundhouse", "logs");
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
  mkdir(logDir, { recursive: true })
    .then(() => appendFile(join(logDir, "compact-timing.jsonl"), line))
    .catch((err) => console.warn(`[memory] timing log write failed:`, (err as Error).message));
}

async function attemptSoftResetRecovery(
  err: unknown,
  threadId: string,
  agent: AgentAdapter,
  onProgress?: (step: string) => void | Promise<void>,
): Promise<{ attempted: boolean; succeeded: boolean }> {
  if (!isContextOverflowError(err) || !agent.softReset) {
    return { attempted: false, succeeded: false };
  }

  try {
    await onProgress?.("♻️ Session overflowed — soft-resetting to recent turns...");
    const report = await agent.softReset(threadId);
    if (report?.reset) {
      console.warn(`[memory] soft-reset recovered ${threadId} from overflow`);
      return { attempted: true, succeeded: true };
    }

    console.warn(`[memory] soft-reset returned no-op for ${threadId} (${(report as { reason?: string } | null)?.reason ?? "unknown"})`);
    return { attempted: true, succeeded: false };
  } catch (resetErr) {
    console.error(`[memory] soft-reset failed for ${threadId}:`, (resetErr as Error).message);
    return { attempted: true, succeeded: false };
  }
}

// ── Memory mode detection ────────────────────────────

/**
 * Determine memory mode from agent info.
 * Returns "unknown" if agent info isn't available yet (before first session).
 */
export function determineMemoryMode(agentInfo: Record<string, unknown>): MemoryMode {
  const has = agentInfo.hasMemoryExtension;
  if (has === true) return "complement";
  if (has === false) return "full";
  return "unknown";
}

// ── Pre-turn: prepare memory ─────────────────────────

/**
 * Prepare memory for a turn. Called before sending prompt to agent.
 *
 * In Full mode: may inject memory into the message.
 * In Complement mode: passes message through unchanged.
 * In Unknown mode: defaults to Full behavior.
 */
export async function prepareMemoryForTurn(
  threadId: string,
  message: AgentMessage,
  agent: AgentAdapter,
  rootDir: string,
  config?: MemoryConfig,
): Promise<PreparedTurn> {
  if (config?.enabled === false) {
    return { message, beforeDigest: null, injected: false };
  }

  const mode = getMode(agent);

  // Complement mode: no injection, no digest tracking needed (finalize skips complement)
  if (mode === "complement" || mode === "unknown") {
    return { message, beforeDigest: null, injected: false };
  }

  // Full mode: inject if needed
  try {
    // Bootstrap memory files on first use
    await bootstrapMemoryFiles(rootDir, "full", config);

    const fileSet = resolveMemoryFiles(rootDir, config);
    const snapshot = await readMemorySnapshot(fileSet, config?.inject?.maxBytes);
    const state = await loadThreadMemoryState(threadId);

    // Check pending compact from interrupted flush — surface to gateway
    let pendingCompactLevel: PreparedTurn["pendingCompact"];
    if (state.pendingCompact) {
      pendingCompactLevel = state.pendingCompact;
      state.pendingCompact = undefined;
      await saveThreadMemoryState(threadId, state);
      console.log(`[memory] pending compact (${pendingCompactLevel}) cleared for ${threadId} — gateway will retry`);
    }

    const decision = shouldInjectMemory(state, snapshot.digest);

    if (decision.inject) {
      const injection = buildMemoryInjection(snapshot, decision.reason);
      const injectedMessage = injectMemoryIntoMessage(message, injection);

      // Update state
      state.lastInjectedDigest = snapshot.digest;
      state.lastInjectedAt = new Date().toISOString();
      state.lastSeenLocalDate = formatDate(new Date());
      state.forceInjectReason = undefined;
      await saveThreadMemoryState(threadId, state);

      console.log(`[memory] injected into ${threadId} (reason: ${decision.reason}, ${snapshot.entries.length} files, digest: ${snapshot.digest})`);
      return { message: injectedMessage, beforeDigest: snapshot.digest, injected: true, pendingCompact: pendingCompactLevel, fileSet, snapshot };
    }

    return { message, beforeDigest: snapshot.digest, injected: false, pendingCompact: pendingCompactLevel, fileSet, snapshot };
  } catch (err) {
    console.error(`[memory] prepareMemoryForTurn error:`, (err as Error).message);
    return { message, beforeDigest: null, injected: false };
  }
}

// ── Post-turn: finalize and check pressure ───────────

/**
 * Finalize memory after a turn. Called after agent response.
 *
 * In Full mode: check if agent wrote memory files (update digest).
 * Both modes: check context pressure for proactive compaction.
 *
 * Uses cached fileSet from PreparedTurn to avoid re-resolving files.
 * Only re-reads files if the turn included tool calls that could have modified them.
 *
 * Returns the pressure level for the gateway to act on.
 */
export async function finalizeMemoryForTurn(
  threadId: string,
  prepared: PreparedTurn,
  agent: AgentAdapter,
  rootDir: string,
  config?: MemoryConfig,
): Promise<PressureLevel> {
  if (config?.enabled === false) return "none";

  const mode = getMode(agent);
  const beforeDigest = prepared.beforeDigest;

  // In Full mode: check if agent modified memory files
  if (mode !== "complement" && beforeDigest) {
    // Skip expensive re-read if no file-modifying tools ran during this turn
    if (prepared.turnUsedTools !== false) {
      try {
        const fileSet = prepared.fileSet ?? resolveMemoryFiles(rootDir, config);
        const snapshot = await readMemorySnapshot(fileSet, config?.inject?.maxBytes);
        if (snapshot.digest !== beforeDigest) {
          const state = await loadThreadMemoryState(threadId);
          state.lastInjectedDigest = snapshot.digest;
          state.lastKnownDigest = snapshot.digest;
          await saveThreadMemoryState(threadId, state);
          console.log(`[memory] agent updated memory files (new digest: ${snapshot.digest})`);
        }
      } catch (err) {
        console.error(`[memory] finalizeMemoryForTurn digest check error:`, (err as Error).message);
      }
    }
  }

  // Check context pressure (both modes)
  if (config?.compact?.enabled === false) return "none";

  try {
    const info = agent.getInfo?.(threadId) ?? {};
    const pressure = classifyContextPressure(
      {
        contextTokens: typeof info.contextTokens === "number" ? info.contextTokens : null,
        contextWindow: typeof info.contextWindow === "number" ? info.contextWindow : null,
        contextPercent: typeof info.contextPercent === "number" ? info.contextPercent : null,
      },
      config?.compact,
    );
    return pressure;
  } catch {
    return "none";
  }
}

// ── Flush + compact (atomic operation) ───────────────

/**
 * Flush memory then compact. Used for proactive compaction and /compact command.
 *
 * 1. Send maintenance prompt (agent saves important context)
 * 2. Compact the session
 * 3. Mark force re-inject for Full mode
 *
 * Uses a cheaper model for flush turns if config.compact.flushModel is set.
 *
 * Returns compaction result or null if nothing to compact.
 */
export async function flushMemoryThenCompact(
  threadId: string,
  agent: AgentAdapter,
  rootDir: string,
  level: "soft" | "hard" | "emergency" | "manual",
  config?: MemoryConfig,
  onProgress?: (step: string) => void | Promise<void>,
): Promise<CompactResult | null> {
  const mode = getMode(agent);
  // Default to Sonnet for flush turns (faster). Set to null to use conversation model.
  const DEFAULT_FLUSH_MODEL = "amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0";
  const flushModel = config?.compact?.flushModel === null ? undefined : (config?.compact?.flushModel ?? DEFAULT_FLUSH_MODEL);

  /** Send flush prompt, preferring flushModel if available */
  async function sendFlush(text: string): Promise<void> {
    if (flushModel && agent.promptWithModel) {
      await agent.promptWithModel(threadId, { text }, flushModel);
    } else {
      await agent.prompt(threadId, { text });
    }
  }

  // Soft flush: just prompt to save, don't compact
  if (level === "soft") {
    const state = await loadThreadMemoryState(threadId);
    if (isSoftFlushOnCooldown(state, config?.compact)) {
      console.log(`[memory] soft flush skipped for ${threadId} — cooldown`);
      return null;
    }

    try {
      const flushText = buildFlushPrompt(mode === "unknown" ? "full" : mode, "soft");
      await sendFlush(flushText);
      state.lastSoftFlushAt = new Date().toISOString();
      await saveThreadMemoryState(threadId, state);
      console.log(`[memory] soft flush completed for ${threadId}${flushModel ? ` (model: ${flushModel})` : ""}`);
    } catch (err) {
      console.error(`[memory] soft flush failed for ${threadId}:`, (err as Error).message);
    }
    return null;
  }

  // Hard/emergency/manual: flush then compact
  if (!agent.compact) return null;

  const effectiveLevel = level === "manual" ? "hard" : level;
  const t0 = Date.now();

  // On "emergency" we skip the flush step entirely. Flush is a normal agent
  // prompt turn routed through the live session (see PiAdapter.promptWithModel
  // → entry.session.prompt). At emergency pressure the session is already at
  // or above the model's context limit, so appending any turn — including the
  // flush prompt — will be rejected by the provider (e.g. Bedrock returns
  // "prompt is too long: N tokens > 200000 maximum"). Because the catch block
  // below re-arms `pendingCompact`, this would loop forever on every user
  // turn. pi-ai's `session.compact()` builds its own summarization payload
  // from older history (keeping `keepRecentTokens` recent messages) and does
  // NOT require the live session to fit under the limit — so skipping flush
  // lets us recover. Facts-to-MEMORY.md (the whole point of flush) is a
  // best-effort nicety that the next soft/hard flush can catch up on.
  //
  // We also skip flush when state already has pendingCompact === "emergency":
  // a prior turn detected emergency pressure and could not complete (e.g. the
  // current call was triggered by /compact while stuck). Even at "hard" or
  // "manual" level, attempting the flush in that condition will hit the same
  // 200k rejection. Deferring flush to a later (successful) turn is the safe
  // recovery path.
  const stateBeforeCompact = await loadThreadMemoryState(threadId);
  const stuckInEmergency = stateBeforeCompact.pendingCompact === "emergency";
  const skipFlush = effectiveLevel === "emergency" || stuckInEmergency;

  // Hoisted so the catch block can report accurate flush vs compact timing
  // (a failure during compact() would otherwise conflate the two phases).
  let flushMs = 0;
  let compactMs = 0;

  try {
    if (!skipFlush) {
      // Step 1: flush
      const flushText = buildFlushPrompt(mode === "unknown" ? "full" : mode, effectiveLevel);
      console.log(`[memory] flushing memory for ${threadId} (level: ${level}${flushModel ? `, model: ${flushModel}` : ""})`);
      await onProgress?.("💭 Flushing memory...");
      await sendFlush(flushText);
      flushMs = Date.now() - t0;
    } else {
      console.log(`[memory] skipping flush for ${threadId} — emergency pressure, going straight to compact`);
    }

    // Step 2: compact (use flush model if compactWithModel is available)
    const flushNote = skipFlush
      ? (effectiveLevel === "emergency" ? "flush skipped (emergency)" : "flush skipped (recovery from prior emergency)")
      : `flush took ${flushMs}ms`;
    console.log(`[memory] compacting ${threadId} (${flushNote})`);
    const progressNote = skipFlush
      ? `✂️ Compacting context... (${effectiveLevel === "emergency" ? "emergency — " : "recovery — "}skipping flush)`
      : `✂️ Compacting context... (flush took ${(flushMs / 1000).toFixed(1)}s)`;
    await onProgress?.(progressNote);
    const t1 = Date.now();
    const usedCompactModel = Boolean(flushModel && agent.compactWithModel);
    const result = usedCompactModel
      ? await agent.compactWithModel!(threadId, flushModel!)
      : await agent.compact!(threadId);
    compactMs = Date.now() - t1;
    if (!result) return null;

    // Step 3: mark force re-inject (Full mode only). Reuse the state we
    // already loaded above; the compact step doesn't mutate memory-state
    // (it mutates the pi session, a separate file), so the in-memory copy
    // is still authoritative for our fields.
    if (mode !== "complement") {
      stateBeforeCompact.forceInjectReason = "after-compact";
      stateBeforeCompact.lastCompactAt = new Date().toISOString();
      stateBeforeCompact.pendingCompact = undefined;
      await saveThreadMemoryState(threadId, stateBeforeCompact);
    }

    const totalMs = Date.now() - t0;
    // Telemetry nuance: if we called agent.compactWithModel(flushModel), that's
    // what we *requested*. But per the AgentAdapter contract, a BaseAdapter-
    // derived adapter may provide only a default `compactWithModel` shim that
    // ignores modelId and delegates to compact() (see src/agents/base-adapter.ts).
    // We cannot distinguish a real override from the shim at this layer
    // without widening the adapter return type to include `modelUsed`.
    // So `timing.model` is the requested model, not a guaranteed-used one.
    // Follow-up: return {modelUsed} from compact/compactWithModel for precise
    // telemetry. At minimum we correctly report "default" when no flushModel
    // was even requested, or when compactWithModel is entirely absent.
    const timing = { flushMs, compactMs, totalMs, model: usedCompactModel ? flushModel! : "default" };
    console.log(`[memory] flush+compact done for ${threadId}: ${result.tokensBefore} → ${result.tokensAfter ?? "?"} tokens | flush=${flushMs}ms compact=${compactMs}ms total=${totalMs}ms model=${timing.model}`);

    // Persist timing log for debugging (async, fire-and-forget).
    // Schema is intentionally uniform across success and failure entries
    // (status discriminator + same field set) so jsonl parsers don't have
    // to special-case missing fields.
    appendCompactLog({
      threadId,
      level,
      effectiveLevel,
      flushSkipped: skipFlush,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter ?? null,
      ...timing,
      status: "ok",
      error: null,
    });

    return { ...result, timing };
  } catch (err) {
    const errMsg = (err as Error).message;
    console.error(`[memory] flush+compact failed for ${threadId}:`, errMsg);
    const recovery = await attemptSoftResetRecovery(err, threadId, agent, onProgress);

    appendCompactLog({
      threadId,
      level,
      effectiveLevel,
      flushSkipped: skipFlush,
      tokensBefore: null,
      tokensAfter: null,
      flushMs,    // accurate: 0 if skipped or failed before flush completed
      compactMs,  // accurate: 0 if failed before/during compact
      totalMs: Date.now() - t0,
      model: flushModel ?? "default",
      status: "failed",
      error: (recovery.attempted
        ? `${recovery.succeeded ? "soft-reset-recovered" : "soft-reset-failed"}: ${errMsg}`
        : errMsg).slice(0, 500),
    });

    try {
      if (recovery.succeeded) {
        // Soft reset cleared the overflow. Mark the next turn for memory
        // re-injection so the agent has its durable context, and clear the
        // pendingCompact flag — there's nothing left to compact now.
        stateBeforeCompact.forceInjectReason = "after-soft-reset";
        stateBeforeCompact.pendingCompact = undefined;
      } else {
        // Re-arm pendingCompact so the next turn retries.
        stateBeforeCompact.pendingCompact = effectiveLevel;
      }
      await saveThreadMemoryState(threadId, stateBeforeCompact);
    } catch {}
    return null;
  }
}

// ── Helper ───────────────────────────────────────────

function getMode(agent: AgentAdapter): MemoryMode {
  const info = agent.getInfo?.() ?? {};
  return determineMemoryMode(info);
}

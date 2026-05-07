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
import type { MemoryConfig, MemoryFileSet, MemoryMode, MemorySnapshot, PreparedTurn, PressureLevel, ThreadMemoryState } from "./types";
import { resolveMemoryFiles, readMemorySnapshot, formatDate } from "./files";
import { loadThreadMemoryState, saveThreadMemoryState } from "./state";
import { shouldInjectMemory, classifyContextPressure, isSoftFlushOnCooldown } from "./policy";
import { buildMemoryInjection, injectMemoryIntoMessage } from "./inject";
import { buildFlushPrompt } from "./prompts";
import { bootstrapMemoryFiles } from "./bootstrap";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

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
export interface CompactTiming {
  flushMs: number;
  compactMs: number;
  totalMs: number;
  model: string;
}

export async function flushMemoryThenCompact(
  threadId: string,
  agent: AgentAdapter,
  rootDir: string,
  level: "soft" | "hard" | "emergency" | "manual",
  config?: MemoryConfig,
): Promise<{ tokensBefore: number; tokensAfter: number | null; timing?: CompactTiming } | null> {
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

  try {
    // Step 1: flush
    const flushText = buildFlushPrompt(mode === "unknown" ? "full" : mode, effectiveLevel);
    console.log(`[memory] flushing memory for ${threadId} (level: ${level}${flushModel ? `, model: ${flushModel}` : ""})`);
    await sendFlush(flushText);
    const flushMs = Date.now() - t0;

    // Step 2: compact
    console.log(`[memory] compacting ${threadId} (flush took ${flushMs}ms)`);
    const t1 = Date.now();
    const result = await agent.compact(threadId);
    const compactMs = Date.now() - t1;
    if (!result) return null;

    // Step 3: mark force re-inject (Full mode only)
    if (mode !== "complement") {
      const state = await loadThreadMemoryState(threadId);
      state.forceInjectReason = "after-compact";
      state.lastCompactAt = new Date().toISOString();
      state.pendingCompact = undefined;
      await saveThreadMemoryState(threadId, state);
    }

    const totalMs = Date.now() - t0;
    const timing = { flushMs, compactMs, totalMs, model: flushModel ?? "default" };
    console.log(`[memory] flush+compact done for ${threadId}: ${result.tokensBefore} → ${result.tokensAfter ?? "?"} tokens | flush=${flushMs}ms compact=${compactMs}ms total=${totalMs}ms model=${timing.model}`);

    // Persist timing log for debugging (async, fire-and-forget)
    const logDir = join(homedir(), ".roundhouse", "logs");
    mkdir(logDir, { recursive: true })
      .then(() => {
        const entry = JSON.stringify({
          ts: new Date().toISOString(),
          threadId,
          level,
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
          ...timing,
        });
        return appendFile(join(logDir, "compact-timing.jsonl"), entry + "\n");
      })
      .catch((err) => console.warn(`[memory] timing log write failed:`, (err as Error).message));

    return { ...result, timing };
  } catch (err) {
    console.error(`[memory] flush+compact failed for ${threadId}:`, (err as Error).message);
    // Mark pending so we retry on next turn
    try {
      const state = await loadThreadMemoryState(threadId);
      state.pendingCompact = effectiveLevel;
      await saveThreadMemoryState(threadId, state);
    } catch {}
    return null;
  }
}

// ── Helper ───────────────────────────────────────────

function getMode(agent: AgentAdapter): MemoryMode {
  const info = agent.getInfo?.() ?? {};
  return determineMemoryMode(info);
}

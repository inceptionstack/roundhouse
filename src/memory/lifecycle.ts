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
import type { MemoryConfig, MemoryMode, PreparedTurn, PressureLevel, ThreadMemoryState } from "./types";
import { resolveMemoryFiles, readMemorySnapshot, formatDate } from "./files";
import { loadThreadMemoryState, saveThreadMemoryState } from "./state";
import { shouldInjectMemory, classifyContextPressure, isSoftFlushOnCooldown } from "./policy";
import { buildMemoryInjection, injectMemoryIntoMessage } from "./inject";
import { buildFlushPrompt } from "./prompts";
import { bootstrapMemoryFiles } from "./bootstrap";

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

  // Complement mode: no injection, just track digest for finalize
  // Unknown mode: also skip — we can't inject correctly before knowing if agent has memory extension
  // (mode is detected during session creation, which happens inside promptStream)
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
      return { message: injectedMessage, beforeDigest: snapshot.digest, injected: true, pendingCompact: pendingCompactLevel };
    }

    return { message, beforeDigest: snapshot.digest, injected: false, pendingCompact: pendingCompactLevel };
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
 * Returns the pressure level for the gateway to act on.
 */
export async function finalizeMemoryForTurn(
  threadId: string,
  beforeDigest: string | null,
  agent: AgentAdapter,
  rootDir: string,
  config?: MemoryConfig,
): Promise<PressureLevel> {
  if (config?.enabled === false) return "none";

  const mode = getMode(agent);

  // In Full mode: check if agent modified memory files
  if (mode !== "complement" && beforeDigest) {
    try {
      const fileSet = resolveMemoryFiles(rootDir, config);
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
 * Returns compaction result or null if nothing to compact.
 */
export async function flushMemoryThenCompact(
  threadId: string,
  agent: AgentAdapter,
  rootDir: string,
  level: "soft" | "hard" | "emergency" | "manual",
  config?: MemoryConfig,
): Promise<{ tokensBefore: number; tokensAfter: number | null } | null> {
  const mode = getMode(agent);

  // Soft flush: just prompt to save, don't compact
  if (level === "soft") {
    const state = await loadThreadMemoryState(threadId);
    if (isSoftFlushOnCooldown(state, config?.compact)) {
      console.log(`[memory] soft flush skipped for ${threadId} — cooldown`);
      return null;
    }

    try {
      const flushText = buildFlushPrompt(mode === "unknown" ? "full" : mode, "soft");
      await agent.prompt(threadId, { text: flushText });
      state.lastSoftFlushAt = new Date().toISOString();
      await saveThreadMemoryState(threadId, state);
      console.log(`[memory] soft flush completed for ${threadId}`);
    } catch (err) {
      console.error(`[memory] soft flush failed for ${threadId}:`, (err as Error).message);
    }
    return null;
  }

  // Hard/emergency/manual: flush then compact
  if (!agent.compact) return null;

  const effectiveLevel = level === "manual" ? "hard" : level;

  try {
    // Step 1: flush
    const flushText = buildFlushPrompt(mode === "unknown" ? "full" : mode, effectiveLevel);
    console.log(`[memory] flushing memory for ${threadId} (level: ${level})`);
    await agent.prompt(threadId, { text: flushText });

    // Step 2: compact
    console.log(`[memory] compacting ${threadId}`);
    const result = await agent.compact(threadId);
    if (!result) return null;

    // Step 3: mark force re-inject (Full mode only)
    if (mode !== "complement") {
      const state = await loadThreadMemoryState(threadId);
      state.forceInjectReason = "after-compact";
      state.lastCompactAt = new Date().toISOString();
      state.pendingCompact = undefined;
      await saveThreadMemoryState(threadId, state);
    }

    console.log(`[memory] flush+compact done for ${threadId}: ${result.tokensBefore} → ${result.tokensAfter ?? "?"} tokens`);
    return result;
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

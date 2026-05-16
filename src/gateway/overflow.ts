/**
 * gateway/overflow.ts — Gateway-side reactive context-overflow recovery.
 *
 * Extracted as a free function so unit tests can exercise it without booting
 * a full Gateway. Called from `Gateway.handleAgentTurnError` (the catch
 * around `agent.prompt`/`agent.promptStream`).
 *
 * Closes the v0.5.38 "soft-reset pre-turn gap": when an idle session has
 * already grown past the provider's context limit (typically via background
 * cron/boot/sub-agent activity that didn't trip soft/hard pressure
 * thresholds), the next user turn's `agent.prompt(...)` throws
 * `prompt is too long`. Before this change the gateway just posted the raw
 * provider error, perpetuating the loop. Now it classifies, calls
 * `agent.softReset(...)`, persists the right memory-state effects, and
 * routes the user to either a deferred-retry hint or the existing pre-turn
 * `pendingCompact="emergency"` recovery branch.
 *
 * See docs/design/v0.5.38-soft-reset-pre-turn-gap.md.
 */

import type { AgentAdapter } from "../types";
import { isContextOverflowError } from "../agents/shared/error-classifiers";
import { recoverFromContextOverflow } from "../agents/shared/overflow-recovery";
import type { OverflowRecoveryOutcome } from "../agents/shared/overflow-recovery";
import { loadThreadMemoryState, saveThreadMemoryState } from "../memory/state";
import { appendCompactLog } from "../memory/lifecycle";

/** Origin of an agent turn — drives recovery copy and telemetry. */
export type TurnSource = "user" | "boot" | "subagent" | "cron";

/** Telemetry level used for gateway-side overflow recoveries. */
export const GATEWAY_OVERFLOW_LEVEL = "gateway-overflow" as const;

/** Max bytes of the original provider error we surface in the chat. */
const MAX_ERROR_PREVIEW = 200;

export interface AgentTurnErrorContext {
  turnSource: TurnSource;
  /** Whether handleStreaming emitted at least one non-empty text_delta this turn. */
  hadVisibleText: boolean;
}

export interface AgentTurnErrorResult {
  /**
   * Whether the helper handled the error (classified + acted) or returned
   * unhandled (so the caller can fall back to its sanitized error post).
   * In practice this implementation always handles non-overflow errors too
   * by posting the sanitized error itself, so callers don't need a fallback.
   */
  handled: boolean;
  /** Recovery outcome, if overflow was detected; undefined for non-overflow. */
  outcome?: OverflowRecoveryOutcome;
  /** True iff we set state.pendingCompact="emergency" for the next turn. */
  armedPending: boolean;
  /** The user-facing message we posted (or empty if post failed). */
  userMessage: string;
}

/**
 * Catch-path recovery for an exception thrown by `agent.prompt()` or
 * `agent.promptStream()`. See file header.
 *
 * Strategy:
 *   1. Non-overflow → post sanitized `⚠️ Error: <msg>`. Done.
 *   2. Overflow → call recoverFromContextOverflow.
 *   3. Recovered → set forceInjectReason="after-soft-reset", clear pendingCompact.
 *   4. noop / failed AND agent.compact exists → arm pendingCompact="emergency"
 *      so the existing pre-turn branch fires on the next user message.
 *   5. unsupported (no softReset) OR (noop/failed without compact) →
 *      sanitized error.
 *   6. Telemetry: append to compact-timing.jsonl with level="gateway-overflow".
 *
 * UX: deferred retry only. We never transparently re-run the prompt because
 * a streamed turn that already emitted text or executed tools would
 * duplicate output / side effects on retry.
 */
export async function recoverFromAgentTurnOverflow(
  thread: { post: (text: string) => Promise<unknown> | unknown },
  agentThreadId: string,
  agent: AgentAdapter,
  err: unknown,
  ctx: AgentTurnErrorContext,
): Promise<AgentTurnErrorResult> {
  const errMsg = err instanceof Error ? err.message : String(err);
  const safeMsg = errMsg.split("\n")[0].slice(0, MAX_ERROR_PREVIEW);

  if (!isContextOverflowError(err)) {
    const userMsg = `⚠️ Error: ${safeMsg}`;
    await safePost(thread, userMsg);
    return { handled: true, armedPending: false, userMessage: userMsg };
  }

  const t0 = Date.now();
  const outcome = await recoverFromContextOverflow(err, agentThreadId, agent, async (step) => {
    await safePost(thread, step);
  });

  let armedPending = false;
  try {
    const state = await loadThreadMemoryState(agentThreadId);
    if (outcome.kind === "recovered") {
      state.forceInjectReason = "after-soft-reset";
      state.pendingCompact = undefined;
      await saveThreadMemoryState(agentThreadId, state);
    } else if ((outcome.kind === "noop" || outcome.kind === "failed") && agent.compact) {
      // Hand off to the proven pre-turn pendingCompact="emergency" branch
      // on the user's next message. Don't arm if compact is unavailable —
      // we'd just guarantee a second failure.
      state.pendingCompact = "emergency";
      await saveThreadMemoryState(agentThreadId, state);
      armedPending = true;
    }
  } catch (stateErr) {
    console.error(`[gateway-overflow] state write failed for ${agentThreadId}:`, (stateErr as Error).message);
  }

  // Telemetry: one line per gateway-side recovery, same schema as compact log
  // so jsonl parsers don't have to special-case missing fields.
  appendCompactLog({
    threadId: agentThreadId,
    level: GATEWAY_OVERFLOW_LEVEL,
    effectiveLevel: GATEWAY_OVERFLOW_LEVEL,
    flushSkipped: true,
    tokensBefore: null,
    tokensAfter: null,
    flushMs: 0,
    compactMs: 0,
    totalMs: Date.now() - t0,
    model: "gateway",
    status: outcome.kind === "recovered" ? "ok" : "failed",
    error: `gateway-overflow:${outcome.kind}${armedPending ? "+armed-pending" : ""}: ${errMsg}`.slice(0, 500),
  });

  const userMsg = pickUserMessage(outcome, ctx, armedPending, safeMsg);
  await safePost(thread, userMsg);
  return { handled: true, outcome, armedPending, userMessage: userMsg };
}

function pickUserMessage(
  outcome: OverflowRecoveryOutcome,
  ctx: AgentTurnErrorContext,
  armedPending: boolean,
  safeMsg: string,
): string {
  if (outcome.kind === "recovered") {
    if (ctx.turnSource !== "user") {
      return `♻️ Background turn (${ctx.turnSource}) overflowed — session recovered. Original work was not retried.`;
    }
    if (ctx.hadVisibleText) {
      return "♻️ Response was interrupted; session recovered. Resend if you want me to continue.";
    }
    return "✅ Recovered. Please resend your last message.";
  }
  if (armedPending) {
    const reason = outcome.kind === "noop"
      ? outcome.reason
      : outcome.kind === "failed"
        ? outcome.error.slice(0, 100)
        : "unknown";
    return `⚠️ Recovery armed (${outcome.kind}: ${reason}). Send any message to retry.`;
  }
  // unsupported, or noop/failed without compact — best we can do is the
  // sanitized error so the user knows something happened.
  return `⚠️ Error: ${safeMsg}`;
}

async function safePost(
  thread: { post: (text: string) => Promise<unknown> | unknown },
  text: string,
): Promise<void> {
  try {
    await thread.post(text);
  } catch {
    // Posting hints/errors must never throw out of recovery.
  }
}

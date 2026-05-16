/**
 * agents/shared/overflow-recovery.ts — Reactive context-overflow recovery helper
 *
 * Used by:
 *   - src/memory/lifecycle.ts: catch in flushMemoryThenCompact (compact itself overflowed)
 *   - src/gateway/gateway.ts:  catch around agent.prompt/agent.promptStream
 *     (the live session was already past the limit before this turn even started — typically
 *      after idle background growth via cron/boot/sub-agents)
 *
 * Pure agent-error → agent-action helper. Memory-state effects
 * (forceInjectReason="after-soft-reset", clearing pendingCompact, arming
 * pendingCompact="emergency") are the CALLER's responsibility, because the two
 * call sites need different fallback semantics:
 *   - lifecycle: re-arms pendingCompact at whatever level was failing
 *   - gateway:   only arms pendingCompact="emergency" when agent.compact exists
 *                and softReset didn't recover (so the next pre-turn branch fires)
 *
 * Returns a discriminated outcome rather than {attempted, succeeded} so callers
 * can branch precisely.
 */

import type { AgentAdapter } from "../../types";
import type { SoftResetReport } from "./session-soft-reset";
import { isContextOverflowError } from "./error-classifiers";

export type OverflowRecoveryOutcome =
  | { kind: "not-overflow" }
  | { kind: "unsupported" }                              // agent.softReset undefined
  | { kind: "recovered"; report: SoftResetReport }       // softReset returned reset:true
  | { kind: "noop"; reason: string }                     // softReset returned reset:false
  | { kind: "failed"; error: string };                   // softReset itself threw

/** Max bytes of resetErr.message we surface in `failed.error` and onProgress. */
const MAX_RESET_ERROR_PREVIEW = 200;

/**
 * Classify err and, on context-overflow, run agent.softReset to trim the
 * on-disk session jsonl.
 *
 * Emits onProgress("♻️ Session overflowed — soft-resetting to recent turns...")
 * when entering recovery, and one of the v0.5.32 trio (✅/⚠️/❌) on outcome.
 *
 * Does NOT mutate memory state. Caller is responsible for state writes.
 */
export async function recoverFromContextOverflow(
  err: unknown,
  threadId: string,
  agent: AgentAdapter,
  onProgress?: (step: string) => void | Promise<void>,
): Promise<OverflowRecoveryOutcome> {
  if (!isContextOverflowError(err)) {
    return { kind: "not-overflow" };
  }

  if (!agent.softReset) {
    return { kind: "unsupported" };
  }

  try {
    await onProgress?.("♻️ Session overflowed — soft-resetting to recent turns...");
    const report = await agent.softReset(threadId);

    if (report?.reset) {
      console.warn(`[overflow-recovery] soft-reset recovered ${threadId} from overflow`);
      const { entriesBefore, entriesAfter } = report as SoftResetReport;
      const detail = typeof entriesBefore === "number" && typeof entriesAfter === "number"
        ? ` (${entriesBefore} → ${entriesAfter} entries)`
        : "";
      await onProgress?.(`✅ Soft-reset complete${detail}. Durable memory will re-inject on next turn.`);
      return { kind: "recovered", report: report as SoftResetReport };
    }

    const reason = (report as { reason?: string } | null)?.reason ?? "unknown";
    console.warn(`[overflow-recovery] soft-reset returned no-op for ${threadId} (${reason})`);
    await onProgress?.(`⚠️ Soft-reset no-op (${reason}). Will retry compact next turn.`);
    return { kind: "noop", reason };
  } catch (resetErr) {
    const msg = resetErr instanceof Error ? resetErr.message : String(resetErr);
    console.error(`[overflow-recovery] soft-reset failed for ${threadId}:`, msg);
    await onProgress?.(`❌ Soft-reset failed: ${msg.slice(0, MAX_RESET_ERROR_PREVIEW)}. Will retry next turn.`);
    return { kind: "failed", error: msg };
  }
}

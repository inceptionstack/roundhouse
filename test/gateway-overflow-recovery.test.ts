/**
 * test/gateway-overflow-recovery.test.ts — Gateway-side overflow recovery
 *
 * Tests for `recoverFromAgentTurnOverflow` (extracted free function called
 * from `Gateway.handleAgentTurn`'s catch). Closes the v0.5.38 soft-reset
 * pre-turn gap: when an idle session has already grown past the provider
 * context limit, the next user turn's `agent.prompt(...)` throws
 * `prompt is too long`. Before this change the gateway posted the raw
 * provider error and the loop continued. Now it classifies, calls
 * `agent.softReset(...)`, persists the right state, and either tells the
 * user to resend or arms `pendingCompact="emergency"` for the next turn.
 *
 * Test surface (from the brief):
 *   - overflow-during-prompt → softReset succeeds → recovered hint
 *   - overflow-during-prompt + softReset undefined + compact available →
 *     pendingCompact="emergency" armed, hint posted
 *     (NB: with no softReset we go straight to the "unsupported" branch,
 *      which posts the sanitized error and does NOT arm pendingCompact —
 *      because then the next turn would just hit the same wall. Arming is
 *      reserved for cases where softReset existed but didn't recover.)
 *   - overflow with softReset throwing → pendingCompact armed, failure note
 *   - non-overflow error → sanitized error, no recovery
 *   - streaming overflow before any text → "please resend"
 *   - streaming overflow after partial text → "response was interrupted"
 *   - background turn (boot/subagent) overflow recovered → background copy
 */

import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { recoverFromAgentTurnOverflow, type TurnSource } from "../src/gateway/overflow";
import { loadThreadMemoryState } from "../src/memory/state";
import { ROUNDHOUSE_DIR } from "../src/config";
import { threadIdToDir } from "../src/util";
import type { AgentAdapter, AgentResponse } from "../src/types";
import type { SoftResetReport } from "../src/agents/shared/session-soft-reset";

// ── Test doubles ──────────────────────────────────────

interface FakeThread {
  posts: string[];
  post: (text: string) => Promise<void>;
}

function fakeThread(): FakeThread {
  const posts: string[] = [];
  return {
    posts,
    async post(text: string) { posts.push(text); },
  };
}

interface FakeAdapterOpts {
  softReset?: AgentAdapter["softReset"];
  hasCompact?: boolean;
}

function fakeAdapter(opts: FakeAdapterOpts = {}): AgentAdapter {
  const a: Partial<AgentAdapter> = {
    name: "fake",
    async prompt(): Promise<AgentResponse> { return { text: "" }; },
    async dispose() {},
    softReset: opts.softReset,
  };
  if (opts.hasCompact) {
    a.compact = async () => ({ tokensBefore: 100, tokensAfter: 5 });
  }
  return a as AgentAdapter;
}

function bedrockOverflow(): Error {
  const e = new Error("Validation error: The model returned the following errors: prompt is too long: 215725 tokens > 200000 maximum");
  (e as any).name = "ValidationException";
  (e as any).$metadata = { httpStatusCode: 400 };
  // Cause chain (matches what the pi adapter raises in practice).
  (e as any).cause = new Error("prompt is too long: 215725 tokens > 200000 maximum");
  return e;
}

const successReport: SoftResetReport = {
  reset: true,
  reason: "kept-8-user-turns",
  entriesBefore: 1024,
  entriesAfter: 17,
  bytesBefore: 2_900_000,
  bytesAfter: 215_000,
};

// ── Cleanup ──────────────────────────────────────────

const createdThreads: string[] = [];

afterEach(async () => {
  for (const id of createdThreads.splice(0)) {
    const path = resolve(ROUNDHOUSE_DIR, "memory-state", `${threadIdToDir(id)}.json`);
    await rm(path, { force: true });
  }
});

function uniqueThreadId(tag: string): string {
  const id = `test:gw-overflow:${tag}:${randomUUID()}`;
  createdThreads.push(id);
  return id;
}

// ── Tests ────────────────────────────────────────────

describe("recoverFromAgentTurnOverflow", () => {
  it("gateway_OverflowDuringNonStreamingPrompt_SoftResetSucceeds_PostsRecoveredHint", async () => {
    const thread = fakeThread();
    const tid = uniqueThreadId("ok");
    const agent = fakeAdapter({
      softReset: async () => successReport,
      hasCompact: true,
    });

    const result = await recoverFromAgentTurnOverflow(thread, tid, agent, bedrockOverflow(), {
      turnSource: "user",
      hadVisibleText: false,
    });

    expect(result.handled).toBe(true);
    expect(result.outcome?.kind).toBe("recovered");
    expect(result.armedPending).toBe(false);

    // ♻️ start, ✅ helper completion, then ✅ "Recovered. Please resend"
    expect(thread.posts).toEqual([
      expect.stringMatching(/Session overflowed/),
      expect.stringMatching(/Soft-reset complete/),
      "✅ Recovered. Please resend your last message.",
    ]);

    // State updated: forceInjectReason set, pendingCompact cleared.
    const state = await loadThreadMemoryState(tid);
    expect(state.forceInjectReason).toBe("after-soft-reset");
    expect(state.pendingCompact).toBeUndefined();
  });

  it("gateway_OverflowDuringNonStreamingPrompt_SoftResetUnsupportedNoCompact_PostsClearGuidance", async () => {
    // Adapter has neither softReset nor compact — surface a clear hint to
    // the user instead of the raw provider error. (F3 regression.)
    const thread = fakeThread();
    const tid = uniqueThreadId("unsupported-nocompact");
    const agent = fakeAdapter({}); // no softReset, no compact

    const result = await recoverFromAgentTurnOverflow(thread, tid, agent, bedrockOverflow(), {
      turnSource: "user",
      hadVisibleText: false,
    });

    expect(result.outcome?.kind).toBe("unsupported");
    expect(result.armedPending).toBe(false);
    expect(thread.posts).toHaveLength(1);
    expect(thread.posts[0]).toBe(
      "⚠️ Session full — adapter doesn't support automatic recovery. Run /compact manually or restart session.",
    );
    // Raw provider error should NOT leak through this path.
    expect(thread.posts[0]).not.toMatch(/prompt is too long/);

    const state = await loadThreadMemoryState(tid);
    expect(state.pendingCompact).toBeUndefined();
  });

  it("gateway_OverflowDuringNonStreamingPrompt_SoftResetFails_AdapterHasCompact_ArmsPendingCompactAndPostsFailureHint", async () => {
    const thread = fakeThread();
    const tid = uniqueThreadId("failed-arm");
    const agent = fakeAdapter({
      softReset: async () => { throw new Error("disk full"); },
      hasCompact: true,
    });

    const result = await recoverFromAgentTurnOverflow(thread, tid, agent, bedrockOverflow(), {
      turnSource: "user",
      hadVisibleText: false,
    });

    expect(result.outcome?.kind).toBe("failed");
    expect(result.armedPending).toBe(true);

    // Last post is the "Recovery armed" hint.
    expect(thread.posts.at(-1)).toMatch(/Recovery armed \(failed:/);
    expect(thread.posts.at(-1)).toMatch(/disk full/);

    // pendingCompact armed for next-turn pre-check branch.
    const state = await loadThreadMemoryState(tid);
    expect(state.pendingCompact).toBe("emergency");
  });

  it("gateway_OverflowWithSoftResetReturningResetFalse_AdapterHasCompact_ArmsPendingCompactWithNoopReason", async () => {
    const thread = fakeThread();
    const tid = uniqueThreadId("noop-arm");
    const agent = fakeAdapter({
      softReset: async () => ({
        reset: false,
        reason: "session-too-small",
        entriesBefore: 3,
        entriesAfter: 3,
        bytesBefore: 1024,
        bytesAfter: 1024,
      }),
      hasCompact: true,
    });

    const result = await recoverFromAgentTurnOverflow(thread, tid, agent, bedrockOverflow(), {
      turnSource: "user",
      hadVisibleText: false,
    });

    expect(result.outcome?.kind).toBe("noop");
    expect(result.armedPending).toBe(true);
    expect(thread.posts.at(-1)).toMatch(/Recovery armed \(noop: session-too-small\)/);

    const state = await loadThreadMemoryState(tid);
    expect(state.pendingCompact).toBe("emergency");
  });

  it("gateway_OverflowWithSoftResetFailing_AdapterHasNoCompact_DoesNotArmAndPostsSanitizedError", async () => {
    // softReset existed and threw; no compact for fallback. Don't arm
    // pendingCompact (would just guarantee a second failure on retry).
    const thread = fakeThread();
    const tid = uniqueThreadId("failed-nocompact");
    const agent = fakeAdapter({
      softReset: async () => { throw new Error("io"); },
      // no compact
    });

    const result = await recoverFromAgentTurnOverflow(thread, tid, agent, bedrockOverflow(), {
      turnSource: "user",
      hadVisibleText: false,
    });

    expect(result.outcome?.kind).toBe("failed");
    expect(result.armedPending).toBe(false);
    expect(thread.posts.at(-1)).toMatch(/^⚠️ Error:/);

    const state = await loadThreadMemoryState(tid);
    expect(state.pendingCompact).toBeUndefined();
  });

  it("gateway_NonOverflowError_PostsSanitizedError_NoRecoveryAttempted", async () => {
    const thread = fakeThread();
    const tid = uniqueThreadId("non-overflow");
    let softResetCalls = 0;
    const agent = fakeAdapter({
      softReset: async () => { softResetCalls++; return successReport; },
      hasCompact: true,
    });

    const result = await recoverFromAgentTurnOverflow(thread, tid, agent, new Error("network timeout"), {
      turnSource: "user",
      hadVisibleText: false,
    });

    expect(result.outcome).toBeUndefined();
    expect(result.armedPending).toBe(false);
    expect(softResetCalls).toBe(0);
    expect(thread.posts).toEqual(["⚠️ Error: network timeout"]);

    // No state mutation for non-overflow errors.
    const state = await loadThreadMemoryState(tid);
    expect(state.pendingCompact).toBeUndefined();
    expect(state.forceInjectReason).toBeUndefined();
  });

  it("gateway_OverflowDuringStream_BeforeAnyTextDelta_PostsRetryHint", async () => {
    const thread = fakeThread();
    const tid = uniqueThreadId("stream-clean");
    const agent = fakeAdapter({
      softReset: async () => successReport,
      hasCompact: true,
    });

    await recoverFromAgentTurnOverflow(thread, tid, agent, bedrockOverflow(), {
      turnSource: "user",
      hadVisibleText: false,
    });

    expect(thread.posts.at(-1)).toBe("✅ Recovered. Please resend your last message.");
  });

  it("gateway_OverflowDuringStream_AfterPartialTextDelta_PostsInterruptionHint", async () => {
    // The user already saw partial assistant text before the stream threw.
    // Asking them to "resend your last message" would be misleading; we tell
    // them the response was interrupted and let them choose to resend.
    const thread = fakeThread();
    const tid = uniqueThreadId("stream-partial");
    const agent = fakeAdapter({
      softReset: async () => successReport,
      hasCompact: true,
    });

    await recoverFromAgentTurnOverflow(thread, tid, agent, bedrockOverflow(), {
      turnSource: "user",
      hadVisibleText: true,
    });

    expect(thread.posts.at(-1)).toMatch(/Response was interrupted; session recovered/);
  });

  it("gateway_BackgroundTurn_OverflowRecovered_PostsBackgroundCopy_NotRetryHint", async () => {
    // Background sources (boot, subagent) are not interactive — telling
    // the "user" to resend would be wrong. The original work is dropped, but
    // the session is now recoverable for the next interaction.
    // (Cron jobs use their own session via cron/runner.ts and never reach
    // Gateway.handleAgentTurn, so `cron` is not a TurnSource here.)
    const thread = fakeThread();
    const tid = uniqueThreadId("background");
    const agent = fakeAdapter({
      softReset: async () => successReport,
      hasCompact: true,
    });

    for (const src of ["boot", "subagent"] satisfies TurnSource[]) {
      thread.posts.length = 0;
      await recoverFromAgentTurnOverflow(thread, tid, agent, bedrockOverflow(), {
        turnSource: src,
        hadVisibleText: false,
      });
      expect(thread.posts.at(-1)).toMatch(new RegExp(`Background turn \\(${src}\\) overflowed`));
      expect(thread.posts.at(-1)).toMatch(/Original work was not retried/);
    }
  });

  it("gateway_PostThrowsDuringRecovery_DoesNotPropagate", async () => {
    // Recovery must be best-effort on posts. If the underlying transport
    // rejects (e.g. user blocked the bot), recovery still updates state.
    const tid = uniqueThreadId("post-throws");
    const agent = fakeAdapter({
      softReset: async () => successReport,
      hasCompact: true,
    });
    const flakyThread = {
      post: async () => { throw new Error("transport closed"); },
    };

    const result = await recoverFromAgentTurnOverflow(flakyThread, tid, agent, bedrockOverflow(), {
      turnSource: "user",
      hadVisibleText: false,
    });

    expect(result.outcome?.kind).toBe("recovered");
    const state = await loadThreadMemoryState(tid);
    expect(state.forceInjectReason).toBe("after-soft-reset");
  });

  it("gateway_OverflowInCauseChain_StillTriggersRecovery", async () => {
    // Regression: the wrapped Bedrock error has the actual "prompt is too
    // long" string only on .cause, not on top-level .message in some
    // pi-adapter paths. Classifier (v0.5.30) walks the cause chain.
    const thread = fakeThread();
    const tid = uniqueThreadId("cause-chain");
    const agent = fakeAdapter({
      softReset: async () => successReport,
      hasCompact: true,
    });

    const wrapped = new Error("Validation error: The model returned the following errors");
    (wrapped as any).name = "ValidationException";
    (wrapped as any).$metadata = { httpStatusCode: 400 };
    (wrapped as any).cause = new Error("prompt is too long: 211867 tokens > 200000 maximum");

    const result = await recoverFromAgentTurnOverflow(thread, tid, agent, wrapped, {
      turnSource: "user",
      hadVisibleText: false,
    });

    expect(result.outcome?.kind).toBe("recovered");
  });
});

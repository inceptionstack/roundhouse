/**
 * test/overflow-recovery.test.ts — Unit tests for recoverFromContextOverflow
 *
 * The shared helper extracted from src/memory/lifecycle.ts in v0.5.38 so that
 * both the compact-time catch (existing v0.5.32 path) and the new gateway
 * prompt-time catch can share classification + softReset orchestration.
 *
 * Test surface mirrors the v0.5.32 progress-message regression set plus the
 * brief's required cases: overflow-during-prompt, softReset-not-available,
 * softReset-fails, non-overflow-error.
 */

import { describe, it, expect } from "vitest";
import { recoverFromContextOverflow } from "../src/agents/shared/overflow-recovery";
import type { AgentAdapter } from "../src/types";
import type { SoftResetReport } from "../src/agents/shared/session-soft-reset";

// ── Test doubles ──────────────────────────────────────

function fakeAdapter(opts: {
  softReset?: AgentAdapter["softReset"];
} = {}): AgentAdapter {
  return {
    name: "fake",
    async prompt() { return { text: "" }; },
    async dispose() {},
    softReset: opts.softReset,
  } as AgentAdapter;
}

/** Bedrock-shaped overflow error with cause chain (v0.5.30 regression). */
function bedrockOverflow(): Error {
  const inner = new Error("prompt is too long: 215725 tokens > 200000 maximum");
  const wrapper = new Error("Validation error: The model returned the following errors: prompt is too long: 215725 tokens > 200000 maximum");
  (wrapper as any).cause = inner;
  (wrapper as any).name = "ValidationException";
  (wrapper as any).$metadata = { httpStatusCode: 400 };
  return wrapper;
}

// ── Tests ────────────────────────────────────────────

describe("recoverFromContextOverflow", () => {
  it("recoverFromContextOverflow_OnNonOverflowError_ReturnsNotOverflow", async () => {
    const calls: string[] = [];
    const agent = fakeAdapter({
      softReset: async () => {
        calls.push("softReset");
        return { reset: true } as SoftResetReport;
      },
    });
    const out = await recoverFromContextOverflow(new Error("network timeout"), "t1", agent);
    expect(out.kind).toBe("not-overflow");
    expect(calls).toEqual([]);
  });

  it("recoverFromContextOverflow_AdapterWithoutSoftReset_ReturnsUnsupported", async () => {
    const agent = fakeAdapter({}); // no softReset
    const out = await recoverFromContextOverflow(bedrockOverflow(), "t1", agent);
    expect(out.kind).toBe("unsupported");
  });

  it("recoverFromContextOverflow_SoftResetSucceeds_ReturnsRecoveredWithReport_AndEmitsCheckmarkProgress", async () => {
    const progress: string[] = [];
    const agent = fakeAdapter({
      softReset: async () => ({
        reset: true,
        reason: "kept-8-user-turns",
        entriesBefore: 1024,
        entriesAfter: 17,
        bytesBefore: 2_900_000,
        bytesAfter: 215_000,
      }),
    });
    const out = await recoverFromContextOverflow(bedrockOverflow(), "t1", agent, async (s) => { progress.push(s); });
    expect(out.kind).toBe("recovered");
    if (out.kind === "recovered") {
      expect(out.report.entriesAfter).toBe(17);
    }
    // Two messages: ♻️ start, ✅ complete
    expect(progress.length).toBe(2);
    expect(progress[0]).toMatch(/Session overflowed/);
    expect(progress[1]).toMatch(/Soft-reset complete/);
    expect(progress[1]).toMatch(/1024 → 17 entries/);
  });

  it("recoverFromContextOverflow_SoftResetReturnsResetFalse_ReturnsNoopWithReason_AndEmitsWarnProgress", async () => {
    const progress: string[] = [];
    const agent = fakeAdapter({
      softReset: async () => ({
        reset: false,
        reason: "session-too-small",
        entriesBefore: 3,
        entriesAfter: 3,
        bytesBefore: 1024,
        bytesAfter: 1024,
      }),
    });
    const out = await recoverFromContextOverflow(bedrockOverflow(), "t1", agent, async (s) => { progress.push(s); });
    expect(out.kind).toBe("noop");
    if (out.kind === "noop") expect(out.reason).toBe("session-too-small");
    expect(progress[1]).toMatch(/Soft-reset no-op \(session-too-small\)/);
  });

  it("recoverFromContextOverflow_SoftResetThrows_ReturnsFailedWithMessage_AndEmitsErrorProgress", async () => {
    const progress: string[] = [];
    const agent = fakeAdapter({
      softReset: async () => { throw new Error("disk full"); },
    });
    const out = await recoverFromContextOverflow(bedrockOverflow(), "t1", agent, async (s) => { progress.push(s); });
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") expect(out.error).toBe("disk full");
    expect(progress[1]).toMatch(/Soft-reset failed: disk full/);
  });

  it("recoverFromContextOverflow_SoftResetThrowsNonError_DoesNotMaskWithTypeError", async () => {
    // Regression: softReset throws a non-Error (string). We must String() it,
    // not blindly access .message which would throw TypeError and mask the
    // original failure. (v0.5.32 regression for the lifecycle helper.)
    const progress: string[] = [];
    const agent = fakeAdapter({
      softReset: async () => { throw "raw string failure"; },
    });
    const out = await recoverFromContextOverflow(bedrockOverflow(), "t1", agent, async (s) => { progress.push(s); });
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") expect(out.error).toBe("raw string failure");
  });

  it("recoverFromContextOverflow_OverflowInCauseChain_StillClassifies", async () => {
    // Regression for v0.5.30: classifier walks .cause chain and inspects
    // serialized error fields. A bare top-level message of "Validation error"
    // wouldn't match the patterns by itself; the inner cause "prompt is too
    // long" must be reached.
    const calls: string[] = [];
    const agent = fakeAdapter({
      softReset: async () => {
        calls.push("softReset");
        return { reset: true, reason: "ok", entriesBefore: 100, entriesAfter: 8, bytesBefore: 9_999_999, bytesAfter: 9_999 } as SoftResetReport;
      },
    });

    const wrapped = new Error("Validation error: The model returned the following errors");
    (wrapped as any).cause = new Error("prompt is too long: 211867 tokens > 200000 maximum");
    (wrapped as any).name = "ValidationException";
    (wrapped as any).$metadata = { httpStatusCode: 400 };

    const out = await recoverFromContextOverflow(wrapped, "t1", agent);
    expect(out.kind).toBe("recovered");
    expect(calls).toEqual(["softReset"]);
  });

  it("recoverFromContextOverflow_NoProgressCallback_StillReturnsCorrectOutcome", async () => {
    // Optional onProgress: helper must handle undefined gracefully.
    const agent = fakeAdapter({
      softReset: async () => ({ reset: true, reason: "ok", entriesBefore: 50, entriesAfter: 8, bytesBefore: 1, bytesAfter: 1 }),
    });
    const out = await recoverFromContextOverflow(bedrockOverflow(), "t1", agent);
    expect(out.kind).toBe("recovered");
  });
});

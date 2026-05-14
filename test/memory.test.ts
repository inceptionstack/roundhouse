/**
 * test/memory.test.ts — Unit tests for memory system
 */

import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { shouldInjectMemory, classifyContextPressure, isSoftFlushOnCooldown } from "../src/memory/policy";
import { buildMemoryInjection, injectMemoryIntoMessage } from "../src/memory/inject";
import { buildFlushPrompt } from "../src/memory/prompts";
import { determineMemoryMode, flushMemoryThenCompact } from "../src/memory/lifecycle";
import { loadThreadMemoryState } from "../src/memory/state";
import { ROUNDHOUSE_DIR } from "../src/config";
import { threadIdToDir } from "../src/util";
import type { ThreadMemoryState, MemorySnapshot } from "../src/memory/types";
import type { AgentAdapter, AgentResponse } from "../src/types";

// ── Mode detection ───────────────────────────────────

describe("determineMemoryMode", () => {
  it("returns complement when hasMemoryExtension is true", () => {
    expect(determineMemoryMode({ hasMemoryExtension: true })).toBe("complement");
  });

  it("returns full when hasMemoryExtension is false", () => {
    expect(determineMemoryMode({ hasMemoryExtension: false })).toBe("full");
  });

  it("returns unknown when hasMemoryExtension is null", () => {
    expect(determineMemoryMode({ hasMemoryExtension: null })).toBe("unknown");
  });

  it("returns unknown when no info", () => {
    expect(determineMemoryMode({})).toBe("unknown");
  });
});

// ── Injection policy ─────────────────────────────────

describe("shouldInjectMemory", () => {
  it("injects on first time (no previous digest)", () => {
    const state: ThreadMemoryState = {};
    const result = shouldInjectMemory(state, "abc123");
    expect(result.inject).toBe(true);
    expect(result.reason).toBe("first-injection");
  });

  it("injects when force flag is set", () => {
    const state: ThreadMemoryState = {
      lastInjectedDigest: "abc123",
      forceInjectReason: "after-compact",
    };
    const result = shouldInjectMemory(state, "abc123");
    expect(result.inject).toBe(true);
    expect(result.reason).toBe("after-compact");
  });

  it("injects when digest changed", () => {
    const state: ThreadMemoryState = { lastInjectedDigest: "old" };
    const result = shouldInjectMemory(state, "new");
    expect(result.inject).toBe(true);
    expect(result.reason).toBe("changed");
  });

  it("injects on date boundary", () => {
    const state: ThreadMemoryState = {
      lastInjectedDigest: "abc123",
      lastSeenLocalDate: "2026-04-26",
    };
    const now = new Date("2026-04-27T10:00:00Z");
    const result = shouldInjectMemory(state, "abc123", now);
    expect(result.inject).toBe(true);
    expect(result.reason).toBe("date-boundary");
  });

  it("skips when nothing changed", () => {
    const state: ThreadMemoryState = {
      lastInjectedDigest: "abc123",
      lastSeenLocalDate: "2026-04-27",
    };
    const now = new Date("2026-04-27T14:00:00Z");
    const result = shouldInjectMemory(state, "abc123", now);
    expect(result.inject).toBe(false);
  });
});

// ── Context pressure ─────────────────────────────────

describe("classifyContextPressure", () => {
  it("returns none when no data", () => {
    expect(classifyContextPressure({ contextTokens: null, contextWindow: null, contextPercent: null }))
      .toBe("none");
  });

  it("returns none when usage is low", () => {
    expect(classifyContextPressure({ contextTokens: 10000, contextWindow: 200000, contextPercent: 5 }))
      .toBe("none");
  });

  it("returns soft at 45%", () => {
    expect(classifyContextPressure({ contextTokens: 90000, contextWindow: 200000, contextPercent: 45 }))
      .toBe("soft");
  });

  it("returns hard at 50%", () => {
    expect(classifyContextPressure({ contextTokens: 100000, contextWindow: 200000, contextPercent: 50 }))
      .toBe("hard");
  });

  it("returns hard at absolute token threshold", () => {
    // 200K tokens on 1M window = 20% — below percent threshold but above absolute
    expect(classifyContextPressure({ contextTokens: 200000, contextWindow: 1000000, contextPercent: 20 }))
      .toBe("hard");
  });

  it("returns emergency when remaining below threshold", () => {
    expect(classifyContextPressure({ contextTokens: 180000, contextWindow: 200000, contextPercent: 90 }))
      .toBe("emergency");
  });

  it("uses custom thresholds from config", () => {
    const config = { softPercent: 0.30, softTokens: 50000, hardPercent: 0.40, hardTokens: 80000 };
    expect(classifyContextPressure({ contextTokens: 35000, contextWindow: 100000, contextPercent: 35 }, config))
      .toBe("soft");
    expect(classifyContextPressure({ contextTokens: 45000, contextWindow: 100000, contextPercent: 45 }, config))
      .toBe("hard");
  });

  it("clamps absolute thresholds to window minus headroom on small-window models", () => {
    // 128k window: default hardTokens=150_000 would exceed window. Clamp to
    // window - 50k headroom = 78k. tokens=80k should fire hard via the
    // clamped absolute threshold even though percent (62.5%) is also above
    // the 50% hardPercent (so this also exercises the OR branch).
    expect(classifyContextPressure({ contextTokens: 80_000, contextWindow: 128_000, contextPercent: 62 }))
      .toBe("hard");
    // tokens=75k on 128k window: percent ~58% → still hard via percent.
    // Switch to a percent below hardPct to isolate the absolute clamp:
    expect(classifyContextPressure({ contextTokens: 79_000, contextWindow: 128_000, contextPercent: 40 }))
      .toBe("hard");
  });

  it("never reports hard threshold above window on tiny-window models", () => {
    // 64k window: ceiling = max(0, 64_000 - 50_000) = 14_000.
    // tokens=15k, percent=23% — below hardPct (50%), but above clamped hardTok.
    expect(classifyContextPressure({ contextTokens: 15_000, contextWindow: 64_000, contextPercent: 23 }))
      .toBe("hard");
  });
});

// ── Cooldown ─────────────────────────────────────────

describe("isSoftFlushOnCooldown", () => {
  it("returns false when no previous flush", () => {
    expect(isSoftFlushOnCooldown({})).toBe(false);
  });

  it("returns true when within cooldown", () => {
    const state: ThreadMemoryState = {
      lastSoftFlushAt: new Date(Date.now() - 60_000).toISOString(), // 1 min ago
    };
    expect(isSoftFlushOnCooldown(state)).toBe(true);
  });

  it("returns false when cooldown expired", () => {
    const state: ThreadMemoryState = {
      lastSoftFlushAt: new Date(Date.now() - 20 * 60_000).toISOString(), // 20 min ago
    };
    expect(isSoftFlushOnCooldown(state)).toBe(false);
  });
});

// ── Injection building ───────────────────────────────

describe("buildMemoryInjection", () => {
  it("builds XML-wrapped block with entries", () => {
    const snapshot: MemorySnapshot = {
      entries: [
        { label: "MEMORY.md", content: "# Memory\n- user prefers TypeScript" },
        { label: "daily/2026-04-27.md", content: "# Daily Note\n## Headlines\n### Built memory system" },
      ],
      digest: "abc123def456",
    };
    const result = buildMemoryInjection(snapshot, "first-injection");
    expect(result).toContain("<roundhouse_memory");
    expect(result).toContain('v="abc123def456"');
    expect(result).toContain('reason="first-injection"');
    expect(result).toContain("## MEMORY.md");
    expect(result).toContain("user prefers TypeScript");
    expect(result).toContain("## daily/2026-04-27.md");
    expect(result).toContain("supersedes any prior");
    expect(result).toContain("</roundhouse_memory>");
  });

  it("returns empty string for empty snapshot", () => {
    const snapshot: MemorySnapshot = { entries: [], digest: "empty" };
    expect(buildMemoryInjection(snapshot, "test")).toBe("");
  });
});

describe("injectMemoryIntoMessage", () => {
  it("prepends injection to message text", () => {
    const msg = { text: "Hello" };
    const result = injectMemoryIntoMessage(msg, "<memory>facts</memory>");
    expect(result.text).toBe("<memory>facts</memory>\n\nHello");
  });

  it("passes through when no injection", () => {
    const msg = { text: "Hello" };
    const result = injectMemoryIntoMessage(msg, "");
    expect(result).toBe(msg); // same reference
  });
});

// ── Flush prompts ────────────────────────────────────

describe("buildFlushPrompt", () => {
  it("builds complement mode prompt without preferences", () => {
    const result = buildFlushPrompt("complement", "hard");
    expect(result).toContain("narrative context");
    expect(result).toContain("Do NOT save individual preferences");
    expect(result).toContain("memory extension handles those");
  });

  it("builds full mode prompt with preferences", () => {
    const result = buildFlushPrompt("full", "hard");
    expect(result).toContain("User preferences");
    expect(result).toContain("Corrections or lessons");
    expect(result).not.toContain("memory extension");
  });

  it("adds urgency prefix for emergency", () => {
    const result = buildFlushPrompt("full", "emergency");
    expect(result).toContain("URGENT");
  });

  it("no urgency for soft", () => {
    const result = buildFlushPrompt("full", "soft");
    expect(result).not.toContain("URGENT");
    expect(result).not.toContain("Context is filling");
  });
});

// ── READ_ONLY_TOOLS ─────────────────────────────────

import { READ_ONLY_TOOLS } from "../src/memory/types";
import type { CompactResult, CompactTiming } from "../src/memory/types";

describe("READ_ONLY_TOOLS", () => {
  it("contains expected read-only tools", () => {
    expect(READ_ONLY_TOOLS.has("read")).toBe(true);
    expect(READ_ONLY_TOOLS.has("grep")).toBe(true);
    expect(READ_ONLY_TOOLS.has("find")).toBe(true);
    expect(READ_ONLY_TOOLS.has("ls")).toBe(true);
    expect(READ_ONLY_TOOLS.has("glob")).toBe(true);
  });

  it("does NOT contain file-modifying tools", () => {
    expect(READ_ONLY_TOOLS.has("write")).toBe(false);
    expect(READ_ONLY_TOOLS.has("edit")).toBe(false);
    expect(READ_ONLY_TOOLS.has("bash")).toBe(false);
    expect(READ_ONLY_TOOLS.has("multi_edit")).toBe(false);
  });

  it("does NOT contain unknown/extension tools (safe default: assume writing)", () => {
    expect(READ_ONLY_TOOLS.has("my_custom_tool")).toBe(false);
    expect(READ_ONLY_TOOLS.has("")).toBe(false);
  });
});

// ── CompactResult type ───────────────────────────────

describe("CompactResult", () => {
  it("allows result without timing (backwards compat)", () => {
    const result: CompactResult = { tokensBefore: 80000, tokensAfter: 5000 };
    expect(result.timing).toBeUndefined();
  });

  it("allows result with timing", () => {
    const timing: CompactTiming = { flushMs: 3000, compactMs: 5000, totalMs: 8000, model: "haiku" };
    const result: CompactResult = { tokensBefore: 80000, tokensAfter: 5000, timing };
    expect(result.timing!.flushMs).toBe(3000);
    expect(result.timing!.model).toBe("haiku");
  });
});

// ── flushMemoryThenCompact: emergency skips flush ──────────────

/**
 * Regression tests for the emergency-compact loop bug:
 * at emergency pressure the live session is already over the model's context
 * limit, so sending a flush prompt through the same session would be rejected
 * by the provider, set pendingCompact = "emergency", and loop forever.
 * Fix: on emergency, skip flush and go straight to compact.
 * See src/memory/lifecycle.ts flushMemoryThenCompact().
 */
describe("flushMemoryThenCompact emergency path", () => {
  const createdThreads: string[] = [];

  afterEach(async () => {
    // Clean up any memory-state files the tests created.
    for (const id of createdThreads.splice(0)) {
      const path = resolve(ROUNDHOUSE_DIR, "memory-state", `${threadIdToDir(id)}.json`);
      await rm(path, { force: true });
    }
  });

  interface FakeAdapter extends AgentAdapter {
    calls: { method: "promptWithModel" | "prompt" | "compactWithModel" | "compact" | "softReset"; args: unknown[] }[];
  }

  function makeFakeAdapter(): FakeAdapter {
    const calls: FakeAdapter["calls"] = [];
    const adapter: Partial<FakeAdapter> = {
      name: "fake",
      calls,
      // Full mode (no built-in memory) so pendingCompact is cleared on success.
      getInfo: () => ({ hasMemoryExtension: false }) as any,
      async prompt(threadId, message): Promise<AgentResponse> {
        calls.push({ method: "prompt", args: [threadId, message] });
        return { text: "" };
      },
      async promptWithModel(threadId, message, modelId): Promise<AgentResponse> {
        calls.push({ method: "promptWithModel", args: [threadId, message, modelId] });
        return { text: "" };
      },
      async compact(threadId) {
        calls.push({ method: "compact", args: [threadId] });
        return { tokensBefore: 216000, tokensAfter: 5000 };
      },
      async compactWithModel(threadId, modelId) {
        calls.push({ method: "compactWithModel", args: [threadId, modelId] });
        return { tokensBefore: 216000, tokensAfter: 5000 };
      },
      async softReset(threadId) {
        calls.push({ method: "softReset", args: [threadId] });
        return { reset: true };
      },
      promptStream: (() => { throw new Error("not used"); }) as any,
      dispose: async () => {},
    };
    return adapter as FakeAdapter;
  }

  function uniqueThreadId(tag: string): string {
    const id = `test:${tag}:${randomUUID()}`;
    createdThreads.push(id);
    return id;
  }

  it("emergency_doesNotSendFlushPrompt_callsCompactDirectly", async () => {
    const agent = makeFakeAdapter();
    const threadId = uniqueThreadId("emergency-skip");

    const result = await flushMemoryThenCompact(threadId, agent, "/tmp", "emergency");

    expect(result).not.toBeNull();
    const flushCalls = agent.calls.filter(c => c.method === "prompt" || c.method === "promptWithModel");
    expect(flushCalls).toHaveLength(0);
    const compactCalls = agent.calls.filter(c => c.method === "compact" || c.method === "compactWithModel");
    expect(compactCalls).toHaveLength(1);
  });

  it("emergency_clearsPendingCompact_onSuccess", async () => {
    const agent = makeFakeAdapter();
    const threadId = uniqueThreadId("emergency-clear");

    await flushMemoryThenCompact(threadId, agent, "/tmp", "emergency");
    const state = await loadThreadMemoryState(threadId);
    expect(state.pendingCompact).toBeUndefined();
    expect(state.lastCompactAt).toBeDefined();
    expect(state.forceInjectReason).toBe("after-compact");
  });

  it("emergency_recordsZeroFlushMs_inTiming", async () => {
    const agent = makeFakeAdapter();
    const threadId = uniqueThreadId("emergency-timing");

    const result = await flushMemoryThenCompact(threadId, agent, "/tmp", "emergency");
    expect(result?.timing?.flushMs).toBe(0);
    expect(result?.timing?.compactMs).toBeGreaterThanOrEqual(0);
  });

  it("hard_sendsFlushPrompt_thenCompacts", async () => {
    const agent = makeFakeAdapter();
    const threadId = uniqueThreadId("hard-normal");

    const result = await flushMemoryThenCompact(threadId, agent, "/tmp", "hard");
    expect(result).not.toBeNull();
    const methodOrder = agent.calls.map(c => c.method);
    // Expect flush (promptWithModel) to precede compact (compactWithModel)
    const flushIdx = methodOrder.findIndex(m => m === "promptWithModel" || m === "prompt");
    const compactIdx = methodOrder.findIndex(m => m === "compactWithModel" || m === "compact");
    expect(flushIdx).toBeGreaterThanOrEqual(0);
    expect(compactIdx).toBeGreaterThan(flushIdx);
  });

  it("emergency_whenCompactFails_rearmsPendingCompact", async () => {
    const agent = makeFakeAdapter();
    const threadId = uniqueThreadId("emergency-compact-fails");
    // Make compact throw to exercise the catch block
    agent.compactWithModel = async () => { throw new Error("boom"); };
    agent.compact = async () => { throw new Error("boom"); };

    const result = await flushMemoryThenCompact(threadId, agent, "/tmp", "emergency");
    expect(result).toBeNull();
    const state = await loadThreadMemoryState(threadId);
    expect(state.pendingCompact).toBe("emergency");
  });

  it("emergency_whenOnlyCompactAvailable_fallsBackAndRecordsDefaultModel", async () => {
    // Adapter exposes compact() but NOT compactWithModel() — exercise fallback branch.
    const agent = makeFakeAdapter();
    const threadId = uniqueThreadId("emergency-compact-only");
    agent.compactWithModel = undefined;

    const result = await flushMemoryThenCompact(threadId, agent, "/tmp", "emergency");

    const methods = agent.calls.map(c => c.method);
    expect(methods).toContain("compact");
    expect(methods).not.toContain("compactWithModel");
    // Telemetry: model should reflect that the flush model was NOT used for compact.
    expect(result?.timing?.model).toBe("default");
  });

  it("hard_whenOnlyPromptAvailable_usesPlainPrompt", async () => {
    // Adapter lacks promptWithModel — exercise the fallback inside sendFlush.
    const agent = makeFakeAdapter();
    const threadId = uniqueThreadId("hard-prompt-fallback");
    agent.promptWithModel = undefined;

    await flushMemoryThenCompact(threadId, agent, "/tmp", "hard");

    const methods = agent.calls.map(c => c.method);
    expect(methods).toContain("prompt");
    expect(methods).not.toContain("promptWithModel");
  });

  it("hard_whenCompactReturnsNull_doesNotMutateState", async () => {
    // Compact returns null (nothing to compact) — early-exit branch.
    const agent = makeFakeAdapter();
    const threadId = uniqueThreadId("hard-compact-null");
    agent.compactWithModel = async () => null;
    agent.compact = async () => null;

    const result = await flushMemoryThenCompact(threadId, agent, "/tmp", "hard");
    expect(result).toBeNull();
    const state = await loadThreadMemoryState(threadId);
    // Neither success (lastCompactAt) nor failure (pendingCompact) state recorded.
    expect(state.lastCompactAt).toBeUndefined();
    expect(state.pendingCompact).toBeUndefined();
  });

  it("hard_whenStateHasPendingEmergency_skipsFlushAndCompacts", async () => {
    // Stuck-in-emergency recovery: if a prior turn left pendingCompact = 'emergency',
    // even a 'hard' or 'manual' (which maps to hard) call must skip flush, because
    // the live session is still over the limit and the flush prompt will be rejected.
    const agent = makeFakeAdapter();
    const threadId = uniqueThreadId("hard-stuck-in-emergency");
    const { saveThreadMemoryState } = await import("../src/memory/state");
    await saveThreadMemoryState(threadId, { pendingCompact: "emergency" });

    const result = await flushMemoryThenCompact(threadId, agent, "/tmp", "hard");
    expect(result).not.toBeNull();

    const flushCalls = agent.calls.filter(c => c.method === "prompt" || c.method === "promptWithModel");
    expect(flushCalls).toHaveLength(0);
    const compactCalls = agent.calls.filter(c => c.method === "compact" || c.method === "compactWithModel");
    expect(compactCalls).toHaveLength(1);
  });

  it("manual_whenStateHasPendingEmergency_skipsFlushAndCompacts", async () => {
    // /compact on a stuck-emergency thread — manual maps to hard, but stuckInEmergency
    // also forces flush-skip. Same recovery semantics.
    const agent = makeFakeAdapter();
    const threadId = uniqueThreadId("manual-stuck-in-emergency");
    const { saveThreadMemoryState } = await import("../src/memory/state");
    await saveThreadMemoryState(threadId, { pendingCompact: "emergency" });

    await flushMemoryThenCompact(threadId, agent, "/tmp", "manual");

    const flushCalls = agent.calls.filter(c => c.method === "prompt" || c.method === "promptWithModel");
    expect(flushCalls).toHaveLength(0);
  });

  // ── Soft-reset recovery on context overflow ──────────────────────────

  function makeOverflowError(): Error {
    return new Error(
      "Summarization failed: Validation error: The model returned the following errors: prompt is too long: 212776 tokens > 200000 maximum"
    );
  }

  it("emergency_whenCompactOverflows_callsSoftResetAndClearsPendingCompact", async () => {
    // Arrange: compact throws context-overflow; adapter has softReset that succeeds.
    const agent = makeFakeAdapter();
    const threadId = uniqueThreadId("emergency-overflow-recover");
    agent.compactWithModel = async () => { throw makeOverflowError(); };
    agent.compact = async () => { throw makeOverflowError(); };

    // Act
    const result = await flushMemoryThenCompact(threadId, agent, "/tmp", "emergency");

    // Assert: soft reset was called, pendingCompact cleared, force re-inject queued.
    expect(result).toBeNull();
    const softResetCalls = agent.calls.filter(c => c.method === "softReset");
    expect(softResetCalls).toHaveLength(1);
    const state = await loadThreadMemoryState(threadId);
    expect(state.pendingCompact).toBeUndefined();
    expect(state.forceInjectReason).toBe("after-soft-reset");
  });

  it("emergency_whenSoftResetReturnsNoOp_rearmsPendingCompact", async () => {
    // Arrange: compact overflows, but softReset reports nothing to do (already trim).
    const agent = makeFakeAdapter();
    const threadId = uniqueThreadId("emergency-overflow-noop");
    agent.compactWithModel = async () => { throw makeOverflowError(); };
    agent.compact = async () => { throw makeOverflowError(); };
    agent.softReset = async () => ({ reset: false });

    // Act
    await flushMemoryThenCompact(threadId, agent, "/tmp", "emergency");

    // Assert: pendingCompact still re-armed for next-turn retry.
    const state = await loadThreadMemoryState(threadId);
    expect(state.pendingCompact).toBe("emergency");
    expect(state.forceInjectReason).toBeUndefined();
  });

  it("emergency_whenAdapterHasNoSoftReset_rearmsPendingCompactAsBefore", async () => {
    // Arrange: legacy adapter without softReset capability.
    const agent = makeFakeAdapter();
    const threadId = uniqueThreadId("emergency-overflow-nosoftreset");
    agent.compactWithModel = async () => { throw makeOverflowError(); };
    agent.compact = async () => { throw makeOverflowError(); };
    agent.softReset = undefined;

    // Act
    await flushMemoryThenCompact(threadId, agent, "/tmp", "emergency");

    // Assert: falls back to prior behavior — re-arm pendingCompact, no soft-reset call.
    const softResetCalls = agent.calls.filter(c => c.method === "softReset");
    expect(softResetCalls).toHaveLength(0);
    const state = await loadThreadMemoryState(threadId);
    expect(state.pendingCompact).toBe("emergency");
  });

  it("emergency_whenNonOverflowError_doesNotCallSoftReset", async () => {
    // Arrange: compact throws something unrelated (network, auth, etc).
    const agent = makeFakeAdapter();
    const threadId = uniqueThreadId("emergency-non-overflow");
    agent.compactWithModel = async () => { throw new Error("network unreachable"); };
    agent.compact = async () => { throw new Error("network unreachable"); };

    // Act
    await flushMemoryThenCompact(threadId, agent, "/tmp", "emergency");

    // Assert: soft reset NOT called (it's not the right recovery for this error).
    const softResetCalls = agent.calls.filter(c => c.method === "softReset");
    expect(softResetCalls).toHaveLength(0);
    const state = await loadThreadMemoryState(threadId);
    expect(state.pendingCompact).toBe("emergency");
  });

  it("emergency_whenSoftResetItselfThrows_rearmsPendingCompactAndDoesNotCrash", async () => {
    // Arrange: pathological case — the recovery path itself fails.
    const agent = makeFakeAdapter();
    const threadId = uniqueThreadId("emergency-softreset-throws");
    agent.compactWithModel = async () => { throw makeOverflowError(); };
    agent.compact = async () => { throw makeOverflowError(); };
    agent.softReset = async () => { throw new Error("disk full"); };

    // Act + Assert: doesn't throw out of flushMemoryThenCompact.
    const result = await flushMemoryThenCompact(threadId, agent, "/tmp", "emergency");
    expect(result).toBeNull();

    const state = await loadThreadMemoryState(threadId);
    // Soft reset failed — pendingCompact must be re-armed so user gets retry next turn.
    expect(state.pendingCompact).toBe("emergency");
  });

  it("emergency_whenSoftResetSucceeds_emitsCompletionProgressMessage", async () => {
    // Arrange: overflow + successful soft-reset; capture onProgress calls.
    const agent = makeFakeAdapter();
    const threadId = uniqueThreadId("emergency-softreset-progress-ok");
    agent.compactWithModel = async () => { throw makeOverflowError(); };
    agent.compact = async () => { throw makeOverflowError(); };
    agent.softReset = async () => ({ reset: true, entriesBefore: 626, entriesAfter: 17 });
    const progress: string[] = [];

    // Act
    await flushMemoryThenCompact(threadId, agent, "/tmp", "emergency", undefined, (s) => { progress.push(s); });

    // Assert: both start AND completion messages were emitted.
    expect(progress.some(s => s.includes("Session overflowed"))).toBe(true);
    const done = progress.find(s => s.includes("Soft-reset complete"));
    expect(done).toBeDefined();
    expect(done).toContain("626");
    expect(done).toContain("17");
  });

  it("emergency_whenSoftResetReturnsNoOp_emitsNoOpProgressMessage", async () => {
    // Arrange: overflow but soft-reset reports nothing to do.
    const agent = makeFakeAdapter();
    const threadId = uniqueThreadId("emergency-softreset-progress-noop");
    agent.compactWithModel = async () => { throw makeOverflowError(); };
    agent.compact = async () => { throw makeOverflowError(); };
    agent.softReset = async () => ({ reset: false, reason: "already-trimmed" });
    const progress: string[] = [];

    // Act
    await flushMemoryThenCompact(threadId, agent, "/tmp", "emergency", undefined, (s) => { progress.push(s); });

    // Assert: user sees the no-op outcome with reason, not silence.
    expect(progress.some(s => s.includes("Soft-reset no-op") && s.includes("already-trimmed"))).toBe(true);
  });

  it("emergency_whenSoftResetThrows_emitsFailureProgressMessage", async () => {
    // Arrange: overflow + soft-reset itself errors.
    const agent = makeFakeAdapter();
    const threadId = uniqueThreadId("emergency-softreset-progress-fail");
    agent.compactWithModel = async () => { throw makeOverflowError(); };
    agent.compact = async () => { throw makeOverflowError(); };
    agent.softReset = async () => { throw new Error("disk full"); };
    const progress: string[] = [];

    // Act
    await flushMemoryThenCompact(threadId, agent, "/tmp", "emergency", undefined, (s) => { progress.push(s); });

    // Assert: user sees the failure, not silence.
    expect(progress.some(s => s.includes("Soft-reset failed") && s.includes("disk full"))).toBe(true);
  });

  it("emergency_whenSoftResetThrowsNonError_doesNotMaskWithTypeError", async () => {
    // Regression: F1 review. If softReset throws a non-Error (string, plain object),
    // the catch handler must not crash on `.message` access — that would mask the
    // original failure with a TypeError and break the user-facing notification.
    const agent = makeFakeAdapter();
    const threadId = uniqueThreadId("emergency-softreset-throws-string");
    agent.compactWithModel = async () => { throw makeOverflowError(); };
    agent.compact = async () => { throw makeOverflowError(); };
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    agent.softReset = async () => { throw "connection reset"; };
    const progress: string[] = [];

    // Act + Assert: doesn't throw, and emits a failure message containing the string.
    const result = await flushMemoryThenCompact(
      threadId, agent, "/tmp", "emergency", undefined, (s) => { progress.push(s); }
    );
    expect(result).toBeNull();
    expect(progress.some(s => s.includes("Soft-reset failed") && s.includes("connection reset"))).toBe(true);
  });
});

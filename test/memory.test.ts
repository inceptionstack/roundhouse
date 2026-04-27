/**
 * test/memory.test.ts — Unit tests for memory system
 */

import { describe, it, expect } from "vitest";
import { shouldInjectMemory, classifyContextPressure, isSoftFlushOnCooldown } from "../src/memory/policy";
import { buildMemoryInjection, injectMemoryIntoMessage } from "../src/memory/inject";
import { buildFlushPrompt } from "../src/memory/prompts";
import { determineMemoryMode } from "../src/memory/lifecycle";
import type { ThreadMemoryState, MemorySnapshot } from "../src/memory/types";

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

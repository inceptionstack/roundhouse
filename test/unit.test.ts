import { describe, it, expect } from "vitest";
import { splitMessage, isAllowed, threadIdToDir } from "../src/util";

// ─────────────────────────────────────────────────────
// splitMessage
// ─────────────────────────────────────────────────────

describe("splitMessage", () => {
  it("returns single-element array for short text", () => {
    expect(splitMessage("hello", 100)).toEqual(["hello"]);
  });

  it("returns single-element array for text exactly at maxLen", () => {
    const text = "a".repeat(100);
    expect(splitMessage(text, 100)).toEqual([text]);
  });

  it("splits long text without newlines at maxLen boundary", () => {
    const text = "a".repeat(250);
    const chunks = splitMessage(text, 100);
    expect(chunks.join("")).toBe(text); // no data loss
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.length).toBe(3); // 100 + 100 + 50
  });

  it("prefers splitting at newline boundaries", () => {
    const text = "line1\nline2\nline3\nline4";
    const chunks = splitMessage(text, 12);
    // Non-newline content must be preserved
    const content = text.replace(/\n/g, "");
    const joined = chunks.join("").replace(/\n/g, "");
    expect(joined).toBe(content);
    expect(chunks.every((c) => c.length <= 12)).toBe(true);
  });

  it("does not produce empty chunks", () => {
    const text = "\n".repeat(10) + "hello";
    const chunks = splitMessage(text, 3);
    expect(chunks.every((c) => c.length > 0)).toBe(true);
    // Content after newline consumption must be preserved
    expect(chunks.join("")).toContain("hello");
  });

  it("handles text that is only newlines", () => {
    const text = "\n\n\n\n\n";
    const chunks = splitMessage(text, 2);
    // Newlines at split points get consumed; content may shrink
    expect(chunks.every((c) => c.length > 0)).toBe(true);
    expect(chunks.every((c) => c.length <= 2)).toBe(true);
  });

  it("handles empty string", () => {
    expect(splitMessage("", 100)).toEqual([""]);
  });

  it("handles maxLen of 1", () => {
    const text = "abc";
    const chunks = splitMessage(text, 1);
    expect(chunks).toEqual(["a", "b", "c"]);
  });

  it("does not infinite loop on leading newline with small maxLen", () => {
    const text = "\nhello world";
    const chunks = splitMessage(text, 5);
    // Must terminate and preserve non-newline content
    expect(chunks.join("")).toContain("hello");
    expect(chunks.every((c) => c.length <= 5)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────
// isAllowed
// ─────────────────────────────────────────────────────

describe("isAllowed", () => {
  it("allows all when allowlist is empty", () => {
    expect(isAllowed({ author: { userName: "anyone" } }, [])).toBe(true);
  });

  it("allows matching userName", () => {
    expect(
      isAllowed({ author: { userName: "alice" } }, ["alice"])
    ).toBe(true);
  });

  it("allows matching userId", () => {
    expect(
      isAllowed({ author: { userId: "12345" } }, ["12345"])
    ).toBe(true);
  });

  it("is case-insensitive on userName", () => {
    expect(
      isAllowed({ author: { userName: "Alice" } }, ["alice"])
    ).toBe(true);
  });

  it("blocks when userName does not match", () => {
    expect(
      isAllowed({ author: { userName: "hacker" } }, ["alice"])
    ).toBe(false);
  });

  it("does NOT allow matching on fullName (user-controlled)", () => {
    // Security: fullName is user-editable, should not be used for auth
    expect(
      isAllowed(
        { author: { userName: "hacker", fullName: "alice" } },
        ["alice"]
      )
    ).toBe(false);
  });

  it("blocks messages with no author", () => {
    expect(isAllowed({}, ["alice"])).toBe(false);
  });

  it("blocks messages with empty author", () => {
    expect(isAllowed({ author: {} }, ["alice"])).toBe(false);
  });
});

// ─────────────────────────────────────────────────────
// threadIdToDir
// ─────────────────────────────────────────────────────

describe("threadIdToDir", () => {
  it("converts a typical thread ID", () => {
    const dir = threadIdToDir("telegram:123456789");
    expect(dir).toMatch(/^[a-zA-Z0-9_-]+$/); // safe for filesystem
  });

  it("does not collide telegram:123 vs telegram_123", () => {
    const a = threadIdToDir("telegram:123");
    const b = threadIdToDir("telegram_123");
    expect(a).not.toBe(b);
  });

  it("does not collide slack:C01:123 vs slack_C01_123", () => {
    const a = threadIdToDir("slack:C01:123");
    const b = threadIdToDir("slack_C01_123");
    expect(a).not.toBe(b);
  });

  it("round-trips: different inputs → different outputs", () => {
    const inputs = [
      "telegram:111",
      "telegram_111",
      "slack:C01:ts",
      "slack_C01_ts",
      "discord:guild:chan",
    ];
    const outputs = inputs.map(threadIdToDir);
    const unique = new Set(outputs);
    expect(unique.size).toBe(inputs.length);
  });

  it("does not collide different special characters", () => {
    const a = threadIdToDir("telegram/a");
    const b = threadIdToDir("telegram?a");
    const c = threadIdToDir("telegram a");
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("produces only filesystem-safe characters", () => {
    const dir = threadIdToDir("weird/path:with spaces&stuff");
    expect(dir).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});

// ─────────────────────────────────────────────────────
// SingleAgentRouter
// ─────────────────────────────────────────────────────

describe("SingleAgentRouter", () => {
  it("always returns the same agent", async () => {
    // Inline import to avoid pulling in heavy deps at module level
    const { SingleAgentRouter } = await import("../src/router");
    const fakeAgent = {
      name: "test",
      prompt: async () => ({ text: "hi" }),
      dispose: async () => {},
    };
    const router = new SingleAgentRouter(fakeAgent);
    expect(router.resolve("thread-1")).toBe(fakeAgent);
    expect(router.resolve("thread-2")).toBe(fakeAgent);
  });

  it("dispose calls agent.dispose", async () => {
    const { SingleAgentRouter } = await import("../src/router");
    let disposed = false;
    const fakeAgent = {
      name: "test",
      prompt: async () => ({ text: "" }),
      dispose: async () => { disposed = true; },
    };
    const router = new SingleAgentRouter(fakeAgent);
    await router.dispose();
    expect(disposed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────
// Agent registry
// ─────────────────────────────────────────────────────

describe("getAgentFactory", () => {
  it("returns factory for known type", async () => {
    const { getAgentFactory } = await import("../src/agents/registry");
    const factory = getAgentFactory("pi");
    expect(typeof factory).toBe("function");
  });

  it("throws for unknown type", async () => {
    const { getAgentFactory } = await import("../src/agents/registry");
    expect(() => getAgentFactory("nonexistent")).toThrow(/Unknown agent type/);
  });
});

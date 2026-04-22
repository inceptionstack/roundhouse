import { describe, it, expect } from "vitest";

/**
 * OLD implementations copied from pre-refactor code.
 * Tests prove the bugs exist, confirming the fixes in util.ts are needed.
 */

// OLD threadIdToDir — from pi-handler.ts
function oldThreadIdToDir(threadId: string): string {
  return threadId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

// OLD isAllowed — from gateway.ts (matched on fullName)
function oldIsAllowed(
  message: { author?: { userName?: string; userId?: string; fullName?: string } },
  allowedUsers: string[]
): boolean {
  if (allowedUsers.length === 0) return true;
  const author = message.author ?? {};
  const candidates = [author.userName, author.userId, author.fullName]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase());
  return candidates.some((c) => allowedUsers.includes(c));
}

describe("OLD threadIdToDir collision bug", () => {
  it("BUG: telegram:123 and telegram_123 produce the same dir name", () => {
    const a = oldThreadIdToDir("telegram:123");
    const b = oldThreadIdToDir("telegram_123");
    expect(a).toBe(b); // COLLISION — proves the bug
  });

  it("BUG: slack:C01:ts and slack_C01_ts produce the same dir name", () => {
    const a = oldThreadIdToDir("slack:C01:ts");
    const b = oldThreadIdToDir("slack_C01_ts");
    expect(a).toBe(b); // COLLISION — proves the bug
  });
});

describe("OLD isAllowed security bug", () => {
  it("BUG: fullName spoofing bypasses auth filter", () => {
    // An attacker sets their Telegram display name to "alice"
    const result = oldIsAllowed(
      { author: { userName: "hacker", fullName: "alice" } },
      ["alice"]
    );
    expect(result).toBe(true); // BYPASS — proves the bug
  });
});

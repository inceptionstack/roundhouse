import { describe, it, expect } from "vitest";
import { splitMessage, threadIdToDir } from "../src/util";

describe("splitMessage — review #2 findings", () => {
  it("does not start chunks with a bare newline when splitting at newline boundary", () => {
    const text = "abcde\nfghij\nklmno";
    const chunks = splitMessage(text, 6);
    // After splitting at a newline, the newline should be consumed
    for (const chunk of chunks) {
      if (chunk !== chunks[0]) {
        expect(chunk.startsWith("\n")).toBe(false);
      }
    }
    // Newlines at split points are consumed, so joined length may be shorter
    // but all non-newline content must be preserved
    const contentWithout = text.replace(/\n/g, "");
    const joinedWithout = chunks.join("").replace(/\n/g, "");
    expect(joinedWithout).toBe(contentWithout);
  });

  it("throws or returns single chunk for maxLen <= 0", () => {
    // Should not infinite loop
    expect(() => splitMessage("abc", 0)).toThrow();
    expect(() => splitMessage("abc", -1)).toThrow();
  });
});

describe("threadIdToDir — review #2 findings", () => {
  it("comment accuracy: encoding uses _c for colon, _u for underscore", () => {
    // Verify the actual encoding matches documented behavior
    expect(threadIdToDir("a:b")).toBe("a_cb");
    expect(threadIdToDir("a_b")).toBe("a_ub");
  });
});

import { describe, it, expect } from "vitest";
import {
  CALLBACK_PREFIX,
  encodeCallbackData,
  toKeyboardRows,
  extractTelegramChatId,
} from "../src/gateway/inline-keyboard";

describe("inline-keyboard", () => {
  describe("encodeCallbackData", () => {
    it("prefixes with CALLBACK_PREFIX and JSON-encodes action+value", () => {
      const data = encodeCallbackData("topic_select", "deploy");
      expect(data).toBe(`${CALLBACK_PREFIX}{"a":"topic_select","v":"deploy"}`);
    });

    it("round-trips parseable JSON after the prefix", () => {
      const data = encodeCallbackData("x", "y");
      const payload = data.slice(CALLBACK_PREFIX.length);
      expect(JSON.parse(payload)).toEqual({ a: "x", v: "y" });
    });
  });

  describe("toKeyboardRows", () => {
    it("chunks buttons into 2-column rows by default", () => {
      const btns = [1, 2, 3, 4, 5].map(n => ({
        text: `b${n}`,
        callback_data: `d${n}`,
      }));
      const kb = toKeyboardRows(btns);
      expect(kb.inline_keyboard).toHaveLength(3);
      expect(kb.inline_keyboard[0]).toHaveLength(2);
      expect(kb.inline_keyboard[2]).toHaveLength(1);
    });

    it("supports custom column count", () => {
      const btns = [1, 2, 3, 4].map(n => ({ text: `b${n}`, callback_data: `d${n}` }));
      const kb = toKeyboardRows(btns, 4);
      expect(kb.inline_keyboard).toHaveLength(1);
      expect(kb.inline_keyboard[0]).toHaveLength(4);
    });

    it("produces an empty keyboard for empty input", () => {
      expect(toKeyboardRows([]).inline_keyboard).toEqual([]);
    });
  });

  describe("extractTelegramChatId", () => {
    it("prefers platformThreadId over id", () => {
      expect(
        extractTelegramChatId({ id: "telegram:111", platformThreadId: "telegram:222" }),
      ).toBe("222");
    });

    it("falls back to id when platformThreadId is missing", () => {
      expect(extractTelegramChatId({ id: "telegram:333" })).toBe("333");
    });

    it("returns undefined for an empty thread", () => {
      expect(extractTelegramChatId({})).toBeUndefined();
      expect(extractTelegramChatId(undefined)).toBeUndefined();
    });
  });
});

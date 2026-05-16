/**
 * test for src/transports/telegram/rich-ui.ts \u2014 callback encoding +
 * RichMenu \u2192 Telegram inline keyboard rendering.
 *
 * These tests pin down the wire format the @chat-adapter/telegram package
 * decodes on the other end. Don't change them without understanding the
 * coupling note in the rich-ui module doc.
 */

import { describe, it, expect } from "vitest";
import {
  CALLBACK_PREFIX,
  encodeTelegramCallbackData,
  toTelegramInlineKeyboard,
} from "../src/transports/telegram/rich-ui";
import type { RichMenu } from "../src/transports";

describe("transports/telegram/rich-ui", () => {
  describe("encodeTelegramCallbackData", () => {
    it("prefixes with CALLBACK_PREFIX and JSON-encodes action+value", () => {
      const data = encodeTelegramCallbackData("topic_select", "deploy");
      expect(data).toBe(`${CALLBACK_PREFIX}{"a":"topic_select","v":"deploy"}`);
    });

    it("round-trips parseable JSON after the prefix", () => {
      const data = encodeTelegramCallbackData("x", "y");
      const payload = data.slice(CALLBACK_PREFIX.length);
      expect(JSON.parse(payload)).toEqual({ a: "x", v: "y" });
    });
  });

  describe("toTelegramInlineKeyboard", () => {
    it("lays out a single section into 2-column rows by default", () => {
      const menu: RichMenu = {
        sections: [
          {
            buttons: [1, 2, 3, 4, 5].map((n) => ({
              label: `b${n}`,
              actionId: "act",
              value: String(n),
            })),
          },
        ],
      };
      const kb = toTelegramInlineKeyboard(menu);
      expect(kb.inline_keyboard).toHaveLength(3);
      expect(kb.inline_keyboard[0]).toHaveLength(2);
      expect(kb.inline_keyboard[2]).toHaveLength(1);
    });

    it("respects a section's columns hint", () => {
      const menu: RichMenu = {
        sections: [
          {
            columns: 1,
            buttons: [1, 2].map((n) => ({ label: `b${n}`, actionId: "a", value: String(n) })),
          },
        ],
      };
      const kb = toTelegramInlineKeyboard(menu);
      expect(kb.inline_keyboard).toHaveLength(2);
      expect(kb.inline_keyboard[0]).toHaveLength(1);
    });

    it("encodes each button's actionId+value into callback_data", () => {
      const menu: RichMenu = {
        sections: [
          { buttons: [{ label: "A", actionId: "topic_select", value: "deploy" }] },
        ],
      };
      const [[btn]] = toTelegramInlineKeyboard(menu).inline_keyboard;
      expect(btn.callback_data).toBe(`${CALLBACK_PREFIX}{"a":"topic_select","v":"deploy"}`);
    });

    it("appends a check mark to selected buttons", () => {
      const menu: RichMenu = {
        sections: [
          {
            buttons: [
              { label: "A", actionId: "x", value: "1", selected: true },
              { label: "B", actionId: "x", value: "2" },
            ],
          },
        ],
      };
      const [[a, b]] = toTelegramInlineKeyboard(menu).inline_keyboard;
      expect(a.text).toContain("\u2713");
      expect(b.text).not.toContain("\u2713");
    });

    it("concatenates multiple sections row-wise with per-section column counts", () => {
      const menu: RichMenu = {
        sections: [
          {
            columns: 1,
            buttons: [{ label: "X", actionId: "a", value: "1" }],
          },
          {
            columns: 2,
            buttons: [
              { label: "Y", actionId: "a", value: "2" },
              { label: "Z", actionId: "a", value: "3" },
            ],
          },
        ],
      };
      const kb = toTelegramInlineKeyboard(menu);
      expect(kb.inline_keyboard).toHaveLength(2);
      expect(kb.inline_keyboard[0]).toHaveLength(1);
      expect(kb.inline_keyboard[1]).toHaveLength(2);
    });

    it("returns an empty keyboard for an empty menu", () => {
      const menu: RichMenu = { sections: [] };
      expect(toTelegramInlineKeyboard(menu).inline_keyboard).toEqual([]);
    });
  });
});

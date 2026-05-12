import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getActiveTopic,
  setActiveTopic,
  applyTopicOverride,
  handleTopic,
  handleTopicAction,
  TOPIC_ACTION_ID,
} from "../src/gateway/topic-command";

describe("topic-command", () => {
  beforeEach(() => {
    // Reset to main
    setActiveTopic("123", "main");
  });

  it("returns undefined when no topic set", () => {
    expect(getActiveTopic("123")).toBeUndefined();
  });

  it("sets and gets active topic", () => {
    setActiveTopic("123", "deploy");
    expect(getActiveTopic("123")).toBe("deploy");
  });

  it("clears topic on 'main'", () => {
    setActiveTopic("123", "deploy");
    setActiveTopic("123", "main");
    expect(getActiveTopic("123")).toBeUndefined();
  });

  it("clears topic on 'off'", () => {
    setActiveTopic("123", "debug");
    setActiveTopic("123", "off");
    expect(getActiveTopic("123")).toBeUndefined();
  });

  describe("applyTopicOverride", () => {
    it("overrides 'main' when topic is active (scoped to chat)", () => {
      setActiveTopic("456", "deploy");
      const result = applyTopicOverride("main", { id: "telegram:456" });
      expect(result).toBe("topic:456:deploy");
    });

    it("returns main when no topic active", () => {
      const result = applyTopicOverride("main", { id: "telegram:789" });
      expect(result).toBe("main");
    });

    it("does not override group threads", () => {
      setActiveTopic("456", "deploy");
      const result = applyTopicOverride("group:-100456", { id: "telegram:-100456" });
      expect(result).toBe("group:-100456");
    });
  });

  describe("handleTopic (no args)", () => {
    it("uses inline keyboard when adapter supports telegramFetch and topics exist", async () => {
      // Seed a memory-state file so listTopics() returns a real topic.
      // Filename encoding: topic_c<chatId>_c<topicName>.json (matches threadIdToDir).
      const { ROUNDHOUSE_DIR } = await import("../src/config");
      const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
      const { join } = await import("node:path");

      const chatId = "kbtest1";
      const stateDir = join(ROUNDHOUSE_DIR, "memory-state");
      const seededFiles = [
        join(stateDir, `topic_c${chatId}_cdeploy.json`),
        join(stateDir, `topic_c${chatId}_cdebug.json`),
      ];
      try {
        mkdirSync(stateDir, { recursive: true });
        for (const f of seededFiles) writeFileSync(f, "{}");

        const telegramFetch = vi.fn(async () => ({ ok: true }));
        const thread = {
          id: `telegram:${chatId}`,
          platformThreadId: `telegram:${chatId}`,
          adapter: { telegramFetch },
        };
        const post = vi.fn(async () => {});

        await handleTopic({ thread, text: "/topic", postWithFallback: post });

        expect(telegramFetch).toHaveBeenCalledTimes(1);
        const [method, payload] = telegramFetch.mock.calls[0]!;
        expect(method).toBe("sendMessage");
        const p = payload as any;
        expect(p.chat_id).toBe(chatId);
        expect(p.parse_mode).toBe("HTML");
        expect(p.reply_markup?.inline_keyboard).toBeDefined();

        // Flatten rows, confirm main + both seeded topics are present
        const buttons = p.reply_markup.inline_keyboard.flat() as Array<{ text: string; callback_data: string }>;
        const texts = buttons.map(b => b.text);
        expect(texts.some(t => t.includes("main (default)"))).toBe(true);
        expect(texts.some(t => t.includes("deploy"))).toBe(true);
        expect(texts.some(t => t.includes("debug"))).toBe(true);

        // Callback data must use shared inline-keyboard encoding
        for (const btn of buttons) {
          expect(btn.callback_data).toMatch(/^chat:\{"a":"topic_select","v":".+"\}$/);
        }

        // Post fallback must NOT have been used when keyboard succeeded
        expect(post).not.toHaveBeenCalled();
      } finally {
        for (const f of seededFiles) {
          try { rmSync(f); } catch { /* ignore */ }
        }
      }
    });

    it("marks main with ✓ when no topic is active", async () => {
      const { ROUNDHOUSE_DIR } = await import("../src/config");
      const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
      const { join } = await import("node:path");

      const chatId = "kbtest2";
      const stateDir = join(ROUNDHOUSE_DIR, "memory-state");
      const seed = join(stateDir, `topic_c${chatId}_calpha.json`);
      try {
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(seed, "{}");

        // Ensure no active topic for this chat
        setActiveTopic(chatId, "main");

        const telegramFetch = vi.fn(async () => ({ ok: true }));
        await handleTopic({
          thread: {
            id: `telegram:${chatId}`,
            platformThreadId: `telegram:${chatId}`,
            adapter: { telegramFetch },
          },
          text: "/topic",
          postWithFallback: async () => {},
        });

        const buttons = (telegramFetch.mock.calls[0]![1] as any).reply_markup.inline_keyboard.flat();
        const mainBtn = buttons.find((b: any) => b.text.includes("main (default)"));
        expect(mainBtn?.text).toContain("✓");
      } finally {
        try { rmSync(seed); } catch { /* ignore */ }
      }
    });

    it("falls back to text when no known topics exist", async () => {
      const telegramFetch = vi.fn(async () => ({ ok: true }));
      const thread = {
        id: "telegram:999",
        platformThreadId: "telegram:999",
        adapter: { telegramFetch },
      };
      const post = vi.fn(async () => {});

      await handleTopic({ thread, text: "/topic", postWithFallback: post });

      expect(telegramFetch).not.toHaveBeenCalled();
      expect(post).toHaveBeenCalledTimes(1);
      const msg = post.mock.calls[0]![1];
      expect(msg).toContain("Current topic");
    });

    it("rejects /topic in group chats", async () => {
      const post = vi.fn(async () => {});
      await handleTopic({
        thread: { id: "telegram:-100123" },
        text: "/topic",
        postWithFallback: post,
      });
      expect(post).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("only works in private"));
    });
  });

  describe("handleTopicAction", () => {
    it("switches to the selected topic via callback value", async () => {
      const posts: string[] = [];
      const thread = {
        id: "telegram:555",
        post: async (arg: any) => {
          posts.push(typeof arg === "string" ? arg : arg.markdown);
        },
      };
      await handleTopicAction({ value: "deploy", thread });
      expect(getActiveTopic("555")).toBe("deploy");
      expect(posts[0]).toContain("deploy");
    });

    it("clears active topic when main sentinel is selected", async () => {
      setActiveTopic("555", "deploy");
      const thread = {
        id: "telegram:555",
        post: async () => {},
      };
      await handleTopicAction({ value: "-main", thread });
      expect(getActiveTopic("555")).toBeUndefined();
    });

    it("treats a user-created topic named '__main__' as a real topic, not the sentinel", async () => {
      // Regression: old sentinel was '__main__' which collides with a valid
      // user-created topic name. New sentinel '-main' is unrepresentable.
      const thread = {
        id: "telegram:557",
        post: async () => {},
      };
      await handleTopicAction({ value: "__main__", thread });
      expect(getActiveTopic("557")).toBe("__main__");
    });

    it("ignores empty callback value", async () => {
      const thread = { id: "telegram:555", post: vi.fn() };
      await handleTopicAction({ value: undefined, thread });
      // Nothing happened
      expect(thread.post).not.toHaveBeenCalled();
    });

    it("exports a stable action id", () => {
      expect(TOPIC_ACTION_ID).toBe("topic_select");
    });
  });
});

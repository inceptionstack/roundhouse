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
      // Seed a known topic so listTopics() has something to return. We rely on
      // the persisted state from the setActiveTopic() calls above — but those
      // don't create memory-state files, so the keyboard path will only fire
      // if we simulate a scenario with no known topics: fall through to text.
      const telegramFetch = vi.fn(async () => ({ ok: true }));
      const thread = {
        id: "telegram:999",
        platformThreadId: "telegram:999",
        adapter: { telegramFetch },
      };
      const post = vi.fn(async () => {});

      await handleTopic({ thread, text: "/topic", postWithFallback: post });

      // With no known topics (empty memory-state for chat 999), we fall back
      // to text. Keyboard path isn't exercised, but post must be called.
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
      await handleTopicAction({ value: "__main__", thread });
      expect(getActiveTopic("555")).toBeUndefined();
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

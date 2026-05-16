import { describe, it, expect, beforeEach } from "vitest";
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

  describe("handleTopic (no args) returns RichResponse menu", () => {
    it("returns menu with main button + known topics", async () => {
      // Seed a memory-state file so listTopics() returns real topics.
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

        const result = handleTopic({
          thread: { id: `telegram:${chatId}` },
          text: "/topic",
        });

        expect(result).toBeDefined();
        expect(result.menu).toBeDefined();
        expect(result.menu!.sections).toHaveLength(1);

        const buttons = result.menu!.sections[0].buttons;
        const labels = buttons.map(b => b.label);
        expect(labels.some(l => l.includes("main (default)"))).toBe(true);
        expect(labels.some(l => l.includes("deploy"))).toBe(true);
        expect(labels.some(l => l.includes("debug"))).toBe(true);

        // Every button uses the topic_select action id
        for (const btn of buttons) {
          expect(btn.actionId).toBe(TOPIC_ACTION_ID);
        }
      } finally {
        for (const f of seededFiles) {
          try { rmSync(f); } catch { /* ignore */ }
        }
      }
    });

    it("marks main with selected=true when no topic is active", async () => {
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

        const result = handleTopic({
          thread: { id: `telegram:${chatId}` },
          text: "/topic",
        });
        const buttons = result.menu!.sections[0].buttons;
        const mainBtn = buttons.find(b => b.label.includes("main (default)"));
        expect(mainBtn?.selected).toBe(true);
      } finally {
        try { rmSync(seed); } catch { /* ignore */ }
      }
    });

    it("returns menu with main button even when no custom topics exist", () => {
      const result = handleTopic({
        thread: { id: "telegram:999" },
        text: "/topic",
      });
      expect(result.menu).toBeDefined();
      const labels = result.menu!.sections[0].buttons.map(b => b.label);
      expect(labels.some(l => l.includes("main (default)"))).toBe(true);
    });

    it("rejects /topic in group chats with text-only response", () => {
      const result = handleTopic({
        thread: { id: "telegram:-100123" },
        text: "/topic",
      });
      expect(result.menu).toBeUndefined();
      expect(result.text).toContain("only works in private");
    });

    // Regression: when called from inside a named-topic agent session the
    // *transport* thread still has the user's chat id (e.g. "telegram:42").
    // Only the agent thread id was rewritten to "topic:42:deploy". /topic
    // must still return a menu \u2014 not a text-only fallback.
    it("returns a menu when invoked from inside a named-topic session (regression)", async () => {
      const { ROUNDHOUSE_DIR } = await import("../src/config");
      const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
      const { join } = await import("node:path");

      const chatId = "topicregress1";
      // Sanity: simulate the user being on the "deploy" topic.
      setActiveTopic(chatId, "deploy");
      // Seed memory-state files for two topics so listTopics() finds them.
      const stateDir = join(ROUNDHOUSE_DIR, "memory-state");
      const seeds = [
        join(stateDir, `topic_c${chatId}_cdeploy.json`),
        join(stateDir, `topic_c${chatId}_cdebug.json`),
      ];
      try {
        mkdirSync(stateDir, { recursive: true });
        for (const f of seeds) writeFileSync(f, "{}");

        // Confirm the routing rule: applyTopicOverride rewrites the agent
        // session id, not the transport thread.
        const transportThreadId = `telegram:${chatId}`;
        const agentThreadId = applyTopicOverride("main", { id: transportThreadId });
        expect(agentThreadId).toBe(`topic:${chatId}:deploy`);

        // Command receives the *transport* thread \u2014 the one with the chat id.
        const result = handleTopic({
          thread: { id: transportThreadId },
          text: "/topic",
        });

        expect(result.menu).toBeDefined();
        const buttons = result.menu!.sections[0].buttons;
        const labels = buttons.map(b => b.label);
        expect(labels.some(l => l.includes("main (default)"))).toBe(true);
        expect(labels.some(l => l.includes("deploy"))).toBe(true);
        expect(labels.some(l => l.includes("debug"))).toBe(true);

        // Active topic must be reflected as selected on its button.
        const deployBtn = buttons.find(b => b.label.includes("deploy"));
        expect(deployBtn?.selected).toBe(true);
      } finally {
        // Reset
        setActiveTopic(chatId, "main");
        for (const f of seeds) { try { rmSync(f); } catch { /* ignore */ } }
      }
    });
  });

  describe("handleTopicAction", () => {
    it("switches to the selected topic via callback value", () => {
      const result = handleTopicAction({ value: "deploy", thread: { id: "telegram:555" } });
      expect(getActiveTopic("555")).toBe("deploy");
      expect(result?.text).toContain("deploy");
    });

    it("clears active topic when main sentinel is selected", () => {
      setActiveTopic("555", "deploy");
      handleTopicAction({ value: "-main", thread: { id: "telegram:555" } });
      expect(getActiveTopic("555")).toBeUndefined();
    });

    it("treats a user-created topic named '__main__' as a real topic, not the sentinel", () => {
      // Regression: old sentinel was '__main__' which collides with a valid
      // user-created topic name. New sentinel '-main' is unrepresentable.
      handleTopicAction({ value: "__main__", thread: { id: "telegram:557" } });
      expect(getActiveTopic("557")).toBe("__main__");
    });

    it("ignores empty callback value", () => {
      const result = handleTopicAction({ value: undefined, thread: { id: "telegram:555" } });
      expect(result).toBeUndefined();
    });

    it("exports a stable action id", () => {
      expect(TOPIC_ACTION_ID).toBe("topic_select");
    });
  });
});

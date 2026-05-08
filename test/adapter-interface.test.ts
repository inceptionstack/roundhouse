/**
 * test/adapter-interface.test.ts — Integration tests for the AgentAdapter interface contract
 *
 * These tests verify that any adapter implementing the interface (via BaseAdapter or directly)
 * works correctly with the patterns used by gateway, memory lifecycle, and CLI consumers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { BaseAdapter } from "../src/agents/base-adapter.js";
import type { AgentAdapter, AgentMessage, AgentResponse, AgentStreamEvent, AdapterInfo } from "../src/types.js";

// ── Test Adapters ────────────────────────────────────

/** Full-featured adapter with all optional methods overridden */
class FullAdapter extends BaseAdapter {
  readonly name = "full";
  private sessions = new Map<string, { tokens: number; model: string }>();
  private disposed = false;

  async prompt(threadId: string, message: AgentMessage): Promise<AgentResponse> {
    this.sessions.set(threadId, { tokens: message.text.length * 4, model: "test-model" });
    return { text: `reply to: ${message.text}` };
  }

  async *promptStream(threadId: string, message: AgentMessage): AsyncIterable<AgentStreamEvent> {
    this.sessions.set(threadId, { tokens: message.text.length * 4, model: "test-model" });
    const words = message.text.split(" ");
    for (const word of words) {
      yield { type: "text_delta", text: word + " " };
    }
    yield { type: "tool_start", toolName: "bash", toolCallId: "tc_1" };
    yield { type: "tool_end", toolName: "bash", toolCallId: "tc_1", isError: false };
    yield { type: "turn_end" };
    yield { type: "agent_end" };
  }

  async promptWithModel(threadId: string, message: AgentMessage, modelId: string): Promise<AgentResponse> {
    this.sessions.set(threadId, { tokens: message.text.length * 4, model: modelId });
    return { text: `[${modelId}] ${message.text}` };
  }

  async restart(threadId: string): Promise<void> {
    this.sessions.delete(threadId);
  }

  async compact(threadId: string): Promise<{ tokensBefore: number; tokensAfter: number | null } | null> {
    const session = this.sessions.get(threadId);
    if (!session) return null;
    const before = session.tokens;
    session.tokens = Math.floor(before * 0.3);
    return { tokensBefore: before, tokensAfter: session.tokens };
  }

  async abort(_threadId: string): Promise<void> {
    // Signal abort
  }

  getInfo(threadId?: string): AdapterInfo {
    const session = threadId ? this.sessions.get(threadId) : undefined;
    return {
      version: "1.0.0",
      model: session?.model ?? "test-model",
      cwd: "/tmp/test",
      activeSessions: this.sessions.size,
      contextTokens: session?.tokens ?? null,
      contextWindow: 200000,
      contextPercent: session?.tokens ? Math.round((session.tokens / 200000) * 100) : null,
      hasMemoryExtension: false,
      memoryTools: [],
      extensions: ["web-search", "mcporter"],
    };
  }

  async dispose(): Promise<void> {
    this.sessions.clear();
    this.disposed = true;
  }

  get isDisposed() { return this.disposed; }
}

/** Minimal adapter — only implements required methods */
class MinimalAdapter extends BaseAdapter {
  readonly name = "minimal";

  async prompt(_threadId: string, _message: AgentMessage): Promise<AgentResponse> {
    return { text: "ok" };
  }

  async *promptStream(_threadId: string, _message: AgentMessage): AsyncIterable<AgentStreamEvent> {
    yield { type: "text_delta", text: "ok" };
    yield { type: "agent_end" };
  }

  async dispose(): Promise<void> {}
}

// ── Tests: Interface Contract ────────────────────────

describe("AgentAdapter interface contract", () => {
  describe("required methods", () => {
    const adapters: [string, () => BaseAdapter][] = [
      ["FullAdapter", () => new FullAdapter()],
      ["MinimalAdapter", () => new MinimalAdapter()],
    ];

    adapters.forEach(([label, factory]) => {
      describe(label, () => {
        let adapter: BaseAdapter;
        beforeEach(() => { adapter = factory(); });

        it("prompt() returns AgentResponse with text", async () => {
          const res = await adapter.prompt("t1", { text: "hello" });
          expect(res).toHaveProperty("text");
          expect(typeof res.text).toBe("string");
        });

        it("promptStream() yields AgentStreamEvent objects", async () => {
          const events: AgentStreamEvent[] = [];
          for await (const ev of adapter.promptStream("t1", { text: "hello world" })) {
            events.push(ev);
          }
          expect(events.length).toBeGreaterThan(0);
          // Must end with agent_end
          expect(events[events.length - 1].type).toBe("agent_end");
          // Every event has a type field
          for (const ev of events) {
            expect(ev).toHaveProperty("type");
          }
        });

        it("dispose() resolves without error", async () => {
          await expect(adapter.dispose()).resolves.toBeUndefined();
        });
      });
    });
  });

  describe("optional methods with defaults (MinimalAdapter)", () => {
    let adapter: MinimalAdapter;
    beforeEach(() => { adapter = new MinimalAdapter(); });

    it("promptWithModel falls back to prompt", async () => {
      const res = await adapter.promptWithModel("t1", { text: "hi" }, "claude-opus");
      expect(res.text).toBe("ok");
    });

    it("restart is no-op", async () => {
      await adapter.restart("t1");
      // no error, still works after
      const res = await adapter.prompt("t1", { text: "after restart" });
      expect(res.text).toBe("ok");
    });

    it("compact returns null", async () => {
      expect(await adapter.compact("t1")).toBeNull();
    });

    it("compactWithModel returns null", async () => {
      expect(await adapter.compactWithModel("t1", "haiku")).toBeNull();
    });

    it("abort is no-op", async () => {
      await expect(adapter.abort("t1")).resolves.toBeUndefined();
    });

    it("getInfo returns empty AdapterInfo", () => {
      const info = adapter.getInfo("t1");
      expect(info).toEqual({});
    });
  });

  describe("overridden optional methods (FullAdapter)", () => {
    let adapter: FullAdapter;
    beforeEach(() => { adapter = new FullAdapter(); });

    it("promptWithModel uses specified model", async () => {
      const res = await adapter.promptWithModel("t1", { text: "hi" }, "haiku-4.5");
      expect(res.text).toContain("haiku-4.5");
      expect(adapter.getInfo("t1").model).toBe("haiku-4.5");
    });

    it("restart clears session state", async () => {
      await adapter.prompt("t1", { text: "build context" });
      expect(adapter.getInfo("t1").contextTokens).toBeGreaterThan(0);
      await adapter.restart("t1");
      expect(adapter.getInfo("t1").contextTokens).toBeNull();
    });

    it("compact reduces token count", async () => {
      await adapter.prompt("t1", { text: "a long message to build up context" });
      const result = await adapter.compact("t1");
      expect(result).not.toBeNull();
      expect(result!.tokensBefore).toBeGreaterThan(result!.tokensAfter!);
    });

    it("compact returns null for unknown thread", async () => {
      expect(await adapter.compact("nonexistent")).toBeNull();
    });

    it("compactWithModel delegates to compact override", async () => {
      await adapter.prompt("t1", { text: "build context" });
      const result = await adapter.compactWithModel("t1", "haiku");
      expect(result).not.toBeNull();
      expect(result!.tokensAfter).toBeLessThan(result!.tokensBefore);
    });

    it("dispose cleans up", async () => {
      await adapter.prompt("t1", { text: "x" });
      await adapter.dispose();
      expect(adapter.isDisposed).toBe(true);
    });
  });
});

// ── Tests: Consumer Patterns ─────────────────────────
// Simulate how gateway and memory lifecycle use the adapter

describe("Consumer patterns", () => {
  describe("gateway /status pattern", () => {
    it("reads all expected info fields", async () => {
      const adapter: AgentAdapter = new FullAdapter();
      await adapter.prompt("t1", { text: "hello" });

      const info = adapter.getInfo!("t1");

      // Gateway reads these for /status display
      expect(typeof info.version).toBe("string");
      expect(typeof info.model).toBe("string");
      expect(typeof info.activeSessions).toBe("number");
      expect(typeof info.cwd).toBe("string");
      expect(Array.isArray(info.extensions)).toBe(true);
      expect(typeof info.contextTokens).toBe("number");
      expect(typeof info.contextWindow).toBe("number");
      expect(typeof info.contextPercent).toBe("number");
    });

    it("handles minimal adapter gracefully", () => {
      const adapter: AgentAdapter = new MinimalAdapter();
      const info = adapter.getInfo!();
      // All fields undefined/missing — consumers must handle this
      expect(info.version).toBeUndefined();
      expect(info.model).toBeUndefined();
      expect(info.extensions).toBeUndefined();
    });
  });

  describe("memory lifecycle pattern", () => {
    it("determines memory mode from hasMemoryExtension", () => {
      const adapter: AgentAdapter = new FullAdapter();
      const info = adapter.getInfo!();
      // Simulates determineMemoryMode()
      const mode = info.hasMemoryExtension === true ? "complement"
        : info.hasMemoryExtension === false ? "full"
        : "unknown";
      expect(mode).toBe("full");
    });

    it("reads context pressure fields", async () => {
      const adapter: AgentAdapter = new FullAdapter();
      await adapter.prompt("t1", { text: "build some context tokens" });
      const info = adapter.getInfo!("t1");

      // Memory lifecycle reads these for pressure classification
      const tokens = typeof info.contextTokens === "number" ? info.contextTokens : null;
      const window = typeof info.contextWindow === "number" ? info.contextWindow : null;
      const pct = typeof info.contextPercent === "number" ? info.contextPercent : null;

      expect(tokens).toBeGreaterThan(0);
      expect(window).toBe(200000);
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(100);
    });

    it("compact flow: check support → compact → verify", async () => {
      const adapter: AgentAdapter = new FullAdapter();
      await adapter.prompt("t1", { text: "lots of context" });

      // Gateway checks if compact is supported
      if (!adapter.compact) {
        throw new Error("compact should exist on FullAdapter");
      }

      const result = await adapter.compact("t1");
      expect(result).not.toBeNull();
      expect(result!.tokensBefore).toBeGreaterThan(0);
      expect(result!.tokensAfter).not.toBeNull();
      expect(result!.tokensAfter!).toBeLessThan(result!.tokensBefore);
    });
  });

  describe("streaming consumer pattern", () => {
    it("collects full text from text_delta events", async () => {
      const adapter: AgentAdapter = new FullAdapter();
      let fullText = "";
      for await (const ev of adapter.promptStream!("t1", { text: "hello world" })) {
        if (ev.type === "text_delta") fullText += ev.text;
      }
      expect(fullText.trim()).toBe("hello world");
    });

    it("tracks tool usage from stream events", async () => {
      const adapter: AgentAdapter = new FullAdapter();
      const tools: string[] = [];
      for await (const ev of adapter.promptStream!("t1", { text: "run something" })) {
        if (ev.type === "tool_start") tools.push(ev.toolName);
      }
      expect(tools).toContain("bash");
    });

    it("detects end of turn and agent completion", async () => {
      const adapter: AgentAdapter = new FullAdapter();
      let sawTurnEnd = false;
      let sawAgentEnd = false;
      for await (const ev of adapter.promptStream!("t1", { text: "hi" })) {
        if (ev.type === "turn_end") sawTurnEnd = true;
        if (ev.type === "agent_end") sawAgentEnd = true;
      }
      expect(sawTurnEnd).toBe(true);
      expect(sawAgentEnd).toBe(true);
    });

    it("can break out of stream early", async () => {
      const adapter: AgentAdapter = new FullAdapter();
      let count = 0;
      for await (const ev of adapter.promptStream!("t1", { text: "a b c d e f" })) {
        count++;
        if (count >= 2) break;
      }
      expect(count).toBe(2);
    });
  });

  describe("multi-thread isolation", () => {
    it("threads have independent state", async () => {
      const adapter = new FullAdapter();
      await adapter.prompt("t1", { text: "short" });
      await adapter.prompt("t2", { text: "a much longer message to get more tokens" });

      const info1 = adapter.getInfo("t1");
      const info2 = adapter.getInfo("t2");

      expect(info1.contextTokens).not.toBe(info2.contextTokens);
      expect(adapter.getInfo().activeSessions).toBe(2);
    });

    it("restart one thread doesn't affect another", async () => {
      const adapter = new FullAdapter();
      await adapter.prompt("t1", { text: "hello" });
      await adapter.prompt("t2", { text: "world" });

      await adapter.restart("t1");

      expect(adapter.getInfo("t1").contextTokens).toBeNull();
      expect(adapter.getInfo("t2").contextTokens).toBeGreaterThan(0);
    });

    it("dispose clears all threads", async () => {
      const adapter = new FullAdapter();
      await adapter.prompt("t1", { text: "a" });
      await adapter.prompt("t2", { text: "b" });

      await adapter.dispose();
      expect(adapter.isDisposed).toBe(true);
    });
  });

  describe("attachments in messages", () => {
    it("adapter receives attachment metadata", async () => {
      let receivedMsg: AgentMessage | null = null;

      class SpyAdapter extends BaseAdapter {
        readonly name = "spy";
        async prompt(_tid: string, msg: AgentMessage) {
          receivedMsg = msg;
          return { text: "got it" };
        }
        async *promptStream(_tid: string, msg: AgentMessage): AsyncIterable<AgentStreamEvent> {
          yield { type: "agent_end" };
        }
        async dispose() {}
      }

      const adapter: AgentAdapter = new SpyAdapter();
      await adapter.prompt("t1", {
        text: "check this file",
        attachments: [{
          id: "att_1",
          mediaType: "image",
          name: "screenshot.png",
          localPath: "/tmp/screenshot.png",
          mime: "image/png",
          sizeBytes: 12345,
        }],
      });

      expect(receivedMsg).not.toBeNull();
      expect(receivedMsg!.attachments).toHaveLength(1);
      expect(receivedMsg!.attachments![0].name).toBe("screenshot.png");
    });
  });
});

/**
 * test/base-adapter.test.ts — Tests for BaseAdapter default implementations
 */

import { describe, it, expect } from "vitest";
import { BaseAdapter } from "../src/agents/base-adapter.js";
import type { AgentMessage, AgentResponse, AgentStreamEvent } from "../src/types.js";

/** Minimal concrete adapter for testing base class defaults */
class TestAdapter extends BaseAdapter {
  readonly name = "test";
  promptCalled = false;

  async prompt(_threadId: string, message: AgentMessage): Promise<AgentResponse> {
    this.promptCalled = true;
    return { text: `echo: ${message.text}` };
  }

  async *promptStream(_threadId: string, message: AgentMessage): AsyncIterable<AgentStreamEvent> {
    yield { type: "text_delta", text: message.text };
    yield { type: "agent_end" };
  }

  async dispose(): Promise<void> {}
}

describe("BaseAdapter", () => {
  it("promptWithModel delegates to prompt by default", async () => {
    const adapter = new TestAdapter();
    const result = await adapter.promptWithModel("t1", { text: "hi" }, "some-model");
    expect(result.text).toBe("echo: hi");
    expect(adapter.promptCalled).toBe(true);
  });

  it("restart is a no-op by default", async () => {
    const adapter = new TestAdapter();
    await expect(adapter.restart("t1")).resolves.toBeUndefined();
  });

  it("compact returns null by default (not supported)", async () => {
    const adapter = new TestAdapter();
    const result = await adapter.compact("t1");
    expect(result).toBeNull();
  });

  it("compactWithModel delegates to compact by default", async () => {
    const adapter = new TestAdapter();
    const result = await adapter.compactWithModel("t1", "model");
    expect(result).toBeNull();
  });

  it("abort is a no-op by default", async () => {
    const adapter = new TestAdapter();
    await expect(adapter.abort("t1")).resolves.toBeUndefined();
  });

  it("getInfo returns empty object by default", () => {
    const adapter = new TestAdapter();
    expect(adapter.getInfo("t1")).toEqual({});
  });

  it("concrete adapter satisfies AgentAdapter interface", async () => {
    const adapter = new TestAdapter();
    // Required methods exist and work
    const r = await adapter.prompt("t1", { text: "test" });
    expect(r.text).toBe("echo: test");

    const events: AgentStreamEvent[] = [];
    for await (const ev of adapter.promptStream("t1", { text: "stream" })) {
      events.push(ev);
    }
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "text_delta", text: "stream" });
  });
});

/**
 * test/transport-stream-dispatch.test.ts — pin the streaming refactor.
 *
 * Phase 2 changed gateway/streaming.ts to dispatch per-turn streaming
 * through `transport.stream(thread, iter, signal)` instead of the
 * hardcoded telegram-html / thread.handleStream branch. This test
 * covers the seam:
 *  - When `transport` is provided, transport.stream is called with the
 *    thread, an AsyncIterable<string>, and the abort signal.
 *  - When `transport` is omitted (test harness), the loop falls back to
 *    `thread.handleStream` (existing behavior).
 */

import { describe, it, expect, vi } from "vitest";
import { handleStreaming, type StreamContext } from "../src/gateway/streaming";
import type { AgentStreamEvent } from "../src/types";

async function* events(...evts: AgentStreamEvent[]) {
  for (const e of evts) yield e;
}

function fakeThread() {
  return {
    id: "telegram:1",
    handleStream: vi.fn(async () => {}),
    post: vi.fn(async () => {}),
  };
}

describe("handleStreaming dispatch", () => {
  it("routes the per-turn iterable through transport.stream when a transport is provided", async () => {
    const thread = fakeThread();
    const ac = new AbortController();
    const streamMock = vi.fn(async () => {});
    const ctx: StreamContext = {
      thread,
      verbose: false,
      signal: ac.signal,
      postWithFallback: async () => {},
      transport: {
        name: "fake",
        enrichPrompt: (_t, t) => t,
        postMessage: async () => {},
        postRich: async () => {},
        progress: async () => ({ update: async () => {} }),
        stream: streamMock as any,
        registerCommands: async () => {},
        ownsThread: () => true,
        ownsChatId: () => true,
        encodeParentThreadId: (id) => `fake:${id}`,
        formatNotifySession: () => "main",
        notify: async () => {},
        createThread: () => ({ id: "fake:0", post: async () => {} }),
        isPairingPending: async () => false,
        handlePairing: async () => null,
      },
    };

    await handleStreaming(
      events(
        { type: "text_delta", text: "hello " },
        { type: "text_delta", text: "world" },
        { type: "agent_end" },
      ),
      ctx,
    );

    expect(streamMock).toHaveBeenCalledOnce();
    const [calledThread, asyncIter, calledSignal] = streamMock.mock.calls[0];
    expect(calledThread).toBe(thread);
    expect(typeof (asyncIter as any)[Symbol.asyncIterator]).toBe("function");
    expect(calledSignal).toBe(ac.signal);
    expect(thread.handleStream).not.toHaveBeenCalled();
  });

  it("falls back to thread.handleStream when no transport is provided", async () => {
    const thread = fakeThread();
    const ctx: StreamContext = {
      thread,
      verbose: false,
      postWithFallback: async () => {},
    };

    await handleStreaming(
      events({ type: "text_delta", text: "hi" }, { type: "agent_end" }),
      ctx,
    );

    expect(thread.handleStream).toHaveBeenCalledOnce();
  });
});

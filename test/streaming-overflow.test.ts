/**
 * test/streaming-overflow.test.ts — Stream-event overflow path (F1, v0.5.38)
 *
 * pi-ai's streaming converts provider errors into `model_error` EVENTS, not
 * thrown exceptions. Without classification in `handleStreaming`, the loop
 * would post the raw error inline and return normally, bypassing the
 * gateway's `recoverFromAgentTurnOverflow` catch path.
 *
 * Tests:
 *   - model_error("prompt is too long") → throws StreamModelOverflowError,
 *     suppresses the inline `⚠️ Agent error:` post.
 *   - model_error("network timeout") → existing inline raw post path
 *     preserved, no throw, loop continues (regression test for non-overflow).
 *   - text_delta then model_error(overflow) → throw carries the overflow
 *     message; gateway recovery (separate tests in
 *     gateway-overflow-recovery.test.ts) handles "interrupted" wording.
 *   - End-to-end: gateway catch sees the throw and routes through
 *     recoverFromAgentTurnOverflow, posting recovery copy (♻️/✅) and not
 *     a duplicate raw error.
 *   - End-to-end: text_delta absent → recovery posts "please resend".
 *   - End-to-end: text_delta present → recovery posts "interrupted" wording.
 */

import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  handleStreaming,
  StreamModelOverflowError,
  type StreamContext,
} from "../src/gateway/streaming";
import { recoverFromAgentTurnOverflow } from "../src/gateway/overflow";
import { loadThreadMemoryState } from "../src/memory/state";
import { ROUNDHOUSE_DIR } from "../src/config";
import { threadIdToDir } from "../src/util";
import type { AgentAdapter, AgentResponse, AgentStreamEvent } from "../src/types";
import type { SoftResetReport } from "../src/agents/shared/session-soft-reset";

// ── Test doubles ──────────────────────────────────────

interface FakeThread {
  posts: string[];
  streamed: string[];
  post: (text: string) => Promise<void>;
  handleStream: (iter: AsyncIterable<string>) => Promise<void>;
}

function fakeThread(): FakeThread {
  const posts: string[] = [];
  const streamed: string[] = [];
  return {
    posts,
    streamed,
    async post(text: string) { posts.push(text); },
    async handleStream(iter: AsyncIterable<string>) {
      let buf = "";
      for await (const chunk of iter) buf += chunk;
      if (buf) streamed.push(buf);
    },
  };
}

function ctxFor(thread: FakeThread): StreamContext {
  return {
    thread,
    verbose: false,
    postWithFallback: async (t: any, text: string) => { await t.post(text); },
  };
}

async function* events(...evs: AgentStreamEvent[]): AsyncIterable<AgentStreamEvent> {
  for (const e of evs) yield e;
}

// Bedrock-shape overflow message that pi-ai propagates into a model_error event.
const OVERFLOW_MSG =
  "Validation error: The model returned the following errors: prompt is too long: 215725 tokens > 200000 maximum";

// ── handleStreaming-level tests ──────────────────────

describe("handleStreaming model_error overflow path (F1)", () => {
  it("streaming_ModelErrorOverflow_ThrowsStreamModelOverflowError_SuppressesInlineRawPost", async () => {
    const thread = fakeThread();
    const stream = events(
      { type: "model_error", message: OVERFLOW_MSG },
      // Events after model_error must not be processed for overflow.
      { type: "turn_end" },
      { type: "agent_end" },
    );

    let caught: unknown;
    try {
      await handleStreaming(stream, ctxFor(thread));
    } catch (e) { caught = e; }

    expect(caught).toBeInstanceOf(StreamModelOverflowError);
    expect((caught as Error).message).toBe(OVERFLOW_MSG);
    // No inline `⚠️ Agent error:` post — recovery owns user-visible messaging.
    expect(thread.posts).toEqual([]);
  });

  it("streaming_ModelErrorNonOverflow_PostsInlineRawErrorAndContinues", async () => {
    // Regression: pre-F1 behavior preserved for non-overflow stream errors.
    const thread = fakeThread();
    const stream = events(
      { type: "model_error", message: "network timeout: socket hang up" },
      { type: "text_delta", text: "trailing text" },
      { type: "turn_end" },
      { type: "agent_end" },
    );

    const result = await handleStreaming(stream, ctxFor(thread));

    // Inline post survived.
    expect(thread.posts.some(p => p.startsWith("\u26a0\ufe0f Agent error:"))).toBe(true);
    expect(thread.posts.some(p => p.includes("network timeout"))).toBe(true);
    // Loop continued past model_error and processed the trailing text_delta.
    expect(thread.streamed.join("")).toBe("trailing text");
    // Returned normally, not via throw.
    expect(result.hadVisibleText).toBe(true);
  });

  it("streaming_TextDeltaThenModelErrorOverflow_ThrowsCarriesOverflowMessage_NoInlinePost", async () => {
    const thread = fakeThread();
    const stream = events(
      { type: "text_delta", text: "Sure, let me think " },
      { type: "model_error", message: OVERFLOW_MSG },
    );

    let caught: unknown;
    try {
      await handleStreaming(stream, ctxFor(thread));
    } catch (e) { caught = e; }

    expect(caught).toBeInstanceOf(StreamModelOverflowError);
    // Partial text was flushed to the chat before the throw — gateway uses
    // hadVisibleText (returned only on success) inferred separately. Here we
    // just verify the partial text was streamed and no inline error was added.
    expect(thread.streamed.join("")).toBe("Sure, let me think ");
    expect(thread.posts).toEqual([]);
  });

  it("streaming_AgentErrorPrefixIsExactlyTheNonOverflowFormat", async () => {
    // Tightens the regression test: exact prefix and content for non-overflow.
    const thread = fakeThread();
    const stream = events(
      { type: "model_error", message: "invalid_request_error: tool_use without tool_result" },
      { type: "turn_end" },
    );

    await handleStreaming(stream, ctxFor(thread));

    expect(thread.posts).toHaveLength(1);
    expect(thread.posts[0]).toMatch(/^\u26a0\ufe0f Agent error: /);
    expect(thread.posts[0]).toMatch(/tool_use without tool_result/);
  });
});

// ── End-to-end: streaming → gateway catch → recovery ────────────────

const successReport: SoftResetReport = {
  reset: true,
  reason: "kept-8-user-turns",
  entriesBefore: 1024,
  entriesAfter: 17,
  bytesBefore: 2_900_000,
  bytesAfter: 215_000,
};

function fakeAdapter(): AgentAdapter {
  const a: Partial<AgentAdapter> = {
    name: "fake",
    async prompt(): Promise<AgentResponse> { return { text: "" }; },
    async dispose() {},
    softReset: async () => successReport,
    compact: async () => ({ tokensBefore: 100, tokensAfter: 5 }),
  };
  return a as AgentAdapter;
}

const createdThreads: string[] = [];

afterEach(async () => {
  for (const id of createdThreads.splice(0)) {
    const path = resolve(ROUNDHOUSE_DIR, "memory-state", `${threadIdToDir(id)}.json`);
    await rm(path, { force: true });
  }
});

function uniqueThreadId(tag: string): string {
  const id = `test:stream-overflow:${tag}:${randomUUID()}`;
  createdThreads.push(id);
  return id;
}

describe("streaming-overflow → gateway recovery (F1 end-to-end)", () => {
  it("streamingOverflow_NoTextBeforeError_GatewayRecoveryPostsResendHint_NoDuplicateRawError", async () => {
    const thread = fakeThread();
    const tid = uniqueThreadId("clean");
    const agent = fakeAdapter();

    const stream = events({ type: "model_error", message: OVERFLOW_MSG });

    let caught: unknown;
    let hadVisibleText = false;
    try {
      const r = await handleStreaming(stream, ctxFor(thread));
      hadVisibleText = r.hadVisibleText;
    } catch (e) { caught = e; }

    expect(caught).toBeInstanceOf(StreamModelOverflowError);

    // Gateway catch routes to recovery with hadVisibleText=false (default;
    // streaming threw before assigning the result variable).
    const result = await recoverFromAgentTurnOverflow(thread, tid, agent, caught, {
      turnSource: "user",
      hadVisibleText,
    });

    expect(result.outcome?.kind).toBe("recovered");
    // Recovery copy:
    //   ♻️ Session overflowed... (from helper progress)
    //   ✅ Soft-reset complete... (from helper progress)
    //   ✅ Recovered. Please resend your last message.
    expect(thread.posts.at(-1)).toBe("\u2705 Recovered. Please resend your last message.");
    // No duplicate raw `⚠️ Agent error:` post.
    expect(thread.posts.some(p => p.startsWith("\u26a0\ufe0f Agent error:"))).toBe(false);

    const state = await loadThreadMemoryState(tid);
    expect(state.forceInjectReason).toBe("after-soft-reset");
  });

  it("streamingOverflow_AfterPartialText_GatewayRecoveryPostsInterruptedWording", async () => {
    const thread = fakeThread();
    const tid = uniqueThreadId("partial");
    const agent = fakeAdapter();

    const stream = events(
      { type: "text_delta", text: "Working on it... " },
      { type: "model_error", message: OVERFLOW_MSG },
    );

    let caught: unknown;
    let hadVisibleText = false;
    try {
      const r = await handleStreaming(stream, ctxFor(thread));
      hadVisibleText = r.hadVisibleText;
    } catch (e) {
      caught = e;
      // StreamModelOverflowError now carries hadVisibleText from the stream.
      // In production gateway.ts, this is extracted and passed to recovery.
      if (e instanceof StreamModelOverflowError) {
        hadVisibleText = e.hadVisibleText;
      }
    }

    const result = await recoverFromAgentTurnOverflow(thread, tid, agent, caught, {
      turnSource: "user",
      hadVisibleText,
    });

    expect(result.outcome?.kind).toBe("recovered");
    expect(thread.posts.at(-1)).toMatch(/Response was interrupted; session recovered/);
    expect(thread.posts.some(p => p.startsWith("\u26a0\ufe0f Agent error:"))).toBe(false);
  });

  it("streamingNonOverflow_ModelError_DoesNotInvokeRecovery_RawPostStandsAlone", async () => {
    // Regression: non-overflow model_error must NOT throw. Recovery is not
    // called; the inline raw post is the user-visible artifact.
    const thread = fakeThread();
    const stream = events(
      { type: "model_error", message: "invalid_tool_call: arg parse failed" },
      { type: "turn_end" },
    );

    // Should not throw.
    const r = await handleStreaming(stream, ctxFor(thread));
    expect(r.hadVisibleText).toBe(false);
    expect(thread.posts).toHaveLength(1);
    expect(thread.posts[0]).toMatch(/^\u26a0\ufe0f Agent error: /);
  });
});

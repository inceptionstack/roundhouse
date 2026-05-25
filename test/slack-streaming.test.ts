/**
 * test/slack-streaming.test.ts — post-then-edit streaming for Slack.
 *
 * Covers the v3 polish from slack-plan.md §2.7:
 *  - first chunk → chat.postMessage; subsequent chunks → chat.update.
 *  - Final flush edits even when no individual chunk crossed the throttle.
 *  - Aborted signal stops chunk-loop iteration but still flushes the
 *    accumulated buffer.
 *  - Initial-post failure with backoff cap so the loop doesn't hammer Slack.
 */

import { describe, it, expect, vi } from "vitest";
import { handleSlackStream } from "../src/transports/slack/streaming";
import type { ChatThread } from "../src/transports/types";

function fakeSdk(opts: { initialFails?: number } = {}) {
  let initialPostCalls = 0;
  const calls: { post: any[]; update: any[] } = { post: [], update: [] };
  const sdk = {
    decodeThreadId: (id: string) => {
      const [, channel, threadTs = ""] = id.split(":");
      return { channel, threadTs };
    },
    webClient: {
      chat: {
        postMessage: vi.fn(async (args: any) => {
          calls.post.push(args);
          initialPostCalls++;
          if (initialPostCalls <= (opts.initialFails ?? 0)) {
            throw new Error("simulated post failure");
          }
          return { ts: `ts-${initialPostCalls}` };
        }),
        update: vi.fn(async (args: any) => { calls.update.push(args); return {}; }),
      },
    },
  };
  return { sdk: sdk as any, calls };
}

async function* gen(...chunks: string[]) {
  for (const c of chunks) yield c;
}

const thread: ChatThread = { id: "slack:C01:main", post: async () => {} };

describe("handleSlackStream", () => {
  it("posts initial then edits with each subsequent chunk's accumulated buffer (final flush)", async () => {
    const { sdk, calls } = fakeSdk();
    await handleSlackStream(sdk, thread, gen("hello ", "world"));
    expect(calls.post).toHaveLength(1);
    expect(calls.post[0]).toMatchObject({ channel: "C01", markdown_text: "hello " });
    // Throttling means we may not get a per-chunk edit — but the final flush
    // MUST update with the full accumulated body.
    const lastUpdate = calls.update[calls.update.length - 1];
    expect(lastUpdate).toMatchObject({ channel: "C01", ts: "ts-1", markdown_text: "hello world" });
  });

  it("retries initial post after backoff and then sends final flush as a last-resort post", async () => {
    const { sdk, calls } = fakeSdk({ initialFails: 1 });
    await handleSlackStream(sdk, thread, gen("part1", "part2"));
    // First initial post throws; the loop's backoff prevents an immediate
    // retry on chunk 2. The final flush retries unconditionally and
    // succeeds with the full body.
    expect(calls.post.length).toBeGreaterThanOrEqual(2);
    const successful = calls.post.find((p: any) => p.markdown_text.includes("part1part2"));
    expect(successful).toBeDefined();
  });

  it("respects an aborted signal: stops iterating but still flushes what we have", async () => {
    const { sdk, calls } = fakeSdk();
    const ac = new AbortController();
    async function* abortAfterFirst() {
      yield "alpha";
      ac.abort();
      yield "beta";   // should be skipped due to abort check
    }
    await handleSlackStream(sdk, thread, abortAfterFirst(), ac.signal);
    // Initial post happened with "alpha"; final flush MAY edit but only with
    // already-accumulated text (which depends on iteration order). Either
    // way, we should never have posted "beta" content.
    const allText = [...calls.post, ...calls.update]
      .map((c: any) => c.markdown_text || c.text)
      .join("|");
    expect(allText).toContain("alpha");
    expect(allText).not.toContain("beta");
  });

  it("no-ops on empty stream (no posts, no updates)", async () => {
    const { sdk, calls } = fakeSdk();
    await handleSlackStream(sdk, thread, gen());
    expect(calls.post).toHaveLength(0);
    expect(calls.update).toHaveLength(0);
  });

  it("warns and exits early on a non-slack thread id", async () => {
    const { sdk, calls } = fakeSdk();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await handleSlackStream(sdk, { id: "telegram:42", post: async () => {} }, gen("nope"));
    expect(calls.post).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("overflow: starts a fresh message after crossing the 12k cap", async () => {
    // Build a single chunk that exceeds the 12k limit. We expect:
    //  1. initial post (with the first 12k slice — clean cut)
    //  2. handleOverflow finalizes the first message and nulls messageTs
    //  3. continued chunks initialize a NEW message
    const { sdk, calls } = fakeSdk();
    const big = "a".repeat(13_000);
    await handleSlackStream(sdk, thread, gen(big));

    // Two posts (first chunk, then overflow re-init via final flush)
    expect(calls.post.length).toBeGreaterThanOrEqual(2);
    // Both should target the same channel and be valid markdown_text payloads
    for (const p of calls.post) {
      expect(p.channel).toBe("C01");
      expect(typeof p.markdown_text).toBe("string");
      expect(p.markdown_text.length).toBeLessThanOrEqual(12_000);
    }
    // The combined posted text should equal the original input
    const combined = calls.post.map((p: any) => p.markdown_text).join("");
    expect(combined.length).toBe(big.length);
  });
});

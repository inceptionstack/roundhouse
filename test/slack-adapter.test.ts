/**
 * test/slack-adapter.test.ts — TransportAdapter contract checks for SlackAdapter.
 *
 * Verifies the surface that Phase 1's CompositeTransportAdapter relies on:
 *  - ownsThread, ownsChatId, encodeParentThreadId, formatNotifySession
 *  - shape of postRich (uses { card, fallbackText }, NOT { blocks })
 *  - createThread builds a slack:CHANNEL:THREAD_TS id via the SDK encoder
 *  - postChannelMessage path receives the right payload shape
 */

import { describe, it, expect, vi } from "vitest";
import { SlackAdapter } from "../src/transports/slack/slack-adapter";
import type { ChatThread } from "../src/transports/types";

function fakeSdk() {
  const calls: Record<string, any[]> = {
    postChannelMessage: [],
    encodeThreadId: [],
    decodeThreadId: [],
    startTyping: [],
    chat_postMessage: [],
    chat_update: [],
  };
  const sdk = {
    encodeThreadId: vi.fn((data: { channel: string; threadTs: string }) => {
      calls.encodeThreadId.push(data);
      return `slack:${data.channel}:${data.threadTs || "main"}`;
    }),
    decodeThreadId: vi.fn((id: string) => {
      calls.decodeThreadId.push(id);
      const [, channel, threadTs = ""] = id.split(":");
      return { channel, threadTs };
    }),
    isDM: (id: string) => /^slack:D/.test(id),
    postChannelMessage: vi.fn(async (channelId: string, message: any) => {
      calls.postChannelMessage.push({ channelId, message });
      return { id: "raw-msg" };
    }),
    startTyping: vi.fn(async (id: string) => { calls.startTyping.push(id); }),
    webClient: {
      chat: {
        postMessage: vi.fn(async (args: any) => {
          calls.chat_postMessage.push(args);
          return { ts: "1712023032.0001", channel: args.channel };
        }),
        update: vi.fn(async (args: any) => { calls.chat_update.push(args); return {}; }),
      },
      auth: { test: vi.fn(async () => ({ ok: true })) },
    },
    getUser: vi.fn(async (id: string) => ({ userId: id, userName: "alice", fullName: "Alice" })),
  };
  return { sdk: sdk as any, calls };
}

describe("SlackAdapter", () => {
  it("ownsThread / ownsChatId / encodeParentThreadId / formatNotifySession", () => {
    const a = new SlackAdapter();
    expect(a.ownsThread({ id: "slack:C01:main", post: async () => {} })).toBe(true);
    expect(a.ownsThread({ id: "telegram:1", post: async () => {} })).toBe(false);

    expect(a.ownsChatId("C01ABC")).toBe(true);
    expect(a.ownsChatId("D01XYZ")).toBe(true);
    expect(a.ownsChatId("U02USER")).toBe(true);
    expect(a.ownsChatId("12345")).toBe(false);
    expect(a.ownsChatId(123)).toBe(false);

    expect(a.encodeParentThreadId("C01")).toBe("slack:C01:main");

    expect(a.formatNotifySession("D01")).toBe("main");
    expect(a.formatNotifySession("C01ABC")).toBe("channel:C01ABC");
    expect(a.formatNotifySession("Gxxxxx")).toBe("channel:Gxxxxx");
  });

  it("requires SDK attach() before SDK-dependent methods", () => {
    const a = new SlackAdapter();
    expect(() => a.createThread("C01")).toThrow(/not attached/);
  });

  it("createThread builds a slack:CHANNEL:THREAD_TS id and a working post()", async () => {
    const { sdk, calls } = fakeSdk();
    const a = new SlackAdapter();
    a.attach(sdk);
    const thread = a.createThread("C01");

    expect(thread.id).toBe("slack:C01:main");
    expect(calls.encodeThreadId).toEqual([{ channel: "C01", threadTs: "" }]);

    await thread.post("hello");
    expect(calls.postChannelMessage).toEqual([{ channelId: "C01", message: { markdown: "hello" } }]);

    await thread.post({ markdown: "**bold**" });
    expect(calls.postChannelMessage[1].message).toEqual({ markdown: "**bold**" });
  });

  it("postRich uses { card, fallbackText }, never { blocks }", async () => {
    const { sdk, calls } = fakeSdk();
    const a = new SlackAdapter();
    a.attach(sdk);

    const post = vi.fn(async () => {});
    const thread: ChatThread = { id: "slack:C01:main", post };

    await a.postRich(thread, {
      text: "fallback prose",
      menuCaption: "Pick one:",
      menu: { sections: [{ buttons: [{ label: "OK", actionId: "ok", value: "ok" }] }] },
    });

    expect(post).toHaveBeenCalledOnce();
    const [arg] = post.mock.calls[0];
    expect(arg).not.toHaveProperty("blocks");
    expect(arg).toHaveProperty("card");
    expect(arg).toHaveProperty("fallbackText");
    // confirm there's no smuggled markdown_text either
    expect(arg).not.toHaveProperty("markdown_text");

    // The card itself is the SDK's CardElement shape.
    const card = (arg as { card: any }).card;
    expect(card.type).toBe("card");
    expect(Array.isArray(card.children)).toBe(true);
  });

  it("postRich falls back to text when there's no menu", async () => {
    const a = new SlackAdapter();
    const post = vi.fn(async () => {});
    const thread: ChatThread = { id: "slack:C01:main", post };

    await a.postRich(thread, { text: "just text" });

    expect(post).toHaveBeenCalledOnce();
    const [arg] = post.mock.calls[0];
    expect(arg).toEqual({ markdown: "just text" });
  });

  it("notify routes through webClient.chat.postMessage when SDK is attached", async () => {
    const { sdk, calls } = fakeSdk();
    const a = new SlackAdapter();
    a.attach(sdk);

    await a.notify(["C01", 12345, "U02"], "hi");

    expect(calls.chat_postMessage).toHaveLength(2);   // dropped 12345 (telegram-shaped)
    expect(calls.chat_postMessage[0]).toMatchObject({
      channel: "C01",
      markdown_text: "hi",
      unfurl_links: false,
      mrkdwn: true,
    });
    expect(calls.chat_postMessage[1]).toMatchObject({ channel: "U02" });
  });

  it("enrichPrompt appends a slack-friendly hint", () => {
    const a = new SlackAdapter();
    const out = a.enrichPrompt({ id: "slack:C01:main", post: async () => {} }, "user input");
    expect(out.startsWith("user input\n\n")).toBe(true);
    expect(out).toContain("Format your final answer for Slack");
  });
});

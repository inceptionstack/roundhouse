/**
 * test/telegram-synthetic-thread.test.ts — the thread roundhouse builds for
 * messages that do not answer an incoming one (boot notice, cron results,
 * sub-agent reports). It calls the Bot API itself.
 *
 * A refused call used to return null, which the delivery code took for
 * success: no retry after a rate limit, no plain-text fallback, no log line.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TelegramAdapter } from "../src/transports/telegram/telegram-adapter";

const realFetch = globalThis.fetch;
const realToken = process.env.TELEGRAM_BOT_TOKEN;

type Reply = { status: number; body: unknown };
let replies: Reply[];
let requests: Array<{ method: string; payload: any }>;

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = "123456:TEST-TOKEN-NOT-REAL";
  replies = [];
  requests = [];
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    requests.push({ method: String(url).split("/").pop()!, payload: JSON.parse(init.body) });
    const reply = replies.shift() ?? { status: 200, body: { ok: true, result: { message_id: requests.length } } };
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as any;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = realToken;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("a thread created for a notice", () => {
  it("falls back to plain text when Telegram refuses the HTML", async () => {
    replies.push({ status: 400, body: { ok: false, error_code: 400, description: "Bad Request: can't parse entities" } });
    const thread = new TelegramAdapter().createThread(42);

    await thread.post("**hello** world");

    expect(requests.map((r) => [r.method, r.payload.parse_mode, r.payload.text])).toEqual([
      ["sendMessage", "HTML", "<b>hello</b> world"],
      ["sendMessage", undefined, "**hello** world"],
    ]);
  });

  it("waits and sends again after a rate limit", async () => {
    vi.useFakeTimers();
    replies.push({
      status: 429,
      body: { ok: false, error_code: 429, description: "Too Many Requests: retry after 3", parameters: { retry_after: 3 } },
    });
    const thread = new TelegramAdapter().createThread(42);

    const posted = thread.post("hello");
    await vi.advanceTimersByTimeAsync(2900);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    await posted;

    expect(requests.map((r) => r.payload.text)).toEqual(["hello", "hello"]);
  });

  it("says so in the log when Telegram refuses the message for good", async () => {
    const refusal = { status: 403, body: { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" } };
    replies.push(refusal, refusal);
    const thread = new TelegramAdapter().createThread(42);

    await thread.post("hello");

    const logged = vi.mocked(console.error).mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("5 characters not delivered");
    expect(logged).toContain("bot was blocked by the user");
    expect(logged).not.toContain("TEST-TOKEN");
  });
});

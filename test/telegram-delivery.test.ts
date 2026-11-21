/**
 * test/telegram-delivery.test.ts — what reaches Telegram, end to end.
 *
 * The first three blocks each reproduce a defect seen in production:
 *   1. text dropped at the 4096-character limit (posting and streaming)
 *   2. a code block split across messages rendering as prose
 *   3. a rate limit (HTTP 429) during streaming leaving the message truncated
 *
 * The last block posts and streams a few hundred generated documents and
 * checks that the reader ends up with every character of each. The
 * generator is seeded, so a failure names the seed that reproduces it.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { markdownToTelegramHtml } from "../src/transports/telegram/format";
import { postTelegramHtml, handleTelegramHtmlStream } from "../src/transports/telegram/html";
import {
  TELEGRAM_LIMIT,
  fakeTelegram,
  fakeClock,
  rateLimitError,
  htmlToVisible,
  inPieces,
  longAnswerWithCode,
  outsidePre,
  telegramHtmlProblem,
} from "./telegram-test-helpers";
import { CODE_MARK, firstDifference, flat, genDocument, rng, type Rng } from "./telegram-doc-generator";

const LIMIT = TELEGRAM_LIMIT;

afterEach(() => {
  vi.restoreAllMocks();
});

/** How many times `needle` occurs in `haystack` */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// ── 1. Nothing is dropped at the 4096-character limit ──────────────────

describe("no text is dropped at Telegram's message limit", () => {
  it("posting an 11,000-character answer with a 140-line code block delivers every code line", async () => {
    const { markdown, code } = longAnswerWithCode();
    expect(markdown.length).toBeGreaterThan(11_000);
    const t = fakeTelegram();

    await postTelegramHtml(t, markdown);

    for (const call of t.calls) {
      expect(call.payload.text.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
    }
    const seen = t.visible().join("\n");
    const missing = code.filter((line) => count(seen, line) !== 1);
    expect(missing).toEqual([]);
    expect(seen).toContain("Paragraph 6:");
    expect(seen).toContain("Run the migration before deploying");
  });

  it("posting never ends a message with a truncation marker", async () => {
    const { markdown } = longAnswerWithCode();
    const t = fakeTelegram();

    await postTelegramHtml(t, markdown);

    for (const m of t.messages()) {
      expect(m.text.endsWith("...")).toBe(false);
      expect(telegramHtmlProblem(m.text)).toBeNull();
    }
  });

  it("streaming the same answer delivers every code line, each bubble starting on a line boundary", async () => {
    const { markdown, code } = longAnswerWithCode();
    const clock = fakeClock();
    const t = fakeTelegram({ now: clock.now });

    await handleTelegramHtmlStream(t, inPieces(markdown, 37, () => clock.advance(40)), clock);

    const bubbles = t.visible();
    expect(bubbles.length).toBeGreaterThanOrEqual(3);
    for (const m of t.messages()) {
      expect(m.text.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
    }
    const seen = bubbles.join("\n");
    const missing = code.filter((line) => count(seen, line) !== 1);
    expect(missing).toEqual([]);

    // Every bubble after the first starts with a whole source line.
    const sourceLines = new Set(markdown.split("\n"));
    for (const bubble of bubbles.slice(1)) {
      const firstLine = bubble.replace(/^\n+/, "").split("\n")[0];
      expect(sourceLines.has(firstLine), `bubble starts mid-line: ${JSON.stringify(firstLine)}`).toBe(true);
    }
  });

  it("streaming one very long line delivers every character", async () => {
    const words = Array.from({ length: 1500 }, (_, i) => `w${i}`);
    const line = words.join(" ");
    const clock = fakeClock();
    const t = fakeTelegram({ now: clock.now });

    await handleTelegramHtmlStream(t, inPieces(line, 500, () => clock.advance(40)), clock);

    expect(t.visible().join("")).toBe(line);
  });
});

// ── 2. A code block split across messages stays a code block ───────────

describe("a code block split across messages", () => {
  const codeOnlyInPre = (html: string) => {
    expect(html).not.toContain("```");
    expect(outsidePre(html)).not.toContain("const cache");
  };

  it("renders as a code block in every message when posted", async () => {
    const { markdown } = longAnswerWithCode();
    const t = fakeTelegram();

    await postTelegramHtml(t, markdown);

    expect(t.messages().length).toBeGreaterThanOrEqual(3);
    for (const m of t.messages()) {
      expect(m.html).toBe(true);
      codeOnlyInPre(m.text);
    }
  });

  it("renders as a code block in every bubble when streamed", async () => {
    const { markdown } = longAnswerWithCode();
    const clock = fakeClock();
    const t = fakeTelegram({ now: clock.now });

    await handleTelegramHtmlStream(t, inPieces(markdown, 53, () => clock.advance(40)), clock);

    for (const m of t.messages()) {
      expect(m.html).toBe(true);
      codeOnlyInPre(m.text);
    }
  });

  it("keeps markdown inside the code literal after the split", async () => {
    const code = Array.from({ length: 150 }, (_, i) => `def __x__(self): return self.__dict__  # row ${i} *not* **bold**`);
    const markdown = "```python\n" + code.join("\n") + "\n```";
    const t = fakeTelegram();

    await postTelegramHtml(t, markdown);

    expect(t.messages().length).toBeGreaterThanOrEqual(2);
    for (const m of t.messages()) {
      expect(m.text).not.toMatch(/<b>|<i>/);
      expect(m.text.startsWith("<pre>")).toBe(true);
      expect(m.text.trimEnd().endsWith("</pre>")).toBe(true);
    }
    expect(t.visible().join("\n")).toBe(code.join("\n"));
  });

  it("hard-splits a single line longer than the limit inside a fence instead of dropping it", async () => {
    const longLine = "x<y>&".repeat(1400); // 7000 characters, 16,800 once escaped
    const markdown = "```\n" + longLine + "\n```";
    const t = fakeTelegram();

    await postTelegramHtml(t, markdown);

    for (const m of t.messages()) {
      expect(m.text.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
      expect(m.text.startsWith("<pre>")).toBe(true);
      expect(telegramHtmlProblem(m.text)).toBeNull();
    }
    expect(t.visible().join("")).toBe(longLine);
  });
});

// ── 3. A rate limit during streaming does not truncate the message ─────

describe("a Telegram rate limit (HTTP 429) during streaming", () => {
  const text = "Hello there. " + Array.from({ length: 60 }, (_, i) => `Sentence number ${i} of the answer.`).join(" ");

  it("still delivers the final text once the retry-after has passed", async () => {
    const clock = fakeClock();
    let blockedUntil = 0;
    const t = fakeTelegram({
      now: clock.now,
      fail: (call, index) => {
        // The first call is accepted. The second is rejected with retry_after 20 s,
        // and so is anything else sent before those 20 s are over.
        if (index === 1) blockedUntil = clock.now() + 20_000;
        return index >= 1 && clock.now() < blockedUntil ? rateLimitError(20) : null;
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await handleTelegramHtmlStream(t, inPieces(text, 6, () => clock.advance(100)), clock);

    expect(t.visible()).toEqual([text]);
  });

  it("does not edit again before the retry-after has passed", async () => {
    const clock = fakeClock();
    let blockedUntil = 0;
    const t = fakeTelegram({
      now: clock.now,
      fail: (call, index) => {
        if (index === 1) blockedUntil = clock.now() + 20_000;
        return index >= 1 && clock.now() < blockedUntil ? rateLimitError(20) : null;
      },
    });

    await handleTelegramHtmlStream(t, inPieces(text, 6, () => clock.advance(100)), clock);

    // One rejected call tells us about the limit. Nothing else is sent until it lifts.
    expect(t.calls.filter((c) => c.failed).length).toBe(1);
    const afterLimit = t.calls.slice(2);
    for (const call of afterLimit) {
      expect(call.at).toBeGreaterThanOrEqual(blockedUntil);
    }
  });

  it("posts the rest as a new message when edits are refused for longer than an answer waits", async () => {
    const clock = fakeClock();
    // Edits are rejected for good; new messages are accepted.
    const t = fakeTelegram({
      now: clock.now,
      fail: (call) => (call.method === "editMessageText" ? rateLimitError(600) : null),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await handleTelegramHtmlStream(t, inPieces(text, 6, () => clock.advance(100)), clock);

    // One refused edit says how long. No edit is tried inside those ten
    // minutes, and nothing waits for them.
    expect(t.calls.filter((c) => c.method === "editMessageText")).toHaveLength(1);
    expect(clock.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(1100);
    // The first bubble kept what it had; the rest arrived in a second message.
    const bubbles = t.visible();
    expect(bubbles.length).toBe(2);
    expect(bubbles[0]).toBe("Hello ");
    expect(bubbles.join("")).toBe(text);
  });

  it("keeps throttling edits after one fails for another reason", async () => {
    const clock = fakeClock();
    const t = fakeTelegram({
      now: clock.now,
      fail: (call) =>
        call.method === "editMessageText" && call.payload.parse_mode === "HTML"
          ? new Error("Bad Request: can't parse entities")
          : null,
    });

    // One piece every 100 ms.
    const streamMs = Math.ceil(text.length / 12) * 100;
    await handleTelegramHtmlStream(t, inPieces(text, 12, () => clock.advance(100)), clock);

    const htmlEdits = t.calls.filter((c) => c.method === "editMessageText" && c.payload.parse_mode === "HTML");
    // At most one attempt per 1.1 s, plus the final one. Before the fix every piece was an attempt.
    expect(htmlEdits.length).toBeGreaterThan(3);
    expect(htmlEdits.length).toBeLessThanOrEqual(Math.floor(streamMs / 1100) + 1);
    for (let i = 1; i < htmlEdits.length - 1; i++) {
      expect(htmlEdits[i].at - htmlEdits[i - 1].at).toBeGreaterThanOrEqual(1100);
    }
    // The final edit fell back to plain text, so the whole answer is there.
    expect(t.visible()).toEqual([text]);
  });

  it("delivers the answer when the very first send is rate limited", async () => {
    const clock = fakeClock();
    const t = fakeTelegram({
      now: clock.now,
      fail: (_call, index) => (index === 0 ? rateLimitError(3) : null),
    });

    await handleTelegramHtmlStream(t, inPieces(text, 6, () => clock.advance(100)), clock);

    expect(t.visible()).toEqual([text]);
    // The second attempt waited for the 3 seconds Telegram asked for.
    expect(t.calls[1].at - t.calls[0].at).toBeGreaterThanOrEqual(3000);
  });

  it("retries a rate-limited post instead of dropping the message", async () => {
    const clock = fakeClock();
    const t = fakeTelegram({
      now: clock.now,
      fail: (_call, index) => (index === 0 ? rateLimitError(4) : null),
    });

    await postTelegramHtml(t, "**hello** world", clock);

    expect(clock.sleeps).toEqual([4000]);
    expect(t.messages().map((m) => m.text)).toEqual(["<b>hello</b> world"]);
  });

  it("does not call Telegram inside a wait that is longer than an answer waits", async () => {
    const clock = fakeClock();
    const t = fakeTelegram({
      now: clock.now,
      fail: (_call, index) => (index === 0 ? rateLimitError(600) : null),
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await postTelegramHtml(t, "**hello** world", clock);

    // One call, refused for ten minutes. A second call inside them would be
    // refused as well and can lengthen the wait, so none is made.
    expect(t.calls).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
    expect(errors.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/15 characters not delivered/);

    // The next answer to the same chat knows about the wait.
    clock.advance(60_000);
    await postTelegramHtml(t, "too early", clock);
    expect(t.calls).toHaveLength(1);

    // Once it is over, messages go out again.
    clock.advance(540_000);
    await postTelegramHtml(t, "later", clock);
    expect(t.messages().map((m) => m.text)).toEqual(["later"]);
  });

  const lines = (from: number, to: number) =>
    Array.from({ length: to - from }, (_, i) => `Line ${from + i} of the answer with some words to fill it up nicely.`);

  it("waits out a rate limit of 35 seconds in the middle of a long answer", async () => {
    const clock = fakeClock();
    let blockedUntil = 0;
    const t = fakeTelegram({
      now: clock.now,
      fail: (_call, index) => {
        if (index === 1) blockedUntil = clock.now() + 35_000;
        const left = Math.ceil((blockedUntil - clock.now()) / 1000);
        return left > 0 ? rateLimitError(left) : null;
      },
    });

    await postTelegramHtml(t, lines(0, 200).join("\n"), clock);

    expect(clock.sleeps).toEqual([35_000]);
    expect(t.calls.filter((c) => c.failed)).toHaveLength(1);
    expect(t.visible().map((bubble) => bubble.trimEnd()).join("\n").split("\n")).toEqual(lines(0, 200));
  });

  it("sends nothing after a chunk that a rate limit holds back", async () => {
    const clock = fakeClock();
    const t = fakeTelegram({
      now: clock.now,
      fail: (_call, index) => (index >= 1 ? rateLimitError(600) : null),
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const answer = lines(0, 200).join("\n");

    await postTelegramHtml(t, answer, clock);

    // The first message arrived. The second was refused; the third is not
    // sent on its own, since it would arrive without the second.
    expect(t.calls).toHaveLength(2);
    expect(t.messages()).toHaveLength(1);
    expect(errors).toHaveBeenCalledTimes(1);
    // What the log says was lost is exactly what the reader did not get.
    const lost = Number(/(\d+) characters not delivered/.exec(String(errors.mock.calls[0][0]))?.[1]);
    expect(lost).toBeGreaterThan(4000);
    expect(t.visible()[0]).toBe(answer.slice(0, answer.length - lost));
  });

  it("stops a streamed answer after a part that a rate limit holds back", async () => {
    const clock = fakeClock();
    let sends = 0;
    const t = fakeTelegram({
      now: clock.now,
      // The message that would open the second bubble is refused for ten minutes.
      fail: (call) => (call.method === "sendMessage" && ++sends === 2 ? rateLimitError(600) : null),
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const all = lines(0, 220);
    const answer = all.join("\n");
    async function* pieces() {
      for (let i = 0; i < all.length; i++) {
        // The second bubble fills up while the limit is on. Then the stream
        // pauses for longer than the limit lasts, and goes on.
        clock.advance(i === 170 ? 700_000 : 50);
        yield all[i] + (i < all.length - 1 ? "\n" : "");
      }
    }

    await handleTelegramHtmlStream(t, pieces(), clock);

    // The first bubble arrived. The second was held back, so the third is not
    // sent either, although Telegram would take it by then: it would follow
    // the first with a hole in between.
    expect(t.messages()).toHaveLength(1);
    expect(t.calls.filter((c) => c.failed)).toHaveLength(1);
    expect(errors).toHaveBeenCalledTimes(1);
    const lost = Number(/(\d+) characters not delivered/.exec(String(errors.mock.calls[0][0]))?.[1]);
    expect(lost).toBeGreaterThan(8000);
    expect(t.visible()[0].trimEnd()).toBe(answer.slice(0, answer.length - lost).trimEnd());
  });

  it("waits 90 seconds for one answer in total, not for each message", async () => {
    const clock = fakeClock();
    // Every message is refused once, with a wait of 40 seconds.
    const refusedOnce = new Set<string>();
    const t = fakeTelegram({
      now: clock.now,
      fail: (call) => {
        if (refusedOnce.has(call.payload.text)) return null;
        refusedOnce.add(call.payload.text);
        return rateLimitError(40);
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await postTelegramHtml(t, lines(0, 200).join("\n"), clock);

    // Two waits fit; the third does not, so the third message is not retried.
    expect(clock.sleeps).toEqual([40_000, 40_000]);
    expect(t.messages()).toHaveLength(2);
  });

  it("edits no more often than every 1100 ms while streaming", async () => {
    const clock = fakeClock();
    const t = fakeTelegram({ now: clock.now });

    await handleTelegramHtmlStream(t, inPieces(text, 6, () => clock.advance(100)), clock);

    const edits = t.calls.filter((c) => c.method === "editMessageText");
    expect(edits.length).toBeGreaterThan(3);
    // The last edit is the final one and is not throttled.
    for (let i = 1; i < edits.length - 1; i++) {
      expect(edits[i].at - edits[i - 1].at).toBeGreaterThanOrEqual(1100);
    }
    expect(t.visible()).toEqual([text]);
  });

  it("edits no more often than every 3100 ms in a group", async () => {
    const clock = fakeClock();
    const t = fakeTelegram({ now: clock.now, chatId: "-1001234567890" });

    await handleTelegramHtmlStream(t, inPieces(text, 6, () => clock.advance(100)), clock);

    const edits = t.calls.filter((c) => c.method === "editMessageText");
    expect(edits.length).toBeGreaterThan(3);
    for (let i = 1; i < edits.length - 1; i++) {
      expect(edits[i].at - edits[i - 1].at).toBeGreaterThanOrEqual(3100);
    }
    expect(t.calls[0].payload.chat_id).toBe("-1001234567890");
    expect(t.visible()).toEqual([text]);
  });
});

describe("the last edit of a streamed message", () => {
  it("counts as delivered when Telegram says the message is not modified", async () => {
    const clock = fakeClock();
    const t = fakeTelegram({
      now: clock.now,
      fail: (call) =>
        call.method === "editMessageText"
          ? new Error("Bad Request: message is not modified: specified new message content and reply markup are exactly the same")
          : null,
    });

    await handleTelegramHtmlStream(t, inPieces("**done** now", 8, () => clock.advance(10)), clock);

    // No plain-text edit and no second message.
    expect(t.calls.map((c) => c.method)).toEqual(["sendMessage", "editMessageText"]);
    expect(t.messages()).toHaveLength(1);
  });

  it("makes no edit for a change Telegram would not show", async () => {
    const clock = fakeClock();
    const t = fakeTelegram({ now: clock.now });

    // The second piece only adds a line break, which Telegram trims.
    await handleTelegramHtmlStream(t, inPieces("**done**\n", 8, () => clock.advance(10)), clock);

    expect(t.calls.map((c) => c.method)).toEqual(["sendMessage"]);
    expect(t.messages()).toEqual([{ id: 1, text: "<b>done</b>", html: true }]);
  });

  it("is not made sooner after the previous edit than any other edit", async () => {
    const clock = fakeClock();
    const t = fakeTelegram({ now: clock.now });
    async function* pieces() {
      yield "a";
      clock.advance(1200);
      yield "b";
      clock.advance(20);
      yield "c";
    }

    await handleTelegramHtmlStream(t, pieces(), clock);

    const edits = t.calls.filter((c) => c.method === "editMessageText");
    expect(edits.map((c) => c.payload.text)).toEqual(["ab", "abc"]);
    expect(edits[1].at - edits[0].at).toBeGreaterThanOrEqual(1100);
  });

  it("does not send half an emoji when a piece ends in the middle of one", async () => {
    const clock = fakeClock();
    const t = fakeTelegram({ now: clock.now });
    const text = "Done 😀 and more text after it.";
    const half = text.indexOf("😀") + 1;
    async function* pieces() {
      yield text.slice(0, 3);
      clock.advance(1200);
      yield text.slice(3, half); // ends with the first half of the emoji
      clock.advance(1200);
      yield text.slice(half);
    }

    await handleTelegramHtmlStream(t, pieces(), clock);

    for (const call of t.calls) expect(call.payload.text.isWellFormed(), call.payload.text).toBe(true);
    expect(t.visible()).toEqual([text]);
  });

  it("delivers what arrived when the stream fails, then reports the failure", async () => {
    const clock = fakeClock();
    const t = fakeTelegram({ now: clock.now });
    async function* pieces() {
      yield "The first part. ";
      yield "The second part, which no edit has shown yet.";
      throw new Error("model stream broke");
    }

    await expect(handleTelegramHtmlStream(t, pieces(), clock)).rejects.toThrow("model stream broke");

    expect(t.visible()).toEqual(["The first part. The second part, which no edit has shown yet."]);
  });

  it("closes a code block the answer left open", async () => {
    const clock = fakeClock();
    const t = fakeTelegram({ now: clock.now });

    await handleTelegramHtmlStream(t, inPieces("Run:\n```sh\nnpm test", 5, () => clock.advance(10)), clock);

    expect(t.messages().map((m) => m.text)).toEqual(["Run:\n<pre>npm test</pre>"]);
  });
});

// ── Generated documents ───────────────────────────────

describe("a stream that goes quiet", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the text it has within about a second, not when the next piece arrives", async () => {
    vi.useFakeTimers();
    const t = fakeTelegram({ now: Date.now });
    const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    async function* pieces() {
      yield "I";
      await pause(150);
      yield "'ll read the config";
      await pause(300);
      yield " file and check the retry settings.";
      await pause(90_000); // a tool runs; no text arrives
      yield " Done.";
    }
    const said = "I'll read the config file and check the retry settings.";

    const delivery = handleTelegramHtmlStream(t, pieces());
    await vi.advanceTimersByTimeAsync(2000);

    // Two seconds in, with 88 seconds of silence still to come.
    expect(t.visible()).toEqual([said]);

    // And it does not keep calling Telegram while nothing changes.
    const calls = t.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.calls.length).toBe(calls);

    await vi.advanceTimersByTimeAsync(40_000);
    await delivery;
    expect(t.visible()).toEqual([said + " Done."]);
  });

  it("waits for a rate limit to end, then shows the text", async () => {
    vi.useFakeTimers();
    let refused = false;
    const t = fakeTelegram({
      now: Date.now,
      fail: (call) => {
        if (call.method !== "editMessageText" || refused) return null;
        refused = true;
        return rateLimitError(5);
      },
    });
    const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    async function* pieces() {
      yield "One.";
      await pause(1200);
      yield " Two.";
      await pause(60_000);
    }

    const delivery = handleTelegramHtmlStream(t, pieces());
    await vi.advanceTimersByTimeAsync(4000);
    expect(t.visible()).toEqual(["One."]); // the edit was refused for 5 seconds
    await vi.advanceTimersByTimeAsync(3000);
    expect(t.visible()).toEqual(["One. Two."]);

    await vi.advanceTimersByTimeAsync(60_000);
    await delivery;
  });

  it("does not keep the answer waiting for a rate limit once the stream has ended", async () => {
    vi.useFakeTimers();
    const t = fakeTelegram({
      now: Date.now,
      fail: (call) => (call.method === "editMessageText" ? rateLimitError(600) : null),
    });
    const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    async function* pieces() {
      yield "One.";
      await pause(1200);
      yield " Two."; // this edit is refused for ten minutes
      await pause(2000);
    }
    const started = Date.now();
    let finishedAfter = -1;

    const delivery = handleTelegramHtmlStream(t, pieces()).then(() => { finishedAfter = Date.now() - started; });
    await vi.advanceTimersByTimeAsync(10_000);
    await delivery;

    // Done when the stream was, not ten minutes later, and no timer is left behind.
    expect(finishedAfter).toBeLessThanOrEqual(3300);
    expect(vi.getTimerCount()).toBe(0);
    expect(t.visible().join("")).toBe("One. Two.");
  });
});

describe("a table that is being streamed when a message fills up", () => {
  it("repeats the header for the rows that move to the next message", async () => {
    let table = "| Name | Value | Note |\n|------|-------|------|\n";
    for (let i = 0; i < 12; i++) table += `| item ${i} | ${i * 7} | note for row ${i} |\n`;
    let boundaries = 0;
    for (const size of [3, 17, 60]) {
      for (let proseLines = 50; proseLines <= 64; proseLines++) {
        const prose = Array.from({ length: proseLines }, (_, i) => `Line ${i} of prose with some words to fill the line up nicely.`).join("\n");
        const clock = fakeClock();
        const t = fakeTelegram({ now: clock.now });

        await handleTelegramHtmlStream(t, inPieces(`${prose}\n\n${table}`, size, () => clock.advance(40)), clock);

        const bubbles = t.visible();
        const where = `pieces of ${size}, ${proseLines} prose lines`;
        // No row is left outside a table, and every boxed row sits under a header.
        expect(bubbles.join("\n"), where).not.toMatch(/^\| item/m);
        for (const bubble of bubbles) {
          if (bubble.includes("│ item")) expect(bubble, where).toContain("│ Name");
        }
        for (let i = 0; i < 12; i++) expect(bubbles.join("\n"), where).toContain(`│ item ${i} `);
        if (bubbles.filter((b) => b.includes("│ item")).length > 1) boundaries++;
      }
    }
    // The table did straddle two messages in a good number of these runs.
    expect(boundaries).toBeGreaterThan(5);
  });
});

describe("a code block whose first line is longer than a message", () => {
  const answer = "Here is the file:\n\n```json\n" + '{"k":"' + "x".repeat(5000) + '"}' + "\n```\nDone.";

  for (const [how, deliver] of [
    ["posted", (t: any, clock: any) => postTelegramHtml(t, answer, clock)],
    ["streamed", (t: any, clock: any) => handleTelegramHtmlStream(t, inPieces(answer, 50, () => clock.advance(40)), clock)],
  ] as const) {
    it(`${how}: no message consists of the fence alone`, async () => {
      const clock = fakeClock();
      const t = fakeTelegram({ now: clock.now });

      await deliver(t, clock);

      // Nothing was refused (an empty code block is), so nothing fell back to raw markdown.
      expect(t.calls.filter((c) => c.failed)).toEqual([]);
      for (const m of t.messages()) expect(m.html).toBe(true);
      const shown = t.visible().join("");
      expect(count(shown, "x")).toBe(5000);
      expect(shown).not.toContain("```");
      expect(shown.endsWith("Done.")).toBe(true);
    });
  }
});

describe("delivery of generated documents", () => {
  it("delivers every visible character when posting 150 documents", async () => {
    for (let seed = 2001; seed <= 2150; seed++) {
      const md = genDocument(seed, "no-tables");
      const t = fakeTelegram();
      await postTelegramHtml(t, md);

      for (const m of t.messages()) {
        expect(m.html, `seed ${seed}`).toBe(true);
        expect(m.text.length, `seed ${seed}`).toBeLessThanOrEqual(LIMIT);
      }
      const whole = htmlToVisible(markdownToTelegramHtml(md)).replace(/\n/g, "");
      expect(firstDifference(flat(t.visible()), whole), `seed ${seed}`).toBeNull();
    }
  });

  /** The document as a model would stream it: mostly small pieces, now and then a big one */
  async function* streamed(md: string, r: Rng, clock: ReturnType<typeof fakeClock>): AsyncIterable<string> {
    for (let i = 0; i < md.length; ) {
      const size = r.chance(0.05) ? r.int(2000, 12000) : r.int(1, 400);
      clock.advance(r.int(10, 900));
      yield md.slice(i, i + size);
      i += size;
    }
  }

  const expectValidBubbles = (t: ReturnType<typeof fakeTelegram>, seed: number) => {
    for (const m of t.messages()) {
      expect(m.html, `seed ${seed}`).toBe(true);
      expect(m.text.length, `seed ${seed}`).toBeLessThanOrEqual(LIMIT);
      expect(telegramHtmlProblem(m.text), `seed ${seed}`).toBeNull();
      expect(outsidePre(m.text).includes(CODE_MARK), `seed ${seed}: code outside a code block`).toBe(false);
    }
  };

  it("delivers every visible character when streaming 80 documents", async () => {
    for (let seed = 3001; seed <= 3080; seed++) {
      const md = genDocument(seed, "no-tables");
      const clock = fakeClock();
      const t = fakeTelegram({ now: clock.now });

      await handleTelegramHtmlStream(t, streamed(md, rng(seed), clock), clock);

      expectValidBubbles(t, seed);
      const whole = htmlToVisible(markdownToTelegramHtml(md)).replace(/\n/g, "");
      expect(firstDifference(flat(t.visible()), whole), `seed ${seed}`).toBeNull();
    }
  });

  it("delivers every visible character when streaming 80 documents through rate limits", async () => {
    let limited = 0;
    for (let seed = 4001; seed <= 4080; seed++) {
      const md = genDocument(seed, "no-tables");
      const clock = fakeClock();
      const r = rng(seed * 7);
      // Now and then Telegram answers 429 and refuses everything for up to 25 seconds.
      let blockedUntil = 0;
      const t = fakeTelegram({
        now: clock.now,
        fail: () => {
          const now = clock.now();
          if (now >= blockedUntil + 60_000 && r.chance(0.15)) {
            blockedUntil = now + r.int(1, 25) * 1000;
            limited++;
          }
          return now < blockedUntil ? rateLimitError(Math.ceil((blockedUntil - now) / 1000)) : null;
        },
      });

      await handleTelegramHtmlStream(t, streamed(md, rng(seed), clock), clock);

      expectValidBubbles(t, seed);
      const whole = htmlToVisible(markdownToTelegramHtml(md)).replace(/\n/g, "");
      expect(firstDifference(flat(t.visible()), whole), `seed ${seed}`).toBeNull();
    }
    expect(limited).toBeGreaterThan(40);
  });

  it("delivers every table row of 120 documents with tables, and Telegram refuses nothing", async () => {
    /** The rows of the boxed tables in what a reader sees, without their padding */
    const tableRows = (visible: string): Map<string, number> => {
      const rows = new Map<string, number>();
      for (const line of visible.split("\n")) {
        if (!line.startsWith("│")) continue;
        const row = line.replace(/\s+/g, "");
        rows.set(row, (rows.get(row) ?? 0) + 1);
      }
      return rows;
    };
    let rowsChecked = 0;
    for (let seed = 6001; seed <= 6120; seed++) {
      const md = genDocument(seed, "full");
      const clock = fakeClock();
      const t = fakeTelegram({ now: clock.now });
      if (seed % 2) await postTelegramHtml(t, md, clock);
      else await handleTelegramHtmlStream(t, streamed(md, rng(seed), clock), clock);

      // The fake refuses what Telegram refuses: empty messages, bad HTML, text over the limit.
      expect(t.calls.filter((c) => c.failed).map((c) => c.payload.text.slice(0, 80)), `seed ${seed}`).toEqual([]);
      expectValidBubbles(t, seed);
      // A table split over two messages repeats its header, so a row may be
      // there more often than in the whole document, never less.
      const delivered = tableRows(t.visible().join("\n"));
      for (const [row, times] of tableRows(htmlToVisible(markdownToTelegramHtml(md)))) {
        expect(delivered.get(row) ?? 0, `seed ${seed}: ${row}`).toBeGreaterThanOrEqual(times);
        rowsChecked++;
      }
    }
    expect(rowsChecked).toBeGreaterThan(300);
  });

  it("delivers every visible character when some bubbles can never be edited", async () => {
    let stuck = 0;
    for (let seed = 5001; seed <= 5080; seed++) {
      const md = genDocument(seed, "plain-prose");
      const clock = fakeClock();
      const r = rng(seed * 11);
      // Every edit of an unlucky message is refused with a retry-after longer than we wait.
      const unlucky = new Map<number, boolean>();
      const t = fakeTelegram({
        now: clock.now,
        fail: (call) => {
          if (call.method !== "editMessageText") return null;
          const id = call.payload.message_id as number;
          if (!unlucky.has(id)) unlucky.set(id, r.chance(0.4));
          return unlucky.get(id) ? rateLimitError(120) : null;
        },
      });

      await handleTelegramHtmlStream(t, streamed(md, rng(seed), clock), clock);

      stuck += [...unlucky.values()].filter(Boolean).length;
      for (const m of t.messages()) {
        expect(m.text.length, `seed ${seed}`).toBeLessThanOrEqual(LIMIT);
        expect(telegramHtmlProblem(m.text), `seed ${seed}`).toBeNull();
      }
      // A bubble stuck in the middle of a fence line shows a few of its backticks.
      const strip = (s: string) => s.replace(/[`\n]/g, "");
      const whole = strip(htmlToVisible(markdownToTelegramHtml(md)));
      expect(firstDifference(strip(t.visible().join("")), whole), `seed ${seed}`).toBeNull();
    }
    expect(stuck).toBeGreaterThan(40);
  });
});

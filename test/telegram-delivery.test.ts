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

  it("waits at most 30 seconds for the final edit, then posts the rest as a new message", async () => {
    const clock = fakeClock();
    // Edits are rejected for good; new messages are accepted.
    const t = fakeTelegram({
      now: clock.now,
      fail: (call) => (call.method === "editMessageText" ? rateLimitError(600) : null),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await handleTelegramHtmlStream(t, inPieces(text, 6, () => clock.advance(100)), clock);

    expect(clock.sleeps.length).toBeGreaterThan(0);
    expect(Math.max(...clock.sleeps)).toBeLessThanOrEqual(30_000);
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

  it("does not call Telegram again before a wait longer than its patience has run out", async () => {
    const clock = fakeClock();
    const t = fakeTelegram({
      now: clock.now,
      fail: (_call, index) => (index === 0 ? rateLimitError(60) : null),
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await postTelegramHtml(t, "**hello** world", clock);

    // One call, refused for 60 s. A second call inside that minute would be
    // refused as well and can lengthen the wait, so none is made.
    expect(t.calls).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
    expect(errors.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/not delivered/);
    errors.mockRestore();

    // Once the minute is over the next message goes out, without a wait.
    clock.advance(60_000);
    await postTelegramHtml(t, "later", clock);
    expect(t.messages().map((m) => m.text)).toEqual(["later"]);
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

    // The second piece only adds a line break, which Telegram trims.
    await handleTelegramHtmlStream(t, inPieces("**done**\n", 8, () => clock.advance(10)), clock);

    // No plain-text edit and no second message.
    expect(t.calls.map((c) => c.method)).toEqual(["sendMessage", "editMessageText"]);
    expect(t.messages()).toEqual([{ id: 1, text: "<b>done</b>", html: true }]);
  });

  it("closes a code block the answer left open", async () => {
    const clock = fakeClock();
    const t = fakeTelegram({ now: clock.now });

    await handleTelegramHtmlStream(t, inPieces("Run:\n```sh\nnpm test", 5, () => clock.advance(10)), clock);

    expect(t.messages().map((m) => m.text)).toEqual(["Run:\n<pre>npm test</pre>"]);
  });
});

// ── Generated documents ───────────────────────────────

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

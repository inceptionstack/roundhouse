import { describe, it, expect, vi } from "vitest";
import { isTelegramThread, postTelegramHtml, handleTelegramHtmlStream } from "../src/telegram-html";

function createMockThread(chatId = "12345") {
  const calls: Array<{ method: string; payload: any }> = [];
  let messageCounter = 1;
  return {
    id: `telegram:${chatId}`,
    adapter: {
      telegramFetch: vi.fn(async (method: string, payload: any) => {
        calls.push({ method, payload });
        if (method === "sendMessage") {
          return { message_id: messageCounter++, chat: { id: Number(chatId) } };
        }
        return true;
      }),
    },
    calls,
  };
}

describe("isTelegramThread", () => {
  it("returns true for valid Telegram thread", () => {
    const t = createMockThread();
    expect(isTelegramThread(t)).toBe(true);
  });

  it("returns false for non-Telegram thread", () => {
    expect(isTelegramThread({ id: "slack:C01", adapter: {} })).toBe(false);
    expect(isTelegramThread({ id: "telegram:123" })).toBe(false);
    expect(isTelegramThread(null)).toBe(false);
  });
});

describe("postTelegramHtml", () => {
  it("sends HTML with parse_mode for simple markdown", async () => {
    const t = createMockThread();
    await postTelegramHtml(t, "**hello** world");
    expect(t.calls.length).toBe(1);
    expect(t.calls[0].method).toBe("sendMessage");
    expect(t.calls[0].payload.parse_mode).toBe("HTML");
    expect(t.calls[0].payload.text).toContain("<b>hello</b>");
    expect(t.calls[0].payload.chat_id).toBe("12345");
  });

  it("splits long markdown into multiple messages", async () => {
    const t = createMockThread();
    // 3800 * 2 chars should produce at least 2 messages
    const longText = "word ".repeat(1600);
    await postTelegramHtml(t, longText);
    expect(t.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of t.calls) {
      expect(call.method).toBe("sendMessage");
      expect(call.payload.parse_mode).toBe("HTML");
    }
  });

  it("falls back to plain text when HTML fails", async () => {
    const calls: any[] = [];
    let callCount = 0;
    const t = {
      id: "telegram:999",
      adapter: {
        telegramFetch: vi.fn(async (method: string, payload: any) => {
          calls.push({ method, payload });
          callCount++;
          // First call (HTML) fails, second (plain) succeeds
          if (callCount === 1) throw new Error("Bad HTML");
          return { message_id: 1, chat: { id: 999 } };
        }),
      },
    };
    await postTelegramHtml(t, "hello");
    expect(calls.length).toBe(2);
    expect(calls[0].payload.parse_mode).toBe("HTML");
    expect(calls[1].payload.parse_mode).toBeUndefined();
  });

  it("includes message_thread_id for topic threads", async () => {
    const t = createMockThread();
    t.id = "telegram:12345:42";
    await postTelegramHtml(t, "hello");
    expect(t.calls[0].payload.message_thread_id).toBe(42);
  });
});

describe("handleTelegramHtmlStream", () => {
  async function* textStream(chunks: string[]): AsyncIterable<string> {
    for (const chunk of chunks) {
      yield chunk;
    }
  }

  it("sends and edits a single streaming message", async () => {
    const t = createMockThread();
    await handleTelegramHtmlStream(t, textStream(["Hello ", "**world**"]));
    // At least one sendMessage + potentially one edit
    const sends = t.calls.filter(c => c.method === "sendMessage");
    expect(sends.length).toBe(1);
    expect(sends[0].payload.parse_mode).toBe("HTML");
    // Final edit should contain formatted content
    const edits = t.calls.filter(c => c.method === "editMessageText");
    if (edits.length > 0) {
      const lastEdit = edits[edits.length - 1];
      expect(lastEdit.payload.text).toContain("<b>world</b>");
    }
  });

  it("handles empty stream gracefully", async () => {
    const t = createMockThread();
    await handleTelegramHtmlStream(t, textStream([]));
    expect(t.calls.length).toBe(0);
  });

  it("handles whitespace-only stream", async () => {
    const t = createMockThread();
    await handleTelegramHtmlStream(t, textStream(["   ", "  "]));
    // Should not crash; may or may not send depending on trim behavior
    // Just verify no throws
  });

  it("handles overflow by posting remainder as new messages", async () => {
    const t = createMockThread();
    // Generate text that will exceed 4096 chars when converted to HTML
    const bigChunk = "x".repeat(5000);
    await handleTelegramHtmlStream(t, textStream([bigChunk]));
    // Should have at least 1 sendMessage (initial) and then overflow handling
    const sends = t.calls.filter(c => c.method === "sendMessage");
    expect(sends.length).toBeGreaterThanOrEqual(1);
  });

  it("sends initial plain text when HTML fails", async () => {
    let callCount = 0;
    const calls: any[] = [];
    const t = {
      id: "telegram:999",
      adapter: {
        telegramFetch: vi.fn(async (method: string, payload: any) => {
          calls.push({ method, payload });
          callCount++;
          // First HTML send fails, plain text succeeds
          if (callCount === 1 && payload.parse_mode === "HTML") throw new Error("Bad");
          return { message_id: 1, chat: { id: 999 } };
        }),
      },
    };
    await handleTelegramHtmlStream(t, textStream(["hello world"]));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // Second call should be plain text fallback
    expect(calls[1].payload.parse_mode).toBeUndefined();
  });
});

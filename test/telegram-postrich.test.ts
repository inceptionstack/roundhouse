/**
 * test for src/transports/telegram/telegram-adapter.ts \u2014 postRich behaviour.
 *
 * Verifies the two key contracts from docs/rich-ui-surface-design.md:
 *   - With a menu and a working transport: emit `sendMessage` with
 *     parse_mode HTML and an inline_keyboard built from the RichMenu.
 *   - With a menu but a broken / missing transport: degrade to plain text
 *     via the existing `postMessage` path. NEVER throw at the caller.
 *
 * Also covers the no-menu path (text-only RichResponse) which must just
 * post the text.
 */

import { describe, it, expect, vi } from "vitest";
import { TelegramAdapter } from "../src/transports";
import type { ChatThread, RichResponse } from "../src/transports";

function makeTelegramThread(opts: {
  chatId?: string;
  telegramFetch?: (m: string, p: Record<string, unknown>) => Promise<unknown>;
  post?: (text: string | { markdown: string }) => Promise<unknown>;
} = {}): ChatThread {
  const chatId = opts.chatId ?? "12345";
  const telegramFetch = opts.telegramFetch ?? vi.fn(async () => ({ ok: true }));
  const post = opts.post ?? vi.fn(async () => undefined);
  return {
    id: `telegram:${chatId}`,
    platformThreadId: `telegram:${chatId}`,
    adapter: { telegramFetch },
    post,
  } as unknown as ChatThread;
}

const MENU_RESPONSE: RichResponse = {
  text: "Pick a model",
  menu: {
    title: "Models",
    body: "Pick one",
    sections: [
      {
        columns: 2,
        buttons: [
          { label: "Sonnet", actionId: "model_select", value: "sonnet", selected: true },
          { label: "Opus", actionId: "model_select", value: "opus" },
        ],
      },
    ],
  },
};

describe("TelegramAdapter.postRich", () => {
  it("emits sendMessage with inline_keyboard when adapter + chat id are present", async () => {
    const telegramFetch = vi.fn(async () => ({ ok: true }));
    const thread = makeTelegramThread({ chatId: "777", telegramFetch });
    const adapter = new TelegramAdapter();

    await adapter.postRich(thread, MENU_RESPONSE);

    expect(telegramFetch).toHaveBeenCalledTimes(1);
    const [method, payload] = telegramFetch.mock.calls[0]!;
    expect(method).toBe("sendMessage");
    const p = payload as any;
    expect(p.chat_id).toBe("777");
    expect(p.parse_mode).toBe("HTML");
    const rows = p.reply_markup.inline_keyboard as Array<Array<{ text: string; callback_data: string }>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(2);
    expect(rows[0][0].text).toContain("Sonnet");
    expect(rows[0][0].text).toContain("\u2713"); // selected hint
    expect(rows[0][1].text).toBe("Opus");
    for (const btn of rows[0]) {
      expect(btn.callback_data.startsWith("chat:")).toBe(true);
    }
  });

  it("falls back to plain-text postMessage when telegramFetch is missing", async () => {
    // Thread looks Telegram-shaped (id prefix) but has no adapter.telegramFetch.
    // postRich must not throw \u2014 it must post the text via postMessage,
    // which itself uses postTelegramHtml. Since postTelegramHtml requires
    // adapter.telegramFetch to be a function, and isTelegramThread checks it,
    // the path here actually exercises 'fall back to postMessage' branch
    // for a non-Telegram-shaped thread. We use a non-Telegram thread to
    // exercise the most defensive branch.
    const post = vi.fn(async () => undefined);
    const thread = {
      id: "memory:1",
      post,
    } as unknown as ChatThread;
    const adapter = new TelegramAdapter();

    // postMessage on TelegramAdapter throws on non-Telegram threads (by
    // contract). postRich must catch that and not propagate. We assert that
    // the fallback path was taken by stubbing postMessage directly via spy
    // on the prototype.
    const postMessageSpy = vi.spyOn(adapter, "postMessage").mockResolvedValue(undefined);

    await adapter.postRich(thread, MENU_RESPONSE);

    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    expect(postMessageSpy.mock.calls[0][1]).toBe(MENU_RESPONSE.text);
  });

  it("falls back to text when a menu telegramFetch throws", async () => {
    const telegramFetch = vi.fn(async () => { throw new Error("network down"); });
    const thread = makeTelegramThread({ chatId: "42", telegramFetch });
    const adapter = new TelegramAdapter();

    // Spy on postMessage (instance) to assert the fallback was invoked
    // exactly once with the response.text.
    const postMessageSpy = vi.spyOn(adapter, "postMessage").mockResolvedValue(undefined);

    await adapter.postRich(thread, MENU_RESPONSE);

    expect(telegramFetch).toHaveBeenCalledTimes(1);
    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    expect(postMessageSpy.mock.calls[0][1]).toBe(MENU_RESPONSE.text);
  });

  it("never throws when both telegramFetch and the text fallback fail", async () => {
    const telegramFetch = vi.fn(async () => { throw new Error("network down"); });
    const thread = makeTelegramThread({ telegramFetch });
    const adapter = new TelegramAdapter();
    vi.spyOn(adapter, "postMessage").mockRejectedValue(new Error("post failed too"));

    // Must not throw at the caller \u2014 postRich is allowed to log + swallow
    // when even the text fallback fails. This is the contract that
    // postCommandResult relies on.
    await expect(adapter.postRich(thread, MENU_RESPONSE)).resolves.toBeUndefined();
  });

  it("posts plain text when RichResponse has no menu", async () => {
    const telegramFetch = vi.fn(async () => ({ ok: true }));
    const thread = makeTelegramThread({ telegramFetch });
    const adapter = new TelegramAdapter();
    const postMessageSpy = vi.spyOn(adapter, "postMessage").mockResolvedValue(undefined);

    await adapter.postRich(thread, { text: "hello" });

    expect(telegramFetch).not.toHaveBeenCalled();
    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    expect(postMessageSpy.mock.calls[0][1]).toBe("hello");
  });

  it("falls back to thread.post when postMessage rejects (non-Telegram thread shape)", async () => {
    // Simulates a thread that lacks adapter.telegramFetch / telegram: id
    // shape (e.g. callback/invocation thread synthesized upstream) —
    // postMessage throws "non-Telegram thread", but thread.post() works.
    const post = vi.fn(async () => undefined);
    const thread = { id: "synthetic:1", post } as unknown as ChatThread;
    const adapter = new TelegramAdapter();

    // postMessage rejects (mimics isTelegramThread guard throwing).
    vi.spyOn(adapter, "postMessage").mockRejectedValue(new Error("non-Telegram thread"));

    await expect(adapter.postRich(thread, { text: "confirm" })).resolves.toBeUndefined();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("confirm");
  });
});

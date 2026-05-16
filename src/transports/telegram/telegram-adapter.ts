/**
 * transports/telegram/telegram-adapter.ts — Telegram transport adapter
 *
 * Implements TransportAdapter for Telegram, composing existing
 * utility modules (format, html, progress, notify, bot-commands).
 */

import type { TransportAdapter, ChatThread, IncomingMessage, PairingResult, RichResponse } from "../types";
import { isTelegramThread, postTelegramHtml } from "./html";
import { markdownToTelegramHtml } from "./format";
import { sendTelegramToMany } from "./notify";
import { BOT_COMMANDS } from "./bot-commands";
import { readPendingPairing, completePendingPairing, clearPendingPairing, isStartForNonce } from "./pairing";
import { toTelegramInlineKeyboard } from "./rich-ui";

/** Extract the numeric Telegram chat id from a thread's id string. */
function extractTelegramChatId(thread: { id?: string; platformThreadId?: string }): string | undefined {
  return thread.platformThreadId?.split(":")?.[1] ?? thread.id?.split(":")?.[1];
}

const TELEGRAM_FORMAT_HINT = "[Format your final answer to be telegram-friendly.]";

export class TelegramAdapter implements TransportAdapter {
  readonly name = "telegram";

  enrichPrompt(text: string): string {
    return `${text}\n\n${TELEGRAM_FORMAT_HINT}`;
  }

  async postMessage(thread: ChatThread, text: string): Promise<void> {
    if (!isTelegramThread(thread as any)) {
      throw new Error("TelegramAdapter.postMessage called with non-Telegram thread");
    }
    await postTelegramHtml(thread as any, text);
  }

  /**
   * Render a RichResponse as a Telegram message.
   *
   * - No menu → plain text via postMessage (HTML-formatted).
   * - With menu → inline keyboard via raw `sendMessage` if the thread
   *   exposes `adapter.telegramFetch`. Falls back to plain text on any
   *   error or missing handle.
   *
   * One `as any` cast: ChatThread is a transport-neutral interface, but
   * `@chat-adapter/telegram` decorates threads with `adapter.telegramFetch`
   * and `platformThreadId` at runtime. We narrow at the boundary instead
   * of polluting ChatThread with Telegram-only fields.
   */
  async postRich(thread: ChatThread, response: RichResponse): Promise<void> {
    if (!response.menu) {
      await this.postMessage(thread, response.text);
      return;
    }

    // Narrow at the transport boundary. See doc above.
    const telegramThread = thread as unknown as {
      id?: string;
      platformThreadId?: string;
      adapter?: { telegramFetch?: (method: string, payload: Record<string, unknown>) => Promise<unknown> };
    };
    const telegramFetch = telegramThread.adapter?.telegramFetch;
    const chatId = extractTelegramChatId(telegramThread);

    if (!telegramFetch || !chatId) {
      await this.postMessage(thread, response.text);
      return;
    }

    try {
      // text formatting: response.text is already markdown-ish from commands.
      // We pass it through markdownToTelegramHtml so bold/code render natively.
      const html = markdownToTelegramHtml(response.text);
      await telegramFetch("sendMessage", {
        chat_id: chatId,
        text: html,
        parse_mode: "HTML",
        reply_markup: toTelegramInlineKeyboard(response.menu),
      });
    } catch (err) {
      console.warn(
        "[roundhouse] telegram postRich failed, falling back to text:",
        (err as Error).message,
      );
      try {
        await this.postMessage(thread, response.text);
      } catch (fallbackErr) {
        console.error(
          "[roundhouse] telegram postRich text fallback also failed:",
          (fallbackErr as Error).message,
        );
      }
    }
  }

  async registerCommands(token: string): Promise<void> {
    if (!token) return;
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commands: BOT_COMMANDS }),
      });
      if (res.ok) {
        console.log(`[roundhouse] registered ${BOT_COMMANDS.length} bot commands with Telegram`);
      } else {
        const body = await res.text().catch(() => "");
        console.warn(`[roundhouse] failed to register bot commands (${res.status}): ${body.slice(0, 200)}`);
      }
    } catch (err) {
      console.warn(`[roundhouse] bot command registration error:`, (err as Error).message);
    }
  }

  ownsThread(thread: ChatThread): boolean {
    return isTelegramThread(thread as any);
  }

  createThread(chatId: number): ChatThread {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const threadId = `telegram:${chatId}`;
    const telegramFetch = async (method: string, payload: Record<string, unknown>) => {
      if (!token) return null;
      const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, ...payload }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return null;
      const json = await res.json() as { result?: unknown };
      return json.result ?? null;
    };
    const thread: ChatThread = {
      id: threadId,
      adapter: { telegramFetch },
      post: async (content: string | { markdown: string }) => {
        const text = typeof content === "string" ? content : content.markdown;
        await postTelegramHtml(thread as any, text);
      },
      startTyping: async () => {},
    };
    return thread;
  }

  async notify(chatIds: number[], text: string): Promise<void> {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      console.warn("[roundhouse] TELEGRAM_BOT_TOKEN not set — skipping notification");
      return;
    }
    // Convert lightweight markdown to Telegram HTML
    const html = markdownToTelegramHtml(text);
    await sendTelegramToMany(chatIds, html, { parseMode: "HTML" });
  }

  async isPairingPending(): Promise<boolean> {
    const pending = await readPendingPairing();
    return pending?.status === "pending";
  }

  async handlePairing(thread: ChatThread, message: IncomingMessage): Promise<PairingResult | null> {
    const text = (message.text ?? "").trim();
    if (!text) return null;

    const pending = await readPendingPairing();
    if (!pending || pending.status !== "pending" || !isStartForNonce(text, pending.nonce)) {
      return null;
    }

    // Verify author is allowed
    const authorName = (message.author?.userName ?? message.author?.name ?? "").toLowerCase();
    const originalName = message.author?.userName ?? message.author?.name ?? "";
    const allowed = pending.allowedUsers.map(u => u.toLowerCase());
    if (!authorName || !allowed.includes(authorName)) {
      console.log(`[roundhouse] Pairing nonce from unauthorized user @${originalName}`);
      return null;
    }

    // Extract Telegram-specific IDs
    const msg = message as any;
    const chatId = typeof msg.chatId === "number"
      ? msg.chatId
      : typeof thread.id === "string" && thread.id.startsWith("telegram:")
        ? parseInt(thread.id.split(":")[1], 10)
        : undefined;

    const rawUserId = msg.author?.userId ?? msg.author?.id ?? msg.raw?.from?.id;
    const userId = typeof rawUserId === "number"
      ? rawUserId
      : typeof rawUserId === "string"
        ? parseInt(rawUserId, 10)
        : undefined;

    if (chatId == null || Number.isNaN(chatId) || userId == null || Number.isNaN(userId)) {
      console.error(`[roundhouse] Pairing nonce matched but could not extract IDs: chatId=${chatId} userId=${userId} (raw: msg.chatId=${message.chatId}, thread.id=${thread.id}, author.userId=${message.author?.userId}, author.id=${message.author?.id}, raw.from.id=${message.raw?.from?.id})`);
      await clearPendingPairing();
      await thread.post("⚠️ Pairing failed — could not capture your Telegram IDs. Run: roundhouse setup --telegram");
      return null;
    }

    // Mark pairing complete in transport state
    await completePendingPairing({ chatId, userId, username: originalName });

    return { threadId: chatId, userId, username: originalName };
  }
}

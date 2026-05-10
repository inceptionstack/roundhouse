/**
 * transports/telegram/telegram-adapter.ts — Telegram transport adapter
 *
 * Implements TransportAdapter for Telegram, composing existing
 * utility modules (format, html, progress, notify, bot-commands).
 */

import type { TransportAdapter, ChatThread, IncomingMessage, PairingResult } from "../types";
import { isTelegramThread, postTelegramHtml } from "./html";
import { sendTelegramToMany } from "./notify";
import { BOT_COMMANDS } from "./bot-commands";
import { readPendingPairing, completePendingPairing, clearPendingPairing, isStartForNonce } from "./pairing";

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

  async notify(chatIds: number[], text: string, options?: { parseMode?: string }): Promise<void> {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      console.warn("[roundhouse] TELEGRAM_BOT_TOKEN not set — skipping notification");
      return;
    }
    await sendTelegramToMany(chatIds, text, options);
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

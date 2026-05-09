/**
 * transports/telegram/adapter.ts — Telegram transport adapter
 *
 * Implements TransportAdapter for Telegram, composing existing
 * utility modules (format, html, progress, notify, bot-commands).
 */

import type { TransportAdapter, ChatThread } from "../types";
import { isTelegramThread, postTelegramHtml } from "./html";
import { sendTelegramToMany } from "./notify";
import { BOT_COMMANDS } from "./bot-commands";

const TELEGRAM_FORMAT_HINT = "[Format your final answer to be telegram-friendly.]";

export class TelegramAdapter implements TransportAdapter {
  readonly name = "telegram";

  enrichPrompt(text: string): string {
    return `${text}\n\n${TELEGRAM_FORMAT_HINT}`;
  }

  async postMessage(thread: ChatThread, text: string): Promise<void> {
    if (!isTelegramThread(thread as any)) {
      throw new Error("TelegramTransportAdapter.postMessage called with non-Telegram thread");
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

  async notify(chatIds: number[], text: string): Promise<void> {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      console.warn("[roundhouse] TELEGRAM_BOT_TOKEN not set — skipping notification");
      return;
    }
    await sendTelegramToMany(chatIds, text);
  }
}

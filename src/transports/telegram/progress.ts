/**
 * telegram-progress.ts — Editable progress messages for long-running operations
 */

import type { ChatThread, ProgressMessage as TransportProgressMessage } from "../types";

/** Parse Telegram chat_id and optional message_thread_id from a Chat SDK thread ID */
function parseTelegramThreadId(threadId: string): { chatId: string; messageThreadId?: number } {
  const parts = threadId.split(":");
  const chatId = parts[1];
  const topicPart = parts[2];
  const result: { chatId: string; messageThreadId?: number } = { chatId };
  if (topicPart) {
    const parsed = parseInt(topicPart, 10);
    if (Number.isFinite(parsed)) result.messageThreadId = parsed;
  }
  return result;
}

export interface ProgressMessage extends TransportProgressMessage {
  /** Update the message text (edits in place) */
  update(text: string): Promise<void>;
}

/**
 * Send an initial message and return a handle to edit it in-place.
 * Falls back to no-op if the thread isn't Telegram or the send fails.
 *
 * Accepts a `ChatThread` (transport-neutral). Telegram-shaped threads
 * — those decorated by `@chat-adapter/telegram` with `adapter.telegramFetch`
 * and a `telegram:`-prefixed id — get edit-in-place. Anything else
 * falls back to a single `thread.post()` and no-op `update()`.
 */
export async function createProgressMessage(thread: ChatThread, initialText: string): Promise<ProgressMessage> {
  // Narrow at the transport boundary — same pattern as TelegramAdapter.postRich.
  const tg = thread as unknown as {
    id?: string;
    adapter?: { telegramFetch?: (m: string, p: Record<string, unknown>) => Promise<unknown> };
  };
  const isTelegram =
    typeof tg.adapter?.telegramFetch === "function" &&
    typeof tg.id === "string" &&
    tg.id.startsWith("telegram:");

  if (!isTelegram) {
    // Non-Telegram: just post once, updates are no-ops
    await thread.post(initialText);
    return { update: async () => {} };
  }

  const { chatId, messageThreadId } = parseTelegramThreadId(tg.id!);
  const basePayload = {
    chat_id: chatId,
    ...(messageThreadId !== undefined && { message_thread_id: messageThreadId }),
    disable_web_page_preview: true,
  };

  let messageId: number | null = null;
  let lastText = "";

  try {
    const result = await tg.adapter!.telegramFetch!("sendMessage", {
      ...basePayload,
      text: initialText,
    }) as { message_id?: number } | null | undefined;
    messageId = result?.message_id ?? null;
    lastText = initialText;
  } catch {
    // Fallback: use thread.post (can't edit later)
    await thread.post(initialText);
  }

  return {
    async update(text: string) {
      if (!messageId || text === lastText) return;
      try {
        await tg.adapter!.telegramFetch!("editMessageText", {
          ...basePayload,
          message_id: messageId,
          text,
        });
        lastText = text;
      } catch {
        // Edit failed (rate limit, message deleted, etc.) — skip silently
      }
    },
  };
}

/**
 * telegram-progress.ts — Editable progress messages for long-running operations
 */

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

export interface ProgressMessage {
  /** Update the message text (edits in place) */
  update(text: string): Promise<void>;
}

/**
 * Send an initial message and return a handle to edit it in-place.
 * Falls back to no-op if the thread isn't Telegram or the send fails.
 */
export async function createProgressMessage(thread: any, initialText: string): Promise<ProgressMessage> {
  const isTelegram =
    typeof thread?.adapter?.telegramFetch === "function" &&
    typeof thread?.id === "string" &&
    thread.id.startsWith("telegram:");

  if (!isTelegram) {
    // Non-Telegram: just post once, updates are no-ops
    await thread.post(initialText);
    return { update: async () => {} };
  }

  const { chatId, messageThreadId } = parseTelegramThreadId(thread.id);
  const basePayload = {
    chat_id: chatId,
    ...(messageThreadId !== undefined && { message_thread_id: messageThreadId }),
    disable_web_page_preview: true,
  };

  let messageId: number | null = null;
  let lastText = "";

  try {
    const result = await thread.adapter.telegramFetch("sendMessage", {
      ...basePayload,
      text: initialText,
    });
    messageId = result.message_id;
    lastText = initialText;
  } catch {
    // Fallback: use thread.post (can't edit later)
    await thread.post(initialText);
  }

  return {
    async update(text: string) {
      if (!messageId || text === lastText) return;
      try {
        await thread.adapter.telegramFetch("editMessageText", {
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

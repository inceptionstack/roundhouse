/**
 * telegram-html.ts — Direct Telegram HTML posting for rich agent responses
 *
 * Bypasses Chat SDK's legacy parse_mode:"Markdown" (v1) by calling the
 * Telegram Bot API directly with parse_mode:"HTML" for agent content.
 *
 * Chat SDK remains responsible for: incoming messages, subscriptions,
 * typing indicators, command handling, authorization, message history.
 */

import { markdownToTelegramHtml, truncateHtmlSafe } from "./telegram-format";
import { splitMessage } from "./util";

/** Max Telegram message length */
const TELEGRAM_LIMIT = 4096;

/** Streaming edit interval (ms) */
const STREAM_EDIT_INTERVAL_MS = 600;

/** Check if a Chat SDK thread is backed by the Telegram adapter */
export function isTelegramThread(thread: any): boolean {
  return (
    typeof thread?.adapter?.telegramFetch === "function" &&
    typeof thread?.id === "string" &&
    thread.id.startsWith("telegram:")
  );
}

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

/** Common payload fields for Telegram API calls */
function basePayload(chatId: string, messageThreadId?: number) {
  return {
    chat_id: chatId,
    ...(messageThreadId !== undefined && { message_thread_id: messageThreadId }),
    disable_web_page_preview: true,
  };
}

/** Send one HTML message, falling back to plain text on parse error */
async function sendHtmlOrPlain(
  adapter: any,
  chatId: string,
  messageThreadId: number | undefined,
  html: string,
  plainFallback: string,
): Promise<void> {
  try {
    await adapter.telegramFetch("sendMessage", {
      ...basePayload(chatId, messageThreadId),
      text: html,
      parse_mode: "HTML",
    });
  } catch {
    try {
      await adapter.telegramFetch("sendMessage", {
        ...basePayload(chatId, messageThreadId),
        text: plainFallback,
      });
    } catch (err) {
      console.error(`[roundhouse] Telegram sendMessage failed:`, (err as Error).message);
    }
  }
}

/**
 * Post markdown as Telegram HTML, with chunking and fallback.
 * Splits markdown into chunks before conversion so each chunk's HTML stays within limits.
 */
export async function postTelegramHtml(thread: any, markdown: string): Promise<void> {
  const { chatId, messageThreadId } = parseTelegramThreadId(thread.id);

  // Split before conversion — HTML expansion is usually modest
  for (const chunk of splitMessage(markdown, 3800)) {
    const html = markdownToTelegramHtml(chunk);
    const safeHtml = truncateHtmlSafe(html, TELEGRAM_LIMIT);
    await sendHtmlOrPlain(thread.adapter, chatId, messageThreadId, safeHtml, chunk);
  }
}

/**
 * Stream agent text as Telegram HTML using sendMessage + editMessageText.
 *
 * For responses under 4096 chars: single message with progressive edits.
 * For longer responses: finalize current message and start new ones via postTelegramHtml.
 */
export async function handleTelegramHtmlStream(
  thread: any,
  stream: AsyncIterable<string>,
): Promise<void> {
  const { chatId, messageThreadId } = parseTelegramThreadId(thread.id);

  let accumulated = "";
  let messageId: number | null = null;
  let lastEditContent = "";
  let lastEditTime = 0;
  /** Content already committed to sent messages (for overflow handling) */
  let committedLength = 0;

  const sendInitial = async (html: string): Promise<number> => {
    const result = await thread.adapter.telegramFetch("sendMessage", {
      ...basePayload(chatId, messageThreadId),
      text: html,
      parse_mode: "HTML",
    });
    return result.message_id;
  };

  const editMessage = async (html: string): Promise<boolean> => {
    if (!messageId || html === lastEditContent) return true;
    try {
      await thread.adapter.telegramFetch("editMessageText", {
        ...basePayload(chatId, messageThreadId),
        message_id: messageId,
        text: html,
        parse_mode: "HTML",
      });
      lastEditContent = html;
      lastEditTime = Date.now();
      return true;
    } catch {
      // Telegram may reject if content hasn't changed or HTML is temporarily invalid
      return false;
    }
  };

  /** Get the current uncommitted portion of accumulated text */
  const currentText = () => accumulated.slice(committedLength);

  const renderCurrent = (): string => {
    return markdownToTelegramHtml(currentText());
  };

  /**
   * Check if current content exceeds the Telegram limit.
   * If so, finalize the current message and start overflow handling.
   */
  const handleOverflow = async (): Promise<void> => {
    const html = renderCurrent();
    if (html.length <= TELEGRAM_LIMIT) return;

    // Finalize current streaming message with tag-safe truncation
    if (messageId) {
      const truncated = truncateHtmlSafe(html, TELEGRAM_LIMIT);
      await editMessage(truncated);
      // Estimate how many source chars were consumed using the expansion ratio
      const sourceLen = currentText().length;
      const ratio = sourceLen > 0 ? html.length / sourceLen : 1;
      const consumed = Math.min(sourceLen, Math.floor((TELEGRAM_LIMIT - 10) / Math.max(ratio, 1)));
      committedLength += consumed;
      messageId = null;
      lastEditContent = "";
    }
  };

  for await (const chunk of stream) {
    accumulated += chunk;

    if (!messageId) {
      // First chunk (or after overflow) — send initial message
      const html = renderCurrent();
      if (html.trim()) {
        const safeHtml = truncateHtmlSafe(html, TELEGRAM_LIMIT);
        try {
          messageId = await sendInitial(safeHtml);
          lastEditContent = safeHtml;
          lastEditTime = Date.now();
        } catch {
          try {
            const result = await thread.adapter.telegramFetch("sendMessage", {
              ...basePayload(chatId, messageThreadId),
              text: currentText(),
            });
            messageId = result.message_id;
            lastEditContent = currentText();
            lastEditTime = Date.now();
          } catch (err) {
            console.error(`[roundhouse] Telegram stream initial send failed:`, (err as Error).message);
          }
        }
      }
      continue;
    }

    // Check for overflow before editing
    await handleOverflow();

    // Throttled edit (only if we still have an active message)
    if (messageId) {
      const now = Date.now();
      if (now - lastEditTime >= STREAM_EDIT_INTERVAL_MS) {
        const html = renderCurrent();
        const safeHtml = truncateHtmlSafe(html, TELEGRAM_LIMIT);
        await editMessage(safeHtml);
      }
    }
  }

  // Final: handle any remaining content
  const remaining = currentText();
  if (!remaining.trim()) return;

  if (messageId) {
    // Try final edit
    const finalHtml = renderCurrent();
    if (finalHtml.length <= TELEGRAM_LIMIT) {
      const ok = await editMessage(finalHtml);
      if (!ok) {
        // Fallback to plain text edit
        try {
          await thread.adapter.telegramFetch("editMessageText", {
            ...basePayload(chatId, messageThreadId),
            message_id: messageId,
            text: remaining,
          });
        } catch { /* at least some content was sent */ }
      }
    } else {
      // Content exceeds limit — finalize current message and post remainder
      const truncated = truncateHtmlSafe(finalHtml, TELEGRAM_LIMIT);
      await editMessage(truncated);
      // Estimate consumed source chars using expansion ratio
      const remLen = remaining.length;
      const ratio = remLen > 0 ? finalHtml.length / remLen : 1;
      const overflowStart = Math.min(remLen, Math.floor((TELEGRAM_LIMIT - 10) / Math.max(ratio, 1)));
      const overflow = remaining.slice(overflowStart);
      if (overflow.trim()) {
        await postTelegramHtml(thread, overflow);
      }
    }
  } else {
    // No active message — post everything remaining
    await postTelegramHtml(thread, remaining);
  }
}

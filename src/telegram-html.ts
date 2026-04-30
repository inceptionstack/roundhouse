/**
 * telegram-html.ts — Direct Telegram HTML posting for rich agent responses
 *
 * Bypasses Chat SDK's legacy parse_mode:"Markdown" (v1) by calling the
 * Telegram Bot API directly with parse_mode:"HTML" for agent content.
 *
 * Chat SDK remains responsible for: incoming messages, subscriptions,
 * typing indicators, command handling, authorization, message history.
 */

import { markdownToTelegramHtml } from "./telegram-format";
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

/**
 * Post markdown as Telegram HTML, with chunking and fallback.
 * Falls back to plain text if HTML parse fails.
 */
export async function postTelegramHtml(thread: any, markdown: string): Promise<void> {
  const { chatId, messageThreadId } = parseTelegramThreadId(thread.id);

  // Split before conversion — HTML may be slightly larger than source markdown
  for (const chunk of splitMessage(markdown, 3800)) {
    const html = markdownToTelegramHtml(chunk);

    // Ensure we don't exceed Telegram's limit after HTML conversion
    const safeHtml = html.length <= TELEGRAM_LIMIT ? html : html.slice(0, TELEGRAM_LIMIT - 3) + "...";

    try {
      await thread.adapter.telegramFetch("sendMessage", {
        chat_id: chatId,
        ...(messageThreadId !== undefined && { message_thread_id: messageThreadId }),
        text: safeHtml,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
    } catch {
      // Fallback: try plain text if HTML parsing failed
      try {
        await thread.adapter.telegramFetch("sendMessage", {
          chat_id: chatId,
          ...(messageThreadId !== undefined && { message_thread_id: messageThreadId }),
          text: chunk,
        });
      } catch (err) {
        console.error(`[roundhouse] Telegram sendMessage failed:`, (err as Error).message);
      }
    }
  }
}

/**
 * Stream agent text as Telegram HTML using sendMessage + editMessageText.
 *
 * Pattern: send placeholder on first chunk, accumulate text, convert to HTML,
 * edit at intervals, final edit on completion.
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

  const sendInitial = async (html: string): Promise<number> => {
    const result = await thread.adapter.telegramFetch("sendMessage", {
      chat_id: chatId,
      ...(messageThreadId !== undefined && { message_thread_id: messageThreadId }),
      text: html,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    return result.message_id;
  };

  const editMessage = async (html: string): Promise<void> => {
    if (!messageId || html === lastEditContent) return;
    try {
      await thread.adapter.telegramFetch("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: html,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      lastEditContent = html;
      lastEditTime = Date.now();
    } catch {
      // Telegram may reject if content hasn't changed or HTML is temporarily invalid
      // during streaming — silently skip, final edit will fix it
    }
  };

  const renderCurrent = (): string => {
    const html = markdownToTelegramHtml(accumulated);
    return html.length <= TELEGRAM_LIMIT ? html : html.slice(0, TELEGRAM_LIMIT - 3) + "...";
  };

  for await (const chunk of stream) {
    accumulated += chunk;

    if (!messageId) {
      // First chunk — send initial message
      const html = renderCurrent();
      if (html.trim()) {
        try {
          messageId = await sendInitial(html);
          lastEditContent = html;
          lastEditTime = Date.now();
        } catch {
          // If HTML send fails, try plain text
          try {
            const result = await thread.adapter.telegramFetch("sendMessage", {
              chat_id: chatId,
              ...(messageThreadId !== undefined && { message_thread_id: messageThreadId }),
              text: accumulated,
            });
            messageId = result.message_id;
            lastEditContent = accumulated;
            lastEditTime = Date.now();
          } catch (err) {
            console.error(`[roundhouse] Telegram stream initial send failed:`, (err as Error).message);
          }
        }
      }
      continue;
    }

    // Throttled edit
    const now = Date.now();
    if (now - lastEditTime >= STREAM_EDIT_INTERVAL_MS) {
      await editMessage(renderCurrent());
    }
  }

  // Final edit with complete content
  if (messageId) {
    const finalHtml = renderCurrent();
    if (finalHtml !== lastEditContent) {
      await editMessage(finalHtml);
    }
    // If HTML edit failed silently, try plain text fallback for final
    if (lastEditContent !== renderCurrent()) {
      try {
        await thread.adapter.telegramFetch("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          text: accumulated,
        });
      } catch {
        // Give up — at least some content was sent
      }
    }
  } else if (accumulated.trim()) {
    // Never sent anything — post the whole thing
    await postTelegramHtml(thread, accumulated);
  }
}

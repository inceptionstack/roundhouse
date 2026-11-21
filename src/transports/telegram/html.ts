/**
 * telegram-html.ts — Direct Telegram HTML posting for rich agent responses
 *
 * Bypasses Chat SDK's legacy parse_mode:"Markdown" (v1) by calling the
 * Telegram Bot API directly with parse_mode:"HTML" for agent content.
 *
 * Chat SDK remains responsible for: incoming messages, subscriptions,
 * typing indicators, command handling, authorization, message history.
 *
 * Two rules hold for everything sent from here:
 *   - Nothing is truncated. A text too long for one message is split in its
 *     markdown source, so that each piece renders within Telegram's limit.
 *   - A rate limit (HTTP 429) is waited out, not ignored.
 */

import {
  TELEGRAM_MESSAGE_LIMIT,
  markdownToTelegramHtml,
  resumeMarkdownAt,
  splitMarkdownForTelegram,
  takeMarkdownChunk,
  type TakenChunk,
} from "./format";

/**
 * Shortest time between two updates of a streaming message in a private
 * chat (ms). The Chat SDK's Telegram adapter uses the same floor; editing
 * faster earns a 429.
 */
export const STREAM_EDIT_INTERVAL_MS = 1100;

/**
 * The same for groups and channels, where Telegram allows a bot about 20
 * messages a minute. Also the Chat SDK's floor.
 */
export const STREAM_EDIT_INTERVAL_GROUP_MS = 3100;

/** Longest time spent waiting out rate limits for one call that must get through (ms) */
export const MAX_RATE_LIMIT_WAIT_MS = 30_000;

/** Tries for one call that must get through */
const MAX_DELIVERY_ATTEMPTS = 4;

/** Wait used when Telegram reports a rate limit without a retry-after (ms) */
const DEFAULT_RETRY_AFTER_MS = 1000;

/** The clock and the sleep used for pacing. Tests replace them. */
export interface TelegramDeliveryOptions {
  /** Current time in ms. Defaults to `Date.now`. */
  now?: () => number;
  /** Wait for `ms`. Defaults to a timer. */
  sleep?: (ms: number) => Promise<void>;
}

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

/**
 * How long Telegram asked us to wait, in ms, or null if `err` is not a rate
 * limit. The adapter throws `AdapterRateLimitError` with `retryAfter` in
 * seconds; that class lives in a package we do not depend on, so it is
 * recognised by shape.
 */
export function rateLimitDelayMs(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const { retryAfter, name } = err as { retryAfter?: unknown; name?: unknown };
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) {
    return retryAfter > 0 ? retryAfter * 1000 : DEFAULT_RETRY_AFTER_MS;
  }
  return name === "AdapterRateLimitError" ? DEFAULT_RETRY_AFTER_MS : null;
}

/** Telegram refuses an edit that would not change the message. The message is as wanted. */
function isNotModified(err: unknown): boolean {
  return /message is not modified/i.test(String((err as Error | undefined)?.message ?? ""));
}

/** Remembers when Telegram will accept calls again, and waits for it */
class RateLimiter {
  readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Time before which Telegram asked for no more calls */
  private blockedUntil = 0;

  constructor(options: TelegramDeliveryOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Record a rate limit. Returns false if `err` is some other error. */
  note(err: unknown): boolean {
    const delay = rateLimitDelayMs(err);
    if (delay === null) return false;
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + delay);
    return true;
  }

  blocked(): boolean {
    return this.now() < this.blockedUntil;
  }

  /**
   * Make a call that must get through. Waits until Telegram accepts calls
   * again, and after a rate limit waits and tries again, for at most
   * `MAX_RATE_LIMIT_WAIT_MS` in total. Throws the last error after that, and
   * any error that is not a rate limit at once.
   */
  async deliver<T>(call: () => Promise<T>): Promise<T> {
    let budget = MAX_RATE_LIMIT_WAIT_MS;
    for (let attempt = 1; ; attempt++) {
      const wait = Math.min(this.blockedUntil - this.now(), budget);
      if (wait > 0) {
        await this.sleep(wait);
        budget -= wait;
      }
      try {
        const result = await call();
        this.blockedUntil = 0;
        return result;
      } catch (err) {
        if (!this.note(err) || budget <= 0 || attempt >= MAX_DELIVERY_ATTEMPTS) throw err;
      }
    }
  }
}

/**
 * Send one HTML message, falling back to plain text on parse error.
 * A rate limit is waited out (see `RateLimiter.deliver`).
 */
async function sendHtmlOrPlain(
  limiter: RateLimiter,
  adapter: any,
  chatId: string,
  messageThreadId: number | undefined,
  html: string,
  plainFallback: string,
): Promise<void> {
  const send = (text: string, parseMode?: "HTML") =>
    limiter.deliver(() =>
      adapter.telegramFetch("sendMessage", {
        ...basePayload(chatId, messageThreadId),
        text,
        ...(parseMode && { parse_mode: parseMode }),
      }),
    );
  const giveUp = (err: unknown) =>
    console.error(
      `[roundhouse] Telegram sendMessage failed, ${plainFallback.length} characters not delivered:`,
      (err as Error).message,
    );
  try {
    await send(html, "HTML");
    return;
  } catch (err) {
    // Still rate limited after waiting: plain text would be refused as well.
    if (rateLimitDelayMs(err) !== null) return giveUp(err);
  }
  try {
    await send(plainFallback);
  } catch (err) {
    giveUp(err);
  }
}

/**
 * Post markdown as Telegram HTML, with chunking and fallback.
 * The markdown is split so that each chunk's HTML fits one message; a code
 * block that spans chunks is closed and reopened, so it stays a code block.
 */
export async function postTelegramHtml(
  thread: any,
  markdown: string,
  options: TelegramDeliveryOptions = {},
): Promise<void> {
  const { chatId, messageThreadId } = parseTelegramThreadId(thread.id);
  const limiter = new RateLimiter(options);
  await postChunks(limiter, thread.adapter, chatId, messageThreadId, markdown, "");
}

/** Post `markdown` as one message per chunk. `prefix` is as in `takeMarkdownChunk`. */
async function postChunks(
  limiter: RateLimiter,
  adapter: any,
  chatId: string,
  messageThreadId: number | undefined,
  markdown: string,
  prefix: string,
): Promise<void> {
  for (const chunk of splitMarkdownForTelegram(markdown, TELEGRAM_MESSAGE_LIMIT, prefix)) {
    // Telegram refuses a message with nothing to show.
    if (!markdown.slice(chunk.start, chunk.end).trim()) continue;
    await sendHtmlOrPlain(limiter, adapter, chatId, messageThreadId, chunk.html, chunk.text);
  }
}

/**
 * Stream agent text as Telegram HTML using sendMessage + editMessageText.
 *
 * The text grows in one message ("bubble") that is edited as it arrives, at
 * most once per `STREAM_EDIT_INTERVAL_MS` (`STREAM_EDIT_INTERVAL_GROUP_MS`
 * in a group). When it no longer fits one
 * message, the bubble is closed at the last line break that fits and the
 * text after it starts the next bubble, so the bubbles together hold the
 * whole text and each starts on a new line.
 *
 * An update in the middle of the stream may be skipped or refused; the next
 * one makes up for it. The last update of a bubble may not: after a rate
 * limit it is tried again once Telegram allows, and if the bubble still
 * cannot be edited, the text it does not show is posted as a new message.
 */
export async function handleTelegramHtmlStream(
  thread: any,
  stream: AsyncIterable<string>,
  options: TelegramDeliveryOptions = {},
): Promise<void> {
  const { chatId, messageThreadId } = parseTelegramThreadId(thread.id);
  const limiter = new RateLimiter(options);
  const base = basePayload(chatId, messageThreadId);
  // Groups and channels have negative chat ids.
  const editInterval = chatId.startsWith("-") ? STREAM_EDIT_INTERVAL_GROUP_MS : STREAM_EDIT_INTERVAL_MS;

  let accumulated = "";
  /** Source offset up to which the text is in closed bubbles */
  let committed = 0;
  /** What the open bubble continues from: see `takeMarkdownChunk` */
  let prefix = "";
  /** The open bubble's message, once Telegram has accepted one */
  let messageId: number | null = null;
  /** The text Telegram last accepted for the open bubble */
  let shown = "";
  /** Source offset up to which the open bubble shows the text */
  let shownEnd = 0;
  /** When Telegram was last called for the open bubble, whether or not it worked */
  let lastAttemptAt = Number.NEGATIVE_INFINITY;

  /** The source of the open bubble */
  const body = () => accumulated.slice(committed);

  const send = async (text: string, html: boolean): Promise<number> => {
    const result = await thread.adapter.telegramFetch("sendMessage", {
      ...base,
      text,
      ...(html && { parse_mode: "HTML" }),
    });
    return result.message_id;
  };

  const edit = (text: string, html: boolean): Promise<unknown> =>
    thread.adapter.telegramFetch("editMessageText", {
      ...base,
      message_id: messageId,
      text,
      ...(html && { parse_mode: "HTML" }),
    });

  /** The open bubble as HTML, or null when it has outgrown one message */
  const renderOpen = (): string | null => {
    const text = prefix + body();
    if (text.length > TELEGRAM_MESSAGE_LIMIT) return null;
    const html = markdownToTelegramHtml(text);
    return html.length > TELEGRAM_MESSAGE_LIMIT ? null : html;
  };

  /** Show the open bubble's current text, if it is time for an update */
  const updateBubble = async (html: string): Promise<void> => {
    if (!body().trim() || !html.trim()) return;
    if (messageId !== null && html === shown) return;
    if (limiter.blocked() || limiter.now() - lastAttemptAt < editInterval) return;
    try {
      if (messageId === null) messageId = await send(html, true);
      else await edit(html, true);
      shown = html;
      shownEnd = accumulated.length;
    } catch (err) {
      // After a rate limit the next update waits for Telegram. A refused edit
      // is left to the next update too: the HTML of a half-written answer can
      // be invalid, and Telegram refuses an edit that changes nothing.
      if (!limiter.note(err) && messageId === null) {
        // Telegram refused the HTML: open the bubble with the markdown source.
        const plain = prefix + body();
        try {
          messageId = await send(plain, false);
          shown = plain;
          shownEnd = accumulated.length;
        } catch (plainErr) {
          if (!limiter.note(plainErr)) {
            console.error(`[roundhouse] Telegram stream initial send failed:`, (plainErr as Error).message);
          }
        }
      }
    } finally {
      lastAttemptAt = limiter.now();
    }
  };

  /** Make the open bubble show `html`. Returns false if Telegram would not take it. */
  const finalEdit = async (html: string, plain: string): Promise<boolean> => {
    try {
      await limiter.deliver(() => edit(html, true));
      return true;
    } catch (err) {
      if (isNotModified(err)) return true;
      if (rateLimitDelayMs(err) !== null) return false;
    }
    // Telegram refused the HTML: show the markdown source instead.
    try {
      await limiter.deliver(() => edit(plain, false));
      return true;
    } catch (err) {
      return isNotModified(err);
    }
  };

  /**
   * Close the open bubble with `chunk` as its final content, and start the
   * next one after it. This is the update that has to arrive.
   */
  const closeBubble = async (chunk: TakenChunk): Promise<void> => {
    let end = committed + chunk.length;
    let nextPrefix = chunk.nextPrefix;
    const source = accumulated.slice(committed, end);
    if (messageId === null) {
      // Nothing of this bubble is on screen yet: post it whole.
      if (source.trim()) {
        await sendHtmlOrPlain(limiter, thread.adapter, chatId, messageThreadId, chunk.html, chunk.text);
        lastAttemptAt = limiter.now();
      }
    } else if (chunk.html !== shown) {
      if (!(await finalEdit(chunk.html, chunk.text))) {
        // The bubble is stuck showing the text up to `shownEnd`.
        const shownLength = shownEnd - committed;
        if (shownLength < chunk.length) {
          // Post the part of the chunk it does not show.
          const resume = resumeMarkdownAt(prefix, source, shownLength);
          const rest = source.slice(resume.offset);
          if (rest.trim()) {
            await postChunks(limiter, thread.adapter, chatId, messageThreadId, rest, resume.prefix);
          }
        } else {
          // It shows more than the chunk: the start of a line that belongs
          // to the next bubble. Let the next bubble continue after it.
          const resume = resumeMarkdownAt(prefix, body(), shownLength);
          end = committed + resume.offset;
          nextPrefix = resume.prefix;
        }
      }
      lastAttemptAt = limiter.now();
    }
    committed = end;
    prefix = nextPrefix;
    messageId = null;
    shown = "";
    shownEnd = end;
  };

  for await (const piece of stream) {
    accumulated += piece;
    let html = renderOpen();
    while (html === null) {
      await closeBubble(takeMarkdownChunk(prefix, body()));
      html = renderOpen();
    }
    await updateBubble(html);
  }

  // Final: whatever the open bubble holds. It fits one message, unless
  // closing a code block that is still open pushes it over.
  while (body().trim()) {
    await closeBubble(takeMarkdownChunk(prefix, body()));
  }
}

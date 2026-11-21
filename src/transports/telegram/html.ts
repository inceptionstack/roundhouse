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
 *   - A rate limit (HTTP 429) is waited out, not ignored, for up to
 *     `MAX_RATE_LIMIT_WAIT_MS` per answer. Telegram is never called inside a
 *     wait it asked for.
 */

import {
  TELEGRAM_MESSAGE_LIMIT,
  hasVisibleText,
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

/**
 * Longest time one answer (one post, or one stream) spends waiting out rate
 * limits (ms). A wait that does not fit in what is left is not started: the
 * text is reported as not delivered instead.
 */
export const MAX_RATE_LIMIT_WAIT_MS = 90_000;

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

/** A new message, or an edit of a message already sent */
type CallKind = "send" | "edit";

/**
 * Per adapter and chat: the time before which Telegram refuses new messages.
 * Kept across answers, so the next answer to the same chat knows about a wait
 * that is still running.
 */
const sendBlocks = new WeakMap<object, Map<string, number>>();

/**
 * Remembers when Telegram will accept calls again, and waits for it.
 *
 * Two waits are kept apart. A refused `sendMessage` blocks the chat: nothing
 * goes out until it is over. A refused `editMessageText` blocks edits only:
 * Telegram limits edits of one message more tightly than new messages, so a
 * new message is still tried, and is refused with its own wait if the limit
 * turns out to cover it.
 */
class RateLimiter {
  readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly sends: Map<string, number>;
  /** Time before which Telegram asked for no more edits (this answer only) */
  private editBlockedUntil = 0;
  /** What is left of `MAX_RATE_LIMIT_WAIT_MS` for this answer */
  private budget = MAX_RATE_LIMIT_WAIT_MS;

  constructor(options: TelegramDeliveryOptions, adapter: object, private readonly chatId: string) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    let sends = sendBlocks.get(adapter);
    if (!sends) sendBlocks.set(adapter, (sends = new Map()));
    this.sends = sends;
  }

  /** The time from which Telegram accepts a call of this kind again */
  until(kind: CallKind): number {
    const send = this.sends.get(this.chatId) ?? 0;
    return kind === "send" ? send : Math.max(send, this.editBlockedUntil);
  }

  blocked(kind: CallKind): boolean {
    return this.now() < this.until(kind);
  }

  /** Record a rate limit. Returns false if `err` is some other error. */
  note(kind: CallKind, err: unknown): boolean {
    const delay = rateLimitDelayMs(err);
    if (delay === null) return false;
    const until = this.now() + delay;
    if (kind === "send") this.sends.set(this.chatId, Math.max(this.until("send"), until));
    else this.editBlockedUntil = Math.max(this.editBlockedUntil, until);
    return true;
  }

  private accepted(kind: CallKind): void {
    if (kind === "send") this.sends.delete(this.chatId);
    else this.editBlockedUntil = 0;
  }

  /** Wait until `time`. Pacing, not a rate limit: it does not use the budget. */
  async pace(time: number): Promise<void> {
    const wait = time - this.now();
    if (wait > 0) await this.sleep(wait);
  }

  /**
   * Make a call that must get through. Waits until Telegram accepts calls of
   * this kind, and after a rate limit waits as long as Telegram said and tries
   * again. Telegram is never called inside a wait: such a call is refused
   * again and can lengthen the wait.
   *
   * Throws a rate limit error, without calling, when the wait is longer than
   * what is left of this answer's budget. Any other error is thrown at once.
   */
  async deliver<T>(kind: CallKind, call: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const wait = this.until(kind) - this.now();
      if (wait > this.budget) throw stillRateLimited(wait);
      if (wait > 0) {
        await this.sleep(wait);
        this.budget -= wait;
      }
      try {
        const result = await call();
        this.accepted(kind);
        return result;
      } catch (err) {
        if (!this.note(kind, err) || attempt >= MAX_DELIVERY_ATTEMPTS) throw err;
      }
    }
  }
}

/** The error for a call that was not made because Telegram's wait is longer than the budget */
function stillRateLimited(waitMs: number): Error {
  const seconds = Math.ceil(waitMs / 1000);
  return Object.assign(new Error(`Telegram asked for a wait of ${seconds} s`), { retryAfter: seconds });
}

/** Two texts Telegram shows the same way: it drops whitespace at the end of a message */
function sameText(a: string, b: string): boolean {
  return a === b || a.trimEnd() === b.trimEnd();
}

type SendOutcome = "sent" | "rate-limited" | "refused";

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
): Promise<SendOutcome> {
  const send = (text: string, parseMode?: "HTML") =>
    limiter.deliver("send", () =>
      adapter.telegramFetch("sendMessage", {
        ...basePayload(chatId, messageThreadId),
        text,
        ...(parseMode && { parse_mode: parseMode }),
      }),
    );
  try {
    await send(html, "HTML");
    return "sent";
  } catch (err) {
    // Plain text would be refused as well.
    if (rateLimitDelayMs(err) !== null) return "rate-limited";
  }
  try {
    await send(plainFallback);
    return "sent";
  } catch (err) {
    if (rateLimitDelayMs(err) !== null) return "rate-limited";
    console.error(
      `[roundhouse] Telegram sendMessage failed, ${plainFallback.length} characters not delivered:`,
      (err as Error).message,
    );
    return "refused";
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
  const limiter = new RateLimiter(options, thread.adapter, chatId);
  await postChunks(limiter, thread.adapter, chatId, messageThreadId, markdown, "");
}

/**
 * Post `markdown` as one message per chunk. `prefix` is as in `takeMarkdownChunk`.
 *
 * Stops at the first chunk a rate limit keeps back: the chunks after it would
 * arrive without it. What was not sent is logged once.
 */
async function postChunks(
  limiter: RateLimiter,
  adapter: any,
  chatId: string,
  messageThreadId: number | undefined,
  markdown: string,
  prefix: string,
): Promise<void> {
  const chunks = splitMarkdownForTelegram(markdown, TELEGRAM_MESSAGE_LIMIT, prefix);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    // Telegram refuses a message with nothing to show.
    if (!hasVisibleText(chunk.html)) continue;
    const outcome = await sendHtmlOrPlain(limiter, adapter, chatId, messageThreadId, chunk.html, chunk.text);
    if (outcome === "rate-limited") {
      reportHeldBack(limiter, markdown.length - chunk.start);
      return;
    }
  }
}

/** Log text that a rate limit kept from being sent */
function reportHeldBack(limiter: RateLimiter, characters: number): void {
  const wait = Math.max(0, Math.ceil((limiter.until("send") - limiter.now()) / 1000));
  console.error(
    `[roundhouse] Telegram rate limit: ${characters} characters not delivered. ` +
      `Telegram asked for a wait of ${wait} s, more than is left of the ${MAX_RATE_LIMIT_WAIT_MS / 1000} s an answer waits.`,
  );
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
 * one makes up for it, and when the stream goes quiet (a tool is running) a
 * timer does, so text does not sit unsent until the next piece arrives. The
 * last update of a bubble may not be skipped: after a rate limit it is tried
 * again once Telegram allows, and if the bubble still cannot be edited, the
 * text it does not show is posted as a new message.
 *
 * If the stream itself fails, what has arrived is still delivered, and the
 * error is thrown afterwards.
 */
export async function handleTelegramHtmlStream(
  thread: any,
  stream: AsyncIterable<string>,
  options: TelegramDeliveryOptions = {},
): Promise<void> {
  const { chatId, messageThreadId } = parseTelegramThreadId(thread.id);
  const limiter = new RateLimiter(options, thread.adapter, chatId);
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
  /** The open bubble as last rendered */
  let latest = "";
  /** A text Telegram refused for the open bubble for another reason than a rate limit */
  let refused: string | null = null;

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

  /** The call that would update the open bubble now */
  const updateKind = (): CallKind => (messageId === null ? "send" : "edit");

  /** True if the open bubble has text that is not on screen and is worth trying */
  const updatePending = (): boolean =>
    hasVisibleText(latest) && latest !== refused && (messageId === null || !sameText(latest, shown));

  /** The earliest time an update of the open bubble may be tried */
  const updateDueAt = (): number => Math.max(lastAttemptAt + editInterval, limiter.until(updateKind()));

  /** Show the open bubble's current text, if it is time for an update */
  const updateBubble = async (html: string): Promise<void> => {
    latest = html;
    if (!updatePending() || limiter.now() < updateDueAt()) return;
    const kind = updateKind();
    try {
      if (messageId === null) messageId = await send(html, true);
      else await edit(html, true);
      shown = html;
      shownEnd = accumulated.length;
      refused = null;
    } catch (err) {
      // After a rate limit the next update waits for Telegram. A refused edit
      // is left to the next update too: the HTML of a half-written answer can
      // be invalid, and Telegram refuses an edit that changes nothing.
      if (limiter.note(kind, err)) return;
      refused = html;
      if (messageId === null) {
        // Telegram refused the HTML: open the bubble with the markdown source.
        const plain = prefix + body();
        try {
          messageId = await send(plain, false);
          shown = plain;
          shownEnd = accumulated.length;
        } catch (plainErr) {
          if (!limiter.note("send", plainErr)) {
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
    // Not sooner after the last update than any other edit.
    await limiter.pace(lastAttemptAt + editInterval);
    try {
      await limiter.deliver("edit", () => edit(html, true));
      return true;
    } catch (err) {
      if (isNotModified(err)) return true;
      if (rateLimitDelayMs(err) !== null) return false;
    }
    // Telegram refused the HTML: show the markdown source instead.
    try {
      await limiter.deliver("edit", () => edit(plain, false));
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
      if (hasVisibleText(chunk.html)) {
        const outcome = await sendHtmlOrPlain(limiter, thread.adapter, chatId, messageThreadId, chunk.html, chunk.text);
        if (outcome === "rate-limited") reportHeldBack(limiter, source.length);
        lastAttemptAt = limiter.now();
      }
    } else if (!sameText(chunk.html, shown)) {
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
    latest = "";
    refused = null;
  };

  // The pieces are read by hand so that a timer can run beside the wait for
  // the next one.
  const pieces = stream[Symbol.asyncIterator]();
  const TICK = Symbol("tick");
  let failed = false;
  let failure: unknown;
  try {
    /** The request for the next piece, while it is outstanding */
    let next: Promise<IteratorResult<string>> | null = null;
    for (;;) {
      // Ask for a piece only when the last one has been dealt with, as a
      // `for await` would.
      next ??= pieces.next();
      let result: IteratorResult<string> | typeof TICK;
      if (updatePending()) {
        // Text is waiting for its turn: wake up when it comes, piece or no piece.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const tick = new Promise<typeof TICK>((resolve) => {
          timer = setTimeout(() => resolve(TICK), Math.max(0, updateDueAt() - limiter.now()));
        });
        result = await Promise.race([next, tick]);
        clearTimeout(timer);
      } else {
        result = await next;
      }
      if (result === TICK) {
        await updateBubble(latest);
        continue;
      }
      next = null;
      if (result.done) break;
      accumulated += result.value;
      let html = renderOpen();
      while (html === null) {
        await closeBubble(takeMarkdownChunk(prefix, body()));
        html = renderOpen();
      }
      await updateBubble(html);
    }
  } catch (err) {
    failed = true;
    failure = err;
  }

  // Final: whatever the open bubble holds. It fits one message, unless
  // closing a code block that is still open pushes it over.
  while (body().trim()) {
    await closeBubble(takeMarkdownChunk(prefix, body()));
  }
  if (failed) throw failure;
}

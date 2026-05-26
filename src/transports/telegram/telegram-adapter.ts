/**
 * transports/telegram/telegram-adapter.ts — Telegram transport adapter
 *
 * Implements TransportAdapter for Telegram, composing existing
 * utility modules (format, html, progress, notify, bot-commands).
 */

import type {
  TransportAdapter,
  ChatThread,
  ChatThreadPost,
  IncomingMessage,
  PairingResult,
  RichResponse,
  ProgressMessage,
} from "../types";
import { isTelegramThread, postTelegramHtml, handleTelegramHtmlStream } from "./html";
import { markdownToTelegramHtml } from "./format";
import { sendTelegramToMany } from "./notify";
import { BOT_COMMANDS } from "./bot-commands";
import { readPendingPairing, completePendingPairing, clearPendingPairing, isStartForNonce } from "./pairing";
import { toTelegramInlineKeyboard } from "./rich-ui";
import { createProgressMessage } from "./progress";

/** Bot-command suffix sentinels we recognize as Telegram-specific to ignore. */
const TELEGRAM_START_PATTERN = /^\/start(\s|@|$)/i;

/** Extract the numeric Telegram chat id from a thread's id string. */
function extractTelegramChatId(thread: { id?: string; platformThreadId?: string }): string | undefined {
  return thread.platformThreadId?.split(":")?.[1] ?? thread.id?.split(":")?.[1];
}

const TELEGRAM_FORMAT_HINT = "[Format your final answer to be telegram-friendly.]";

export class TelegramAdapter implements TransportAdapter {
  readonly name = "telegram";

  enrichPrompt(_thread: ChatThread, text: string): string {
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
      // Text-only response: still go through a guarded post so the
      // never-throws contract holds even if postMessage rejects.
      await this.safePostText(thread, response.text);
      return;
    }

    // Narrow at the transport boundary. See doc above.
    const telegramThread = thread as unknown as {
      id?: string;
      platformThreadId?: string;
      adapter?: { telegramFetch?: (method: string, payload: Record<string, unknown>) => Promise<unknown> };
    };
    // CRITICAL: telegramFetch is a class method on the @chat-adapter/telegram
    // adapter — it relies on `this.apiBaseUrl` and `this.botToken`. Calling
    // it as a plain function (`const fn = adapter.telegramFetch; fn(...)`)
    // throws "Cannot read properties of undefined". Always invoke it as
    // `adapter.telegramFetch(...)` so `this` is preserved.
    const tgAdapter = telegramThread.adapter;
    const chatId = extractTelegramChatId(telegramThread);

    if (!tgAdapter?.telegramFetch || !chatId) {
      await this.safePostText(thread, response.text);
      return;
    }

    try {
      // text formatting: response.text is already markdown-ish from commands.
      // We pass it through markdownToTelegramHtml so bold/code render natively.
      // When menuCaption is provided, prefer it as the body next to the
      // keyboard — commands use this to avoid duplicating buttons in text.
      const body = response.menuCaption ?? response.text;
      const html = markdownToTelegramHtml(body);
      await tgAdapter.telegramFetch("sendMessage", {
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
      await this.safePostText(thread, response.text);
    }
  }

  /**
   * Post `text` via postMessage, swallowing any error so callers (chiefly
   * postRich) can satisfy their never-throws contract.
   *
   * Tier 1: try Telegram-native postMessage (HTML formatting, splitting).
   * Tier 2: fall back to thread.post(text) if available — this catches
   *         callback/invocation threads that lack `adapter.telegramFetch`
   *         or a `telegram:` id shape but still expose a generic post().
   * Tier 3: log + give up (degradation contract: never throw).
   */
  private async safePostText(thread: ChatThread, text: string): Promise<void> {
    try {
      await this.postMessage(thread, text);
      return;
    } catch (err) {
      console.warn(
        "[roundhouse] telegram safePostText: postMessage failed, trying thread.post:",
        (err as Error).message,
      );
    }
    // Tier 2: generic thread.post() if the thread exposes one.
    const genericPost = (thread as { post?: (t: string) => Promise<void> | void }).post;
    if (typeof genericPost === "function") {
      try {
        await genericPost.call(thread, text);
        return;
      } catch (err) {
        console.error(
          "[roundhouse] telegram safePostText: thread.post also failed:",
          (err as Error).message,
        );
      }
    } else {
      console.error(
        "[roundhouse] telegram safePostText: thread has no post() method; message dropped",
      );
    }
  }

  /**
   * Open an editable progress message. Delegates to the existing
   * `createProgressMessage` helper which already handles non-Telegram
   * threads by degrading to a single post + no-op updates.
   */
  progress(thread: ChatThread, initialText: string): Promise<ProgressMessage> {
    return createProgressMessage(thread, initialText);
  }

  async registerCommands(): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return;   // Adapter self-sources; no-op when token absent
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

  ownsChatId(id: string | number): boolean {
    if (typeof id === "number") return Number.isFinite(id);
    return typeof id === "string" && /^-?\d+$/.test(id);
  }

  encodeParentThreadId(chatId: string | number): string {
    return `telegram:${chatId}:main`;
  }

  formatNotifySession(chatId: string | number): string {
    // Telegram negative IDs identify groups; positive IDs identify direct chats.
    const n = typeof chatId === "number" ? chatId : Number(chatId);
    if (Number.isFinite(n) && n < 0) return `group:${chatId}`;
    return "main";
  }

  shouldIgnoreMessage(text: string): boolean {
    return TELEGRAM_START_PATTERN.test(text.trim());
  }

  createThread(chatId: string | number): ChatThread {
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
      post: async (content: ChatThreadPost) => {
        if (typeof content === "string") {
          await postTelegramHtml(thread as any, content);
          return;
        }
        if ("markdown" in content) {
          await postTelegramHtml(thread as any, content.markdown);
          return;
        }
        // `{ card }` path: the card-based menu rendering is a Phase 2 unification.
        // Until then, telegram synthetic threads only use markdown/text from
        // gateway internals (boot turn, cron, sub-agent injections), so falling
        // back to the card's fallbackText is sufficient.
        if ("card" in content) {
          const fallback = content.fallbackText ?? "(card)";
          await postTelegramHtml(thread as any, fallback);
        }
      },
      startTyping: async () => {},
    };
    return thread;
  }

  async notify(chatIds: (string | number)[], text: string): Promise<void> {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      console.warn("[roundhouse] TELEGRAM_BOT_TOKEN not set — skipping notification");
      return;
    }
    // Filter to telegram-shaped IDs only (composite already partitions, but
    // defend against direct callers passing a heterogeneous list).
    const tgIds = chatIds.filter(id => this.ownsChatId(id));
    if (tgIds.length === 0) return;
    // Convert lightweight markdown to Telegram HTML
    const html = markdownToTelegramHtml(text);
    await sendTelegramToMany(tgIds, html, { parseMode: "HTML" });
  }

  async stream(thread: ChatThread, iter: AsyncIterable<string>, _signal?: AbortSignal): Promise<void> {
    // The existing streaming helper does not yet thread an abort signal; the
    // gateway's stream loop already aborts at the agent layer when /cancel
    // fires, so chunks stop arriving. Wiring the signal end-to-end is a
    // small follow-up.
    await handleTelegramHtmlStream(thread as any, iter);
  }

  async isPairingPending(): Promise<boolean> {
    const pending = await readPendingPairing();
    return pending?.status === "pending";
  }

  async handlePairing(thread: ChatThread, message: IncomingMessage): Promise<PairingResult | null> {
    // Early guard: only process threads this adapter owns (defensive; Composite also filters)
    if (!this.ownsThread(thread)) return null;

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

    return { threadId: chatId, userId, username: originalName, transport: this.name };
  }
}

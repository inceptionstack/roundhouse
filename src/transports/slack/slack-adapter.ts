/**
 * transports/slack/slack-adapter.ts — Slack TransportAdapter
 *
 * Single workspace, socket mode (v1). Implements the same TransportAdapter
 * contract as TelegramAdapter so the gateway never branches on platform.
 *
 * Key facts the design relies on (all anchored to chat@4.29.0 /
 * @chat-adapter/slack@4.29.0 — see slack-plan.md "Verified-against-source claims"):
 *   - Slack thread ids are `slack:CHANNEL:THREAD_TS`.
 *   - AdapterPostableMessage is `string | { raw } | { markdown } | { ast } | { card } | CardElement`
 *     — there is no `blocks` field. Menus go through `{ card }`.
 *   - `bot.onAssistantThreadStarted(handler)` is the public registration
 *     for opening assistant DMs (lets us pair before the user types).
 *   - Single-workspace `webClient` works without an explicit context.
 *   - `postChannelMessage` posts at channel root, no thread_ts.
 */

import type { SlackAdapter as SlackSdkAdapter } from "@chat-adapter/slack";
import type {
  TransportAdapter,
  ChatThread,
  ChatThreadPost,
  IncomingMessage,
  PairingResult,
  RichResponse,
  ProgressMessage,
} from "../types";
import { richMenuToCard, stripMarkdownToPlain } from "../rich-helpers";
import {
  readPendingSlackPairing,
  completePendingSlackPairing,
  matchPendingPairing,
} from "./pairing";
import { isSlackChatId, SLACK_MARKDOWN_TEXT_LIMIT } from "./format";
import { postSlackToMany, postSlackMessage } from "./notify";
import { createSlackProgress } from "./progress";
import { handleSlackStream } from "./streaming";

const SLACK_FORMAT_HINT = "[Format your final answer for Slack: prefer concise plain text and standard markdown. Avoid Telegram-only HTML.]";

interface SlackThreadShape {
  id?: string;
  adapter?: { slack?: SlackSdkAdapter };
}

export class SlackAdapter implements TransportAdapter {
  readonly name = "slack";

  private slackSdk: SlackSdkAdapter | null = null;

  /**
   * Wire the @chat-adapter/slack instance after `chat.initialize()` has run.
   * Until then, methods that need the SDK fail with a clear error so a
   * misordered startup is loud, not silently broken.
   */
  attach(slackSdk: SlackSdkAdapter): void {
    this.slackSdk = slackSdk;
  }

  enrichPrompt(_thread: ChatThread, text: string): string {
    return `${text}\n\n${SLACK_FORMAT_HINT}`;
  }

  async postMessage(thread: ChatThread, text: string): Promise<void> {
    // Plain markdown_text — adapter handles the conversion.
    // Long messages are split here so we don't trip Slack's 12k cap.
    if (text.length <= SLACK_MARKDOWN_TEXT_LIMIT) {
      await thread.post({ markdown: text });
      return;
    }
    for (const chunk of splitForSlack(text)) {
      await thread.post({ markdown: chunk });
    }
  }

  /**
   * Render a RichResponse:
   *   - no menu → markdown post via thread.post.
   *   - with menu → `{ card }` payload. The Slack adapter's cardToBlockKit
   *     turns the Card into Block Kit blocks; markdown_text is unused
   *     (and would conflict with blocks anyway).
   */
  async postRich(thread: ChatThread, response: RichResponse): Promise<void> {
    if (!response.menu) {
      await this.safePostText(thread, response.text);
      return;
    }
    try {
      const body = response.menuCaption ?? response.text;
      const card = richMenuToCard(response.menu, body);
      await thread.post({ card, fallbackText: stripMarkdownToPlain(body) });
    } catch (err) {
      console.warn("[slack] postRich failed, falling back to text:", (err as Error).message);
      await this.safePostText(thread, response.text);
    }
  }

  progress(thread: ChatThread, initialText: string): Promise<ProgressMessage> {
    return createSlackProgress(this.requireSdk(), thread, initialText);
  }

  async stream(thread: ChatThread, iter: AsyncIterable<string>, signal?: AbortSignal): Promise<void> {
    return handleSlackStream(this.requireSdk(), thread, iter, signal);
  }

  async registerCommands(): Promise<void> {
    // Slack slash commands live in the app manifest, not at runtime.
  }

  ownsThread(thread: ChatThread): boolean {
    return typeof thread?.id === "string" && thread.id.startsWith("slack:");
  }

  ownsChatId(id: string | number): boolean {
    return isSlackChatId(id);
  }

  encodeParentThreadId(chatId: string | number): string {
    // "main" sentinel for top-level posts — postChannelMessage ignores threadTs.
    return `slack:${chatId}:main`;
  }

  formatNotifySession(chatId: string | number): string {
    const id = String(chatId);
    if (id.startsWith("D")) return "main";
    if (id.startsWith("C") || id.startsWith("G")) return `channel:${id}`;
    return "main";
  }

  createThread(chatId: string | number): ChatThread {
    const sdk = this.requireSdk();
    const channelId = String(chatId);
    // Slack's encodeThreadId requires a non-empty threadTs at the type
    // level; "" is the agreed sentinel for top-level posts. The SDK's
    // decodeThreadId round-trips it.
    const threadId = sdk.encodeThreadId({ channel: channelId, threadTs: "" });
    // postChannelMessage at runtime expects "slack:CHANNEL" (it splits on ":"
    // and grabs index [1]) — passing a bare channel id throws ValidationError.
    // The published .d.ts only documented the param as `channelId: string`,
    // not the required prefix. Anchor the format here.
    const sdkChannelId = `slack:${channelId}`;

    const thread: ChatThread = {
      id: threadId,
      adapter: { slack: sdk } as { slack: SlackSdkAdapter },
      post: async (content: ChatThreadPost) => {
        // postChannelMessage posts at the channel root (no thread_ts).
        // For replies inside an existing Slack thread we'd use
        // postMessage with a real threadId — gateway internals don't yet
        // need that path.
        if (typeof content === "string") {
          await sdk.postChannelMessage(sdkChannelId, { markdown: content });
          return;
        }
        if ("markdown" in content) {
          await sdk.postChannelMessage(sdkChannelId, { markdown: content.markdown });
          return;
        }
        if ("card" in content) {
          await sdk.postChannelMessage(sdkChannelId, {
            card: content.card as Parameters<SlackSdkAdapter["postChannelMessage"]>[1] extends infer M
              ? M extends { card: infer C } ? C : never
              : never,
            fallbackText: content.fallbackText,
          } as Parameters<SlackSdkAdapter["postChannelMessage"]>[1]);
        }
      },
      startTyping: async () => {
        // `startTyping(threadId)` without a status uses Slack's default
        // "Typing…" indicator and does NOT require the assistant:write
        // scope (per index.d.ts:823).
        try { await sdk.startTyping(threadId); } catch {}
      },
      // No `stopTyping` on synthetic threads: synthetic threads use a
      // channel-root threadTs ("") which the SDK's startTyping early-
      // returns from, so there's nothing to clear. The real stop-path
      // for incoming-message Slack threads is `stopTypingFor(thread)`,
      // attached at the gateway boundary.
    };
    return thread;
  }

  async notify(chatIds: (string | number)[], text: string): Promise<void> {
    // Filter to slack-shaped ids only (composite already partitions; this
    // is defensive for direct callers).
    const slackIds = chatIds.filter(isSlackChatId) as string[];
    if (slackIds.length === 0) return;

    // Prefer the SDK's webClient (auto-handles workspace token); fall back
    // to the env-token REST helper when no SDK is attached (e.g. CLI ops
    // outside the gateway).
    const sdk = this.slackSdk;
    if (sdk) {
      for (const id of slackIds) {
        try {
          await sdk.webClient.chat.postMessage({
            channel: id,
            markdown_text: text,
            unfurl_links: false,
            mrkdwn: true,
          });
        } catch (err) {
          console.warn(`[slack] notify(${id}) failed:`, (err as Error).message);
          // Best-effort fall-through to REST helper.
          const token = process.env.SLACK_BOT_TOKEN;
          if (token) await postSlackMessage(token, id, text);
        }
      }
      return;
    }
    await postSlackToMany(slackIds, text);
  }

  /**
   * Build a transport-specific `stopTyping` callback for an incoming Slack
   * thread, suitable for attaching to the `startTypingLoop` cleanup path.
   *
   * Why we need a custom one: `@chat-adapter/slack@4.29.0` `startTyping`
   * unconditionally forwards `loading_messages: [status ?? "Typing..."]`
   * to `assistant.threads.setStatus`. With `status === ""` (the documented
   * "clear" value), the array becomes `[""]` which Slack rejects with
   * `loading_messages/0 must be more than 0 characters`. Per
   * https://docs.slack.dev/reference/methods/assistant.threads.setStatus
   * `loading_messages` is optional, so we call the API directly without
   * it. Returns null when the thread isn't a Slack thread (composite
   * routing fallback) so the typing-loop can use its default path.
   */
  stopTypingFor(thread: ChatThread): (() => Promise<void>) | null {
    if (!this.ownsThread(thread)) return null;
    const sdk = this.slackSdk;
    if (!sdk) return null;
    const threadId = (thread as unknown as SlackThreadShape).id;
    if (!threadId) return null;
    let channel: string;
    let threadTs: string;
    try {
      const decoded = sdk.decodeThreadId(threadId);
      channel = decoded.channel;
      threadTs = decoded.threadTs;
    } catch {
      return null;
    }
    if (!threadTs || threadTs === "" || threadTs === "main") {
      // Synthetic thread (channel root). The SDK's startTyping early-
      // returns when threadTs is empty, so nothing to clear.
      return null;
    }
    return async () => {
      try {
        await sdk.webClient.assistant.threads.setStatus({
          channel_id: channel,
          thread_ts: threadTs,
          status: "",
          // NB: deliberately NOT sending loading_messages — that's the
          // SDK helper bug we're working around.
        });
      } catch (err) {
        // Best-effort; never throw from the cleanup path. The 2-minute
        // auto-timeout will eventually clear the indicator regardless.
        console.warn("[slack] stopTypingFor failed (auto-timeout will clear):", (err as Error).message);
      }
    };
  }

  async isPairingPending(): Promise<boolean> {
    const pending = await readPendingSlackPairing();
    return pending?.status === "pending";
  }

  /**
   * Match against pending Slack pairing. Returns PairingResult on match.
   *
   * Two paths fire `handlePairing`:
   *  1. message.im event from a user. `message.author` carries
   *     userName/userId already populated by the SDK.
   *  2. assistant_thread_started — the gateway adapts that event into a
   *     synthetic IncomingMessage *after* resolving the user via
   *     `slackSdk.getUser(userId)` so userName is populated.
   */
  async handlePairing(thread: ChatThread, message: IncomingMessage): Promise<PairingResult | null> {
    // Early guard: only process threads this adapter owns (defensive; Composite also filters)
    if (!this.ownsThread(thread)) return null;

    const pending = await readPendingSlackPairing();
    if (!pending || pending.status !== "pending") return null;

    const author = (message.author ?? {}) as { userName?: string; userId?: string | number };
    const userIdRaw = author.userId == null ? "" : String(author.userId);
    const userName = author.userName;

    if (!matchPendingPairing(pending, userName, userIdRaw)) {
      // Quietly skip non-matching messages; not an error.
      return null;
    }

    // Extract Slack channel id from the thread (slack:CHANNEL:THREAD_TS) —
    // prefer the SDK's parser over manual splits so future encoding changes
    // don't silently break us.
    const sdk = this.slackSdk;
    const threadId = (thread as unknown as SlackThreadShape).id ?? "";
    let channelId: string | undefined;
    if (sdk && threadId.startsWith("slack:")) {
      try { channelId = sdk.decodeThreadId(threadId).channel; } catch { /* fall through */ }
    }
    if (!channelId) {
      // Fall back to chatId on the message envelope (set by gateway when
      // it builds the synthetic IncomingMessage from assistant events).
      const raw = (message as { chatId?: unknown }).chatId;
      if (typeof raw === "string") channelId = raw;
    }
    if (!channelId || !userIdRaw) {
      console.error(`[slack] pairing matched but missing channelId or userId (channel=${channelId} user=${userIdRaw})`);
      return null;
    }

    await completePendingSlackPairing({
      channelId,
      userId: userIdRaw,
      username: userName,
    });

    return {
      threadId: channelId,
      userId: userIdRaw,
      username: userName ?? userIdRaw,
      transport: this.name,
    };
  }

  // ── private helpers ──────────────────────────────────

  private requireSdk(): SlackSdkAdapter {
    if (!this.slackSdk) {
      throw new Error("SlackAdapter not attached to Chat SDK yet — call attach(slackSdk) after chat.initialize()");
    }
    return this.slackSdk;
  }

  /** Best-effort text post that never throws. Used by postRich's degradation paths. */
  private async safePostText(thread: ChatThread, text: string): Promise<void> {
    try {
      await this.postMessage(thread, text);
      return;
    } catch (err) {
      console.warn("[slack] safePostText.postMessage failed, trying thread.post:", (err as Error).message);
    }
    try {
      await thread.post(text);
    } catch (err) {
      console.error("[slack] safePostText: all paths failed:", (err as Error).message);
    }
  }
}

/** Split a long markdown body at newline boundaries into Slack-sized chunks. */
function splitForSlack(text: string): string[] {
  if (text.length <= SLACK_MARKDOWN_TEXT_LIMIT) return [text];
  const out: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= SLACK_MARKDOWN_TEXT_LIMIT) {
      out.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf("\n", SLACK_MARKDOWN_TEXT_LIMIT);
    if (cut < SLACK_MARKDOWN_TEXT_LIMIT / 2) cut = SLACK_MARKDOWN_TEXT_LIMIT;
    out.push(remaining.slice(0, cut));
    remaining = remaining[cut] === "\n" ? remaining.slice(cut + 1) : remaining.slice(cut);
  }
  return out;
}

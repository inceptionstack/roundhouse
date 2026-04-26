/**
 * gateway.ts — Roundhouse gateway
 *
 * Owns the Vercel Chat SDK instance and wires all platform events
 * through the agent router.
 */

import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { AgentRouter, AgentStreamEvent, GatewayConfig } from "./types";
import { splitMessage, isAllowed, startTypingLoop, DEBUG_STREAM } from "./util";
import { hostname } from "node:os";

// ── Chat SDK adapter factories ───────────────────────
// Lazy-imported so we don't crash if an adapter package isn't installed.

async function buildChatAdapters(
  config: GatewayConfig["chat"]["adapters"]
): Promise<Record<string, unknown>> {
  const adapters: Record<string, unknown> = {};

  if (config.telegram) {
    const { createTelegramAdapter } = await import("@chat-adapter/telegram");
    adapters.telegram = createTelegramAdapter({
      mode: (config.telegram.mode as "auto" | "polling" | "webhook") ?? "auto",
    });
  }

  return adapters;
}

// ── Tool name formatting ─────────────────────────────

const TOOL_ICONS: Record<string, string> = {
  bash: "⚡",
  read: "📖",
  edit: "✏️",
  write: "📝",
  grep: "🔍",
  find: "🔎",
  ls: "📂",
};

function toolIcon(name: string): string {
  return TOOL_ICONS[name] ?? "🔧";
}

// ── Gateway ──────────────────────────────────────────

export class Gateway {
  private chat!: Chat;
  private router: AgentRouter;
  private config: GatewayConfig;

  constructor(router: AgentRouter, config: GatewayConfig) {
    this.router = router;
    this.config = config;
  }

  async start() {
    const chatAdapters = await buildChatAdapters(this.config.chat.adapters);

    if (Object.keys(chatAdapters).length === 0) {
      throw new Error("No chat adapters configured. Add at least one in config.chat.adapters.");
    }

    this.chat = new Chat({
      userName: this.config.chat.botUsername,
      adapters: chatAdapters as any,
      state: createMemoryState(),
    });

    const allowedUsers = (this.config.chat.allowedUsers ?? []).map((u) =>
      u.toLowerCase()
    );

    // ── Unified handler ────────────────────────────
    const handle = async (thread: any, message: any) => {
      const userText = message.text ?? "";
      const authorName = message.author?.userName ?? message.author?.userId ?? "?";

      console.log(
        `[roundhouse] ${thread.id} @${authorName}: "${userText.slice(0, 120)}"`
      );

      if (!isAllowed(message, allowedUsers)) {
        console.log(`[roundhouse] blocked @${authorName} (not in allowlist)`);
        return;
      }

      if (!userText.trim() || userText === "/start") return;

      // Handle /restart command — dispose current session, start fresh
      if (userText.trim() === "/restart") {
        const agent = this.router.resolve(thread.id);
        if (agent.restart) {
          await agent.restart(thread.id);
          await thread.post("🔄 Session restarted. Send a message to begin a new conversation.");
        } else {
          await thread.post("⚠️ Restart not supported for this agent.");
        }
        console.log(`[roundhouse] /restart for thread=${thread.id}`);
        return;
      }

      const agent = this.router.resolve(thread.id);
      console.log(`[roundhouse] → ${agent.name} | thread=${thread.id}`);

      const stopTyping = startTypingLoop(thread);

      try {
        if (agent.promptStream) {
          await this.handleStreaming(thread, agent.promptStream(thread.id, userText));
        } else {
          // Fallback: non-streaming prompt
          const reply = await agent.prompt(thread.id, userText);
          if (reply.text) {
            await this.postWithFallback(thread, reply.text);
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const safeMsg = errMsg.split('\n')[0].slice(0, 200);
        console.error(`[roundhouse] agent error:`, err);
        try {
          await thread.post(`⚠️ Error: ${safeMsg}`);
        } catch {}
      } finally {
        stopTyping();
      }
    };

    // ── Wire Chat SDK events ───────────────────────
    this.chat.onDirectMessage(async (thread, message) => {
      await thread.subscribe();
      await handle(thread, message);
    });

    this.chat.onNewMention(async (thread, message) => {
      await thread.subscribe();
      await handle(thread, message);
    });

    this.chat.onSubscribedMessage(async (thread, message) => {
      await handle(thread, message);
    });

    await this.chat.initialize();

    const platforms = Object.keys(this.config.chat.adapters).join(", ");
    console.log(`[roundhouse] gateway ready (platforms: ${platforms})`);

    // ── Startup notification ───────────────────────
    await this.notifyStartup(platforms);
  }

  /**
   * Stream agent events to the chat thread.
   *
   * Strategy:
   * - Text deltas are collected per-turn and streamed via thread.handleStream()
   *   which does post+edit with rate limiting.
   * - Tool starts/ends are sent as compact status messages.
   * - Turn boundaries trigger a new message for the next turn's text.
   */
  private async handleStreaming(thread: any, stream: AsyncIterable<AgentStreamEvent>) {
    let activeTools = new Map<string, string>(); // toolCallId -> toolName

    // Per-turn streaming state — each turn gets a fresh iterable + promise
    let currentPush: ((text: string) => void) | null = null;
    let currentFinish: (() => void) | null = null;
    let currentPromise: Promise<void> | null = null;

    function createTextStream(): { iterable: AsyncIterable<string>; push: (text: string) => void; finish: () => void } {
      let buffer = "";
      let resolve: ((value: IteratorResult<string>) => void) | null = null;
      let done = false;

      const iterable: AsyncIterable<string> = {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<string>> {
              if (buffer) {
                const chunk = buffer;
                buffer = "";
                return { value: chunk, done: false };
              }
              if (done) return { value: undefined as any, done: true };
              return new Promise((r) => { resolve = r; });
            },
          };
        },
      };

      return {
        iterable,
        push(text: string) {
          if (resolve) {
            const r = resolve;
            resolve = null;
            r({ value: text, done: false });
          } else {
            buffer += text;
          }
        },
        finish() {
          done = true;
          resolve?.({ value: undefined as any, done: true });
        },
      };
    }

    const flushCurrentStream = async () => {
      if (!currentPromise) return;
      currentFinish?.();
      try {
        await currentPromise;
      } catch (err) {
        console.warn(`[roundhouse] stream flush error:`, (err as Error).message);
      }
      currentPush = null;
      currentFinish = null;
      currentPromise = null;
    };

    const ensureStream = () => {
      if (!currentPromise) {
        const ts = createTextStream();
        currentPush = ts.push;
        currentFinish = ts.finish;
        currentPromise = thread.handleStream(ts.iterable).catch((err: Error) => {
          console.warn(`[roundhouse] handleStream error:`, err.message);
        });
      }
    };

    let hasTextInCurrentTurn = false;
    let eventCount = 0;

    for await (const event of stream) {
      if (DEBUG_STREAM) {
        eventCount++;
        const preview = event.type === "text_delta" ? `"${event.text.slice(0, 30)}"`
          : event.type === "custom_message" ? `${event.customType}:${event.content.slice(0, 30)}`
          : event.type === "tool_start" || event.type === "tool_end" ? event.toolName
          : "";
        console.log(`[roundhouse/stream] #${eventCount} ${event.type} ${preview}`);
      }
      switch (event.type) {
        case "text_delta": {
          ensureStream();
          currentPush!(event.text);
          hasTextInCurrentTurn = true;
          break;
        }

        case "tool_start": {
          activeTools.set(event.toolCallId, event.toolName);
          // Send a compact tool status message
          try {
            await thread.post(`${toolIcon(event.toolName)} Running \`${event.toolName}\`…`);
          } catch {}
          break;
        }

        case "tool_end": {
          activeTools.delete(event.toolCallId);
          break;
        }

        case "custom_message": {
          // Extension messages (e.g. code review) — flush current stream and post as distinct message
          if (currentPromise) {
            await flushCurrentStream();
            hasTextInCurrentTurn = false;
          }
          await this.postWithFallback(thread, event.content);
          break;
        }

        case "turn_end": {
          if (hasTextInCurrentTurn) {
            await flushCurrentStream();
            hasTextInCurrentTurn = false;
          }
          break;
        }

        case "agent_end": {
          if (hasTextInCurrentTurn) {
            await flushCurrentStream();
          }
          break;
        }
      }
    }

    // Safety: make sure we flush
    if (currentPromise) {
      await flushCurrentStream();
    }
  }

  /** Post text with markdown, falling back to plain text */
  private async postWithFallback(thread: any, text: string) {
    for (const chunk of splitMessage(text, 4000)) {
      try {
        await thread.post({ markdown: chunk });
      } catch {
        try {
          await thread.post(chunk);
        } catch (err) {
          console.error(`[roundhouse] post failed:`, (err as Error).message);
        }
      }
    }
  }

  /**
   * Send a startup notification to configured chat IDs.
   * Currently Telegram-only — when Slack/Discord adapters are added,
   * extend this to use their respective APIs or a Chat SDK broadcast API.
   */
  private async notifyStartup(platforms: string) {
    const chatIds = this.config.chat.notifyChatIds;
    if (!chatIds?.length) return;

    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      console.warn("[roundhouse] notifyChatIds configured but TELEGRAM_BOT_TOKEN not set — skipping startup notification");
      return;
    }

    const uptime = process.uptime();
    const host = hostname();
    const agentName = this.config.agent.type;
    const now = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
    const text = `\u2705 Roundhouse is online\n\nHost: ${host}\nPlatforms: ${platforms}\nAgent: ${agentName}\nStarted: ${now}\nBoot time: ${uptime.toFixed(1)}s`;

    for (const chatId of chatIds) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          console.warn(`[roundhouse] startup notification to ${chatId} failed (${res.status}): ${body.slice(0, 200)}`);
        }
      } catch (err) {
        console.warn(`[roundhouse] failed to send startup notification to ${chatId}:`, (err as Error).message);
      }
    }
  }

  async stop() {
    await this.router.dispose();
    console.log("[roundhouse] stopped");
  }
}

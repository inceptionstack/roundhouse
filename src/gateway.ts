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
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __gatewayDir = dirname(fileURLToPath(import.meta.url));
const ROUNDHOUSE_VERSION: string = (() => {
  try { return JSON.parse(readFileSync(join(__gatewayDir, "..", "package.json"), "utf8")).version; }
  catch { return "unknown"; }
})();

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
      concurrency: "concurrent",
    });

    const allowedUsers = (this.config.chat.allowedUsers ?? []).map((u) =>
      u.toLowerCase()
    );

    // Per-thread verbose toggle (shows tool_start messages)
    const verboseThreads = new Set<string>();

    // Per-thread abort signal for /stop
    const abortControllers = new Map<string, AbortController>();

    // Per-thread lock to serialize prompts (concurrent mode lets /stop through)
    const threadLocks = new Map<string, Promise<void>>();

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

      // Handle /new command — dispose current session, start fresh
      if (userText.trim() === "/new") {
        const agent = this.router.resolve(thread.id);
        if (agent.restart) {
          await agent.restart(thread.id);
          await thread.post("🔄 Session restarted. Send a message to begin a new conversation.");
        } else {
          await thread.post("⚠️ New session not supported for this agent.");
        }
        console.log(`[roundhouse] /new for thread=${thread.id}`);
        return;
      }

      // Handle /restart command — restart the gateway process
      // Only available when an allowlist is configured (all allowed users can restart)
      if (userText.trim() === "/restart") {
        if (allowedUsers.length === 0) {
          await thread.post("⚠️ /restart requires an allowedUsers list to be configured.");
          return;
        }
        console.log(`[roundhouse] /restart requested by @${authorName} in thread=${thread.id}`);
        await thread.post("🔄 Restarting gateway...");
        // Graceful shutdown then exit with non-zero so systemd Restart=on-failure brings us back
        setTimeout(async () => {
          console.log("[roundhouse] shutting down for restart");
          try { await this.stop(); } catch (e) { console.error("[roundhouse] stop error:", e); }
          process.exit(75);
        }, 1000);
        return;
      }

      // Handle /compact command — compact session context
      if (userText.trim() === "/compact") {
        const agent = this.router.resolve(thread.id);
        if (!agent.compact) {
          await thread.post("⚠️ Compaction not supported for this agent.");
          return;
        }
        console.log(`[roundhouse] /compact for thread=${thread.id}`);
        await thread.post("📦 Compacting session context...");
        const stopTyping = startTypingLoop(thread);
        try {
          const result = await agent.compact(thread.id);
          if (!result) {
            await thread.post("⚠️ No active session to compact. Send a message first.");
          } else {
            const beforeK = (result.tokensBefore / 1000).toFixed(1);
            await thread.post(`✅ Compaction complete\n\nCompacted ${beforeK}K tokens down to a summary.\nContext usage will update after your next message.`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await thread.post(`⚠️ Compaction failed: ${msg.slice(0, 200)}`);
        } finally {
          stopTyping();
        }
        return;
      }

      // Handle /status command — show gateway details
      if (userText.trim() === "/status") {
        const agent = this.router.resolve(thread.id);
        const uptimeSec = process.uptime();
        const uptimeStr = uptimeSec < 3600
          ? `${Math.floor(uptimeSec / 60)}m ${Math.floor(uptimeSec % 60)}s`
          : `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;
        const platforms = Object.keys(this.config.chat.adapters).join(", ");
        const debugStream = process.env.ROUNDHOUSE_DEBUG_STREAM === "1";
        const nodeVer = process.version;
        const memMB = (process.memoryUsage.rss() / 1024 / 1024).toFixed(1);

        const info = agent.getInfo ? agent.getInfo(thread.id) : {};
        const agentVersion = info.version ? `v${info.version}` : "";
        const agentLabel = agentVersion ? `\`${agent.name}\` (${agentVersion})` : `\`${agent.name}\``;

        const lines = [
          `📊 *Roundhouse Status*`,
          ``,
          `📦 Roundhouse: v${ROUNDHOUSE_VERSION}`,
          `🤖 Agent: ${agentLabel}`,
        ];

        if (info.model) lines.push(`🧠 Model: \`${info.model}\``);
        if (info.activeSessions !== undefined) lines.push(`💬 Active sessions: ${info.activeSessions}`);

        lines.push(
          `🌐 Platforms: ${platforms}`,
          `👤 Bot: @${this.config.chat.botUsername}`,
          `⏱ Uptime: ${uptimeStr}`,
          `💾 Memory: ${memMB} MB`,
          `🟢 Node: ${nodeVer}`,
          `🔧 Debug stream: ${debugStream ? "on" : "off"}`,
          `📢 Verbose: ${verboseThreads.has(thread.id) ? "on" : "off"}`,
        );

        const allowedCount = allowedUsers.length;
        lines.push(`🔐 Allowed users: ${allowedCount === 0 ? "all (no allowlist)" : allowedCount}`);

        // Context usage with progress bar
        if (typeof info.contextTokens === "number" && typeof info.contextWindow === "number" && info.contextWindow > 0) {
          const pct = Math.min(100, Math.round((info.contextTokens as number) / (info.contextWindow as number) * 100));
          const barLen = 20;
          const filled = Math.round(pct / 100 * barLen);
          const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
          const tokensK = ((info.contextTokens as number) / 1000).toFixed(1);
          const windowK = ((info.contextWindow as number) / 1000).toFixed(0);
          lines.push(``);
          lines.push(`📝 Context: \`${bar}\` ${pct}%`);
          lines.push(`   ${tokensK}K / ${windowK}K tokens`);
        } else if (typeof info.contextWindow === "number" && info.contextWindow > 0) {
          const windowK = ((info.contextWindow as number) / 1000).toFixed(0);
          lines.push(``);
          lines.push(`📝 Context: no usage data yet (${windowK}K window)`);
        }

        await thread.post({ markdown: lines.join("\n") });
        console.log(`[roundhouse] /status for thread=${thread.id}`);
        return;
      }

      const agent = this.router.resolve(thread.id);

      // Serialize prompts per-thread (concurrent mode allows /stop to bypass)
      const prevLock = threadLocks.get(thread.id);
      let releaseLock: () => void;
      const lockPromise = new Promise<void>((resolve) => { releaseLock = resolve; });
      threadLocks.set(thread.id, lockPromise);
      if (prevLock) await prevLock;

      console.log(`[roundhouse] → ${agent.name} | thread=${thread.id}`);

      const stopTyping = startTypingLoop(thread);

      try {
        if (agent.promptStream) {
          const ac = new AbortController();
          abortControllers.set(thread.id, ac);
          try {
            await this.handleStreaming(thread, agent.promptStream(thread.id, userText), verboseThreads.has(thread.id), ac.signal);
          } finally {
            abortControllers.delete(thread.id);
          }
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
        releaseLock!();
        if (threadLocks.get(thread.id) === lockPromise) {
          threadLocks.delete(thread.id);
        }
      }
    };

    // ── Wire Chat SDK events ───────────────────────
    const handleOrAbort = async (thread: any, message: any) => {
      const text = (message.text ?? "").trim();
      // /stop is handled immediately — abort the in-flight agent run
      // without waiting for the current handler to finish
      if (text === "/stop") {
        if (!isAllowed(message, allowedUsers)) return;
        const agent = this.router.resolve(thread.id);
        if (agent.abort) {
          await agent.abort(thread.id);
          abortControllers.get(thread.id)?.abort();
          try { await thread.post("⏹️ Stopped."); } catch {}
        } else {
          try { await thread.post("⚠️ Abort not supported for this agent."); } catch {}
        }
        console.log(`[roundhouse] /stop for thread=${thread.id}`);
        return;
      }
      // /verbose is a gateway toggle — runs immediately, no queuing
      if (text === "/verbose") {
        if (!isAllowed(message, allowedUsers)) return;
        const threadId = thread.id;
        if (verboseThreads.has(threadId)) {
          verboseThreads.delete(threadId);
          try { await thread.post("🔇 Verbose mode OFF — tool status messages hidden."); } catch {}
        } else {
          verboseThreads.add(threadId);
          try { await thread.post("📢 Verbose mode ON — showing tool calls."); } catch {}
        }
        console.log(`[roundhouse] /verbose for thread=${threadId} -> ${verboseThreads.has(threadId) ? "on" : "off"}`);
        return;
      }
      await handle(thread, message);
    };

    this.chat.onDirectMessage(async (thread, message) => {
      await thread.subscribe();
      await handleOrAbort(thread, message);
    });

    this.chat.onNewMention(async (thread, message) => {
      await thread.subscribe();
      await handleOrAbort(thread, message);
    });

    this.chat.onSubscribedMessage(async (thread, message) => {
      await handleOrAbort(thread, message);
    });

    await this.chat.initialize();

    const platforms = Object.keys(this.config.chat.adapters).join(", ");
    console.log(`[roundhouse] gateway ready (platforms: ${platforms})`);

    // ── Register bot commands & send startup notification ───
    await this.registerBotCommands();
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
  private async handleStreaming(thread: any, stream: AsyncIterable<AgentStreamEvent>, verbose: boolean, signal?: AbortSignal) {
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
    let drainingNotified = false;

    for await (const event of stream) {
      // Check if /stop was called
      if (signal?.aborted) {
        console.log(`[roundhouse] stream aborted for thread`);
        break;
      }
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
          if (verbose) {
            try {
              await thread.post(`${toolIcon(event.toolName)} Running \`${event.toolName}\`…`);
            } catch {}
          }
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

        case "draining": {
          if (hasTextInCurrentTurn) {
            await flushCurrentStream();
            hasTextInCurrentTurn = false;
          }
          try {
            await thread.post("⏳ Hold on — waiting for follow-up messages...");
            drainingNotified = true;
          } catch {}
          break;
        }

        case "drain_complete": {
          if (hasTextInCurrentTurn) {
            await flushCurrentStream();
            hasTextInCurrentTurn = false;
          }
          if (drainingNotified) {
            try {
              await thread.post("✅ All done — waiting for your input.");
            } catch {}
            drainingNotified = false;
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
   * Register bot commands with Telegram so they appear in the / menu.
   * Runs on every startup to keep commands in sync with the code.
   */
  private async registerBotCommands() {
    if (!this.config.chat.adapters.telegram) return;

    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return;

    const commands = [
      { command: "new", description: "Start a fresh conversation" },
      { command: "compact", description: "Compact session context to free up tokens" },
      { command: "verbose", description: "Toggle tool status messages" },
      { command: "stop", description: "Stop the current agent run" },
      { command: "restart", description: "Restart the gateway service" },
      { command: "status", description: "Show gateway status" },
    ];

    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commands }),
      });
      if (res.ok) {
        console.log(`[roundhouse] registered ${commands.length} bot commands with Telegram`);
      } else {
        const body = await res.text().catch(() => "");
        console.warn(`[roundhouse] failed to register bot commands (${res.status}): ${body.slice(0, 200)}`);
      }
    } catch (err) {
      console.warn(`[roundhouse] failed to register bot commands:`, (err as Error).message);
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
    try { await this.chat?.shutdown(); } catch (e) { console.warn("[roundhouse] chat shutdown error:", e); }
    await this.router.dispose();
    console.log("[roundhouse] stopped");
  }
}

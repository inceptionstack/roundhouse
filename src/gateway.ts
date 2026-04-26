/**
 * gateway.ts — Roundhouse gateway
 *
 * Owns the Vercel Chat SDK instance and wires all platform events
 * through the agent router.
 */

import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { AgentRouter, GatewayConfig } from "./types";
import { splitMessage, isAllowed, startTypingLoop } from "./util";

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

  // Future:
  // if (config.slack) { ... }
  // if (config.discord) { ... }

  return adapters;
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

      const agent = this.router.resolve(thread.id);
      console.log(`[roundhouse] → ${agent.name} | thread=${thread.id}`);

      const stopTyping = startTypingLoop(thread);

      try {
        const reply = await agent.prompt(thread.id, userText);
        if (reply.text) {
          for (const chunk of splitMessage(reply.text, 4000)) {
            try {
              await thread.post({ markdown: chunk });
            } catch (postErr) {
              // Markdown parse failed (e.g. unclosed entities) — retry as plain text
              console.warn(`[roundhouse] markdown post failed, falling back to plain text:`, (postErr as Error).message);
              await thread.post(chunk);
            }
          }
        }
        // No fallback message — tool-only turns legitimately produce no text.
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[roundhouse] agent error:`, err);
        try {
          await thread.post(`⚠️ Error: ${errMsg}`);
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
  }

  async stop() {
    await this.router.dispose();
    console.log("[roundhouse] stopped");
  }
}

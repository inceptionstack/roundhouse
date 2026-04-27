/**
 * cli/setup-telegram.ts — Telegram API helpers for setup
 *
 * Zero-dependency Telegram Bot API client using global fetch.
 * Token is never logged — redacted in all error messages.
 */

import { randomBytes } from "node:crypto";
import { BOT_COMMANDS } from "../commands";

// ── Types ────────────────────────────────────────────

export interface BotInfo {
  id: number;
  username: string;
  firstName: string;
}

export interface PairResult {
  chatId: number;
  userId: number;
  username: string;
}

// ── API helper ───────────────────────────────────────

function redactToken(token: string): string {
  if (token.length < 10) return "***";
  return token.slice(0, 4) + "..." + token.slice(-4);
}

async function telegramApi(
  token: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<any> {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: params ? JSON.stringify(params) : undefined,
  });
  const data = await resp.json() as any;
  if (!data.ok) {
    throw new Error(
      `Telegram API ${method} failed: ${data.description ?? "unknown error"} (token: ${redactToken(token)})`,
    );
  }
  return data;
}

// ── Public functions ─────────────────────────────────

/** Validate a bot token and return bot info */
export async function validateBotToken(token: string): Promise<BotInfo> {
  const data = await telegramApi(token, "getMe");
  const r = data.result;
  return { id: r.id, username: r.username, firstName: r.first_name ?? r.username };
}

/** Check if a webhook is active (conflicts with polling) */
export async function checkWebhook(token: string): Promise<string | null> {
  const data = await telegramApi(token, "getWebhookInfo");
  const url = data.result?.url;
  return url && url.length > 0 ? url : null;
}

/** Register bot commands with Telegram */
export async function registerBotCommands(token: string): Promise<void> {
  await telegramApi(token, "setMyCommands", { commands: BOT_COMMANDS });
}

/** Send a message to a chat */
export async function sendMessage(token: string, chatId: number, text: string): Promise<void> {
  await telegramApi(token, "sendMessage", { chat_id: chatId, text });
}

/**
 * Pair with a Telegram user — wait for them to send /start <nonce>.
 * Returns the user's chat ID and numeric user ID, or null on timeout.
 */
export async function pairTelegram(
  token: string,
  botUsername: string,
  allowedUsers: string[],
  timeoutMs = 300_000,
  log: (msg: string) => void = console.log,
): Promise<PairResult | null> {
  const nonce = `rh-${randomBytes(3).toString("hex")}`;
  const normalizedUsers = allowedUsers.map((u) => u.replace(/^@/, "").toLowerCase());

  // Clear stale updates — advance offset past existing
  let offset = 0;
  try {
    const stale = await telegramApi(token, "getUpdates", { offset: -1, limit: 1 });
    if (stale.result?.length > 0) {
      offset = stale.result[stale.result.length - 1].update_id + 1;
      await telegramApi(token, "getUpdates", { offset, timeout: 0 });
    }
  } catch {
    // If getUpdates fails, start from 0
  }

  log(`   Open https://t.me/${botUsername} and send: /start ${nonce}`);
  log(`   Waiting... (Ctrl+C to skip)\n`);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pollTimeout = Math.min(10, Math.floor((deadline - Date.now()) / 1000));
    if (pollTimeout <= 0) break;

    try {
      const updates = await telegramApi(token, "getUpdates", { offset, timeout: pollTimeout });

      for (const update of updates.result ?? []) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.from?.username) continue;

        const fromUser = msg.from.username.toLowerCase();
        const text = (msg.text ?? "").trim();

        // Accept /start <nonce> from allowed user (exact match)
        if (normalizedUsers.includes(fromUser) && (text === `/start ${nonce}` || text === nonce)) {
          // Send welcome
          await telegramApi(token, "sendMessage", {
            chat_id: msg.chat.id,
            text: "✅ Roundhouse paired successfully!\n\nThe gateway is starting up. Send /status once it's ready.",
          });

          // Advance offset past consumed updates only
          await telegramApi(token, "getUpdates", { offset, timeout: 0 });

          return {
            chatId: msg.chat.id,
            userId: msg.from.id,
            username: msg.from.username,
          };
        }
      }
    } catch (err) {
      // Network hiccup — retry
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  return null;
}

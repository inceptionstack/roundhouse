/**
 * cli/setup/telegram.ts — Telegram API helpers for setup
 *
 * Zero-dependency Telegram Bot API client using global fetch.
 * Token is never logged — redacted in all error messages.
 */

import { createPairingNonce } from "../../transports/telegram/pairing";
import { BOT_COMMANDS } from "../../transports/telegram/bot-commands";

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

export function redactToken(token: string): string {
  if (token.length < 10) return "***";
  return token.slice(0, 4) + "..." + token.slice(-4);
}

export async function telegramApi(
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
export async function sendMessage(token: string, chatId: number | string, text: string): Promise<void> {
  await telegramApi(token, "sendMessage", { chat_id: chatId, text });
}

/**
 * Pair with a Telegram user — wait for them to send /start <nonce>.
 * Returns the user's chat ID and numeric user ID, or null on timeout.
 *
 * If opts.nonce is provided, use it instead of generating a new one.
 * If opts.showLink is false, skip printing the pairing instructions.
 */
export async function pairTelegram(
  token: string,
  botUsername: string,
  allowedUsers: string[],
  timeoutMs = 300_000,
  log: (msg: string) => void = console.log,
  opts?: { nonce?: string; showLink?: boolean },
): Promise<PairResult | null> {
  const nonce = opts?.nonce ?? createPairingNonce();
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

  if (opts?.showLink !== false) {
    log(`   Open https://t.me/${botUsername}?start=${nonce} and tap Start`);
    log(`   Or send /start ${nonce} to @${botUsername}`);
    log(`   Waiting... (Ctrl+C to skip)\n`);
  }

  // Each distinct hint is printed once, and at most a handful in total.
  const hinted = new Set<string>();
  const hint = (message: string) => {
    if (hinted.has(message) || hinted.size >= 8) return;
    hinted.add(message);
    log(`   ↪ ${message}`);
  };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pollTimeout = Math.min(10, Math.floor((deadline - Date.now()) / 1000));
    if (pollTimeout <= 0) break;

    try {
      const updates = await telegramApi(token, "getUpdates", { offset, timeout: pollTimeout });

      for (const update of updates.result ?? []) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.from) continue;

        const text = (msg.text ?? "").trim();
        const fromUser = typeof msg.from.username === "string" ? msg.from.username.toLowerCase() : "";

        // Say in the terminal why a message did not pair. Waiting in silence
        // is indistinguishable from a broken bot. Nothing is sent to the chat:
        // a stranger writing to the bot learns nothing.
        if (!fromUser) {
          hint(`a message arrived from an account with no @username (id ${msg.from.id}). Set one in Telegram → Settings → Username, then tap the link again.`);
          continue;
        }
        if (!normalizedUsers.includes(fromUser)) {
          hint(`ignored a message from @${msg.from.username}: pairing is waiting for ${normalizedUsers.map((u) => "@" + u).join(", ")}. If that is you, run pairing again with --user ${msg.from.username}.`);
          continue;
        }
        if (text !== `/start ${nonce}` && text !== nonce) {
          hint(`@${msg.from.username} wrote to the bot, but without the pairing code. Open the link above, or send it this exact message: /start ${nonce}`);
          continue;
        }

        // Accept /start <nonce> from allowed user (exact match)
        {
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
      // Network hiccup or an API error (another program polling this bot, a
      // webhook): say so once per distinct error, then retry.
      hint(`Telegram: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  return null;
}

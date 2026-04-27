/**
 * notify/telegram.ts — Shared Telegram Bot API sender
 *
 * Used by gateway startup notifications, cron notifications, etc.
 */

const DEFAULT_TIMEOUT = 15_000;

/** Send a text message via Telegram Bot API */
export async function sendTelegramMessage(
  chatId: string | number,
  text: string,
  options?: { parseMode?: string; timeout?: number },
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;

  try {
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (options?.parseMode) body.parse_mode = options.parseMode;

    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options?.timeout ?? DEFAULT_TIMEOUT),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.warn(`[telegram] sendMessage to ${chatId} failed (${res.status}): ${errBody.slice(0, 200)}`);
    }
    return res.ok;
  } catch (err) {
    console.warn(`[telegram] sendMessage to ${chatId} failed:`, (err as Error).message);
    return false;
  }
}

/** Send a message to multiple chat IDs */
export async function sendTelegramToMany(
  chatIds: (string | number)[],
  text: string,
  options?: { parseMode?: string },
): Promise<void> {
  for (const chatId of chatIds) {
    await sendTelegramMessage(chatId, text, options);
  }
}

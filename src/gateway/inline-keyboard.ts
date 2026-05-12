/**
 * gateway/inline-keyboard.ts — Shared helpers for Telegram inline keyboards
 *
 * Centralizes the callback-data protocol used by @chat-adapter/telegram so
 * that commands like /model and /topic stay in sync. If the adapter's prefix
 * ever changes, update it here once and every command keeps working.
 */

/**
 * Callback data prefix used by @chat-adapter/telegram.
 *
 * COUPLING: this must match the prefix the adapter listens for when routing
 * `callback_query` events to `chat.onAction(...)`. If the adapter package
 * changes this protocol, buttons silently stop working — watch this constant
 * during adapter upgrades.
 */
export const CALLBACK_PREFIX = "chat:";

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboard {
  inline_keyboard: InlineButton[][];
}

/** Encode an action+value pair into a Telegram `callback_data` string. */
export function encodeCallbackData(actionId: string, value: string): string {
  return `${CALLBACK_PREFIX}${JSON.stringify({ a: actionId, v: value })}`;
}

/**
 * Chunk a flat list of buttons into rows for a compact keyboard layout.
 * Default is 2 columns, matching /model and /topic.
 */
export function toKeyboardRows(buttons: InlineButton[], columns = 2): InlineKeyboard {
  const rows: InlineButton[][] = [];
  for (let i = 0; i < buttons.length; i += columns) {
    rows.push(buttons.slice(i, i + columns));
  }
  return { inline_keyboard: rows };
}

/**
 * Minimal shape of a thread passed to command handlers. Captures just the
 * fields both /model and /topic need — avoids `any` without dragging in
 * the full Chat SDK types.
 */
export interface ChatThreadLike {
  id?: string;
  platformThreadId?: string;
  /** Present on Telegram threads; undefined on other transports. */
  adapter?: {
    telegramFetch?: (method: string, payload: Record<string, unknown>) => Promise<unknown>;
  };
  /** Post a message back to the thread; accepts raw text or `{ markdown }`. */
  post?: (arg: string | { markdown: string }) => Promise<unknown>;
}

/** Extract the numeric Telegram chat id from a thread's id string. */
export function extractTelegramChatId(thread: ChatThreadLike | undefined): string | undefined {
  return thread?.platformThreadId?.split(":")?.[1] ?? thread?.id?.split(":")?.[1];
}

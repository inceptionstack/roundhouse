/**
 * gateway/inline-keyboard.ts \u2014 DEPRECATED shim
 *
 * @deprecated Telegram-specific helpers were moved to
 * `src/transports/telegram/rich-ui.ts` as part of the Rich UI Surface
 * migration. Gateway command modules should not import from this file
 * \u2014 they should return `RichResponse` and let the transport adapter
 * render the menu via `postRich()`.
 *
 * This file is kept temporarily for backward compatibility with any
 * out-of-tree extension code that imports the legacy helpers. New code
 * MUST NOT add imports here.
 *
 * Removal target: once all gateway commands are migrated to RichResponse
 * (see docs/rich-ui-surface-design.md), delete this file.
 */

import {
  CALLBACK_PREFIX as _CALLBACK_PREFIX,
  encodeTelegramCallbackData,
  type TelegramInlineButton,
  type TelegramInlineKeyboard,
} from "../transports/telegram/rich-ui";

/** @deprecated re-exported from `src/transports/telegram/rich-ui.ts` */
export const CALLBACK_PREFIX = _CALLBACK_PREFIX;

/** @deprecated use `RichButton` from `src/transports`. */
export type InlineButton = TelegramInlineButton;

/** @deprecated use `RichMenu` from `src/transports`. */
export type InlineKeyboard = TelegramInlineKeyboard;

/** @deprecated use `RichResponse` and `TransportAdapter.postRich()`. */
export function encodeCallbackData(actionId: string, value: string): string {
  return encodeTelegramCallbackData(actionId, value);
}

/**
 * @deprecated chunk a flat list of buttons into rows. Replaced by
 * `toTelegramInlineKeyboard(menu)` which lays out from a RichMenu.
 */
export function toKeyboardRows(buttons: InlineButton[], columns = 2): InlineKeyboard {
  const rows: InlineButton[][] = [];
  const cols = Math.max(1, columns | 0);
  for (let i = 0; i < buttons.length; i += cols) {
    rows.push(buttons.slice(i, i + cols));
  }
  return { inline_keyboard: rows };
}

/**
 * @deprecated minimal shape kept for legacy callers. New gateway-level
 * code should use `ChatThread` from `src/transports`.
 */
export interface ChatThreadLike {
  id?: string;
  platformThreadId?: string;
  adapter?: {
    telegramFetch?: (method: string, payload: Record<string, unknown>) => Promise<unknown>;
  };
  post?: (arg: string | { markdown: string }) => Promise<unknown>;
}

/**
 * @deprecated chat-id extraction is now an internal detail of the Telegram
 * adapter (`postRich()` does it). Kept for any non-Telegram-specific
 * callers that legitimately need to introspect a Telegram thread id.
 */
export function extractTelegramChatId(thread: ChatThreadLike | undefined): string | undefined {
  return thread?.platformThreadId?.split(":")?.[1] ?? thread?.id?.split(":")?.[1];
}

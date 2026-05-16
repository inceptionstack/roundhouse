/**
 * transports/telegram/rich-ui.ts \u2014 Telegram rendering for RichResponse / RichMenu
 *
 * Owns the Telegram callback-data protocol and inline-keyboard layout.
 *
 * COUPLING: `CALLBACK_PREFIX` must match the prefix `@chat-adapter/telegram`
 * looks for when routing `callback_query` events to `chat.onAction(...)`. If
 * the adapter package changes its protocol, buttons silently stop working.
 * Watch this constant during adapter upgrades.
 *
 * Why this lives in transports/telegram/ and not gateway/:
 *   The callback-data string format is a Telegram-specific wire detail.
 *   Gateway-level commands describe buttons abstractly (actionId + value)
 *   via RichButton; this module is the only place that encodes that pair
 *   into a Telegram callback payload.
 */

import type { RichButton, RichMenu, RichMenuSection } from "../types";

/** Prefix recognised by `@chat-adapter/telegram` when routing callback queries. */
export const CALLBACK_PREFIX = "chat:";

export interface TelegramInlineButton {
  text: string;
  callback_data: string;
}

export interface TelegramInlineKeyboard {
  inline_keyboard: TelegramInlineButton[][];
}

/** Encode an action+value pair into a Telegram `callback_data` string. */
export function encodeTelegramCallbackData(actionId: string, value: string): string {
  return `${CALLBACK_PREFIX}${JSON.stringify({ a: actionId, v: value })}`;
}

/** Chunk a flat list of inline buttons into rows for a compact keyboard layout. */
function toKeyboardRows(
  buttons: TelegramInlineButton[],
  columns: number,
): TelegramInlineKeyboard {
  const rows: TelegramInlineButton[][] = [];
  const cols = Math.max(1, Math.min(3, columns | 0));
  for (let i = 0; i < buttons.length; i += cols) {
    rows.push(buttons.slice(i, i + cols));
  }
  return { inline_keyboard: rows };
}

/**
 * Render a single section's buttons with a section-specific column count.
 * The default column count for a section is 2 (matches the previous /model
 * + /topic layout exactly).
 */
function renderSection(section: RichMenuSection): TelegramInlineButton[][] {
  const cols = section.columns ?? 2;
  const tgButtons: TelegramInlineButton[] = section.buttons.map(buttonToTelegram);
  return toKeyboardRows(tgButtons, cols).inline_keyboard;
}

function buttonToTelegram(btn: RichButton): TelegramInlineButton {
  // The "selected" hint becomes a trailing checkmark so the user can see which
  // option is active. Telegram inline buttons have no native "selected" state,
  // so this is the only signal we have.
  const text = btn.selected ? `${btn.label} \u2713` : btn.label;
  return {
    text,
    callback_data: encodeTelegramCallbackData(btn.actionId, btn.value),
  };
}

/**
 * Convert a transport-agnostic RichMenu into a Telegram inline keyboard.
 * Sections are concatenated row-wise, each section laid out by its own
 * `columns` hint.
 */
export function toTelegramInlineKeyboard(menu: RichMenu): TelegramInlineKeyboard {
  const rows: TelegramInlineButton[][] = [];
  for (const section of menu.sections) {
    rows.push(...renderSection(section));
  }
  return { inline_keyboard: rows };
}

/**
 * transports/rich-helpers.ts — Helpers for building RichResponse menus.
 *
 * `buildSelectableMenu()` captures the "pick one of these options" pattern
 * shared by /model and /topic: render buttons with a marker on the current
 * selection, and emit a matching plain-text fallback for transports that
 * can't render menus.
 *
 * Transport-neutral: this module never imports from transports/telegram.
 */

import { Card, Section, Actions, Button } from "chat";
import type { CardElement } from "chat";
import type { RichButton, RichMenu, RichResponse } from "./types";

// `Text` from "chat" resolves to mdast's TYPE re-export, not the JSX
// factory; the factory lives at chat/jsx-runtime. Constructing TextElement
// objects directly keeps the dep boundary small.
const text = (content: string, style?: "plain" | "bold" | "muted") =>
  ({ type: "text" as const, content, ...(style ? { style } : {}) });

/** A single picker option. `key` is the callback value; `label` is what the user sees. */
export interface SelectableOption {
  key: string;
  label: string;
}

export interface SelectableMenuOpts {
  /** Currently active option key (matches one of `options[*].key` or sentinel). */
  current: string | undefined;
  /** Available options. */
  options: SelectableOption[];
  /** Action id wired to the descriptor's `actions[…]`. */
  actionId: string;
  /** Markdown header line, e.g. "*Current model:* `sonnet`". */
  textHeader: string;
  /** Optional usage hint line(s) shown below the option list. */
  textHint?: string;
  /** Layout hint passed through to the menu section. Default 2. */
  columns?: 1 | 2 | 3;
  /**
   * Optional sentinel button prepended before regular options
   * (e.g. "main (default)" for /topic). Its `value` is what the action
   * handler receives — must be unrepresentable as a regular option key
   * to avoid collision (see topic-command.ts MAIN_SENTINEL).
   */
  sentinel?: {
    label: string;
    value: string;
    /** When true, sentinel renders as selected when `current` is undefined. */
    activeWhenCurrentIsUndefined?: boolean;
  };
}

/**
 * Build a RichResponse for a "pick one of these options" menu.
 *
 * - Renders a check-mark (✓) on the selected button via `selected: true`.
 *   (Transports decide how to visualize; the Telegram adapter prefixes
 *   the label.)
 * - Emits a plain-text fallback that mentions every option and the
 *   current selection, so text-only transports stay informative.
 */
export function buildSelectableMenu(opts: SelectableMenuOpts): RichResponse {
  const {
    current,
    options,
    actionId,
    textHeader,
    textHint,
    columns = 2,
    sentinel,
  } = opts;

  // ── Buttons ──
  const buttons: RichButton[] = [];
  if (sentinel) {
    buttons.push({
      label: sentinel.label,
      actionId,
      value: sentinel.value,
      selected: sentinel.activeWhenCurrentIsUndefined
        ? current === undefined
        : current === sentinel.value,
    });
  }
  for (const opt of options) {
    buttons.push({
      label: opt.label,
      actionId,
      value: opt.key,
      selected: opt.key === current,
    });
  }

  // ── Text fallback (verbose: header + available list + hint) ──
  // Used when transports can't render the menu, or for text-only adapters.
  // Mirrors all menu information so users still see every option.
  const optionLines = options.map((o) => {
    const marker = o.key === current ? " (current)" : "";
    return `  \`${o.key}\` → ${o.label}${marker}`;
  });
  const textParts: string[] = [textHeader];
  if (optionLines.length > 0) {
    textParts.push("", "*Available:*", optionLines.join("\n"));
  }
  if (textHint) {
    textParts.push("", textHint);
  }

  // ── Menu caption (concise: header + hint only) ──
  // Shown next to the keyboard when the menu renders. The buttons
  // already convey the option list — don't duplicate.
  const captionParts: string[] = [textHeader];
  if (textHint) {
    captionParts.push("", textHint);
  }

  return {
    text: textParts.join("\n"),
    menuCaption: captionParts.join("\n"),
    menu: {
      sections: [{ columns, buttons }],
    },
  };
}

/**
 * Convert a RichMenu to the Chat SDK's transport-agnostic Card model.
 *
 * The Slack adapter renders this to Block Kit via cardToBlockKit;
 * Telegram's adapter renders it to inline keyboards via extractCard.
 * One conversion → many platforms — this is the v3 plan's reason for
 * dropping per-transport menu converters.
 *
 * `headerProse` is optional rendering for the prose that would otherwise
 * be the menuCaption. Cards put it inside a Section so the markdown
 * actually renders (Slack's mrkdwn is the accepted text dialect inside
 * Block Kit sections).
 */
export function richMenuToCard(menu: RichMenu, headerProse?: string): CardElement {
  const children: ReturnType<typeof Section>[] = [];
  if (headerProse) {
    children.push(Section([text(headerProse) as any]));
  }
  for (const section of menu.sections) {
    const sectionChildren: any[] = [];
    if (section.title) sectionChildren.push(text(section.title, "bold"));
    // Slack's actions block holds at most 5 elements; chunk if needed so
    // the SDK doesn't have to.
    for (const chunk of chunkArray(section.buttons, 5)) {
      sectionChildren.push(Actions(chunk.map(richButtonToButton)));
    }
    children.push(Section(sectionChildren));
  }
  return Card({ children });
}

function richButtonToButton(btn: RichButton) {
  return Button({
    id: btn.actionId,             // Slack: action_id; Telegram: callback_data
    label: btn.label,
    value: btn.value,
    ...(btn.selected ? { style: "primary" as const } : {}),
  });
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Strip markdown to a plain-text approximation for card `fallbackText`.
 * Used by transports that fall back when cards can't render — Slack's
 * notifications/mobile-previews show this string.
 *
 * Best-effort; not a proper markdown parser. Removes:
 *   `**bold**` / `*bold*` / `_italic_` / `~~strike~~` / `` `code` ``
 *   markdown links → text only
 *   leading bullet markers
 */
export function stripMarkdownToPlain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, (m) => m.slice(3, -3).replace(/^\w*\n?/, ""))   // fenced code
    .replace(/\*\*\*(.+?)\*\*\*/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "$1")
    .replace(/(?<!\w)_(?!_)(.+?)(?<!_)_(?!\w)/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[-*]{3,}$/gm, "—")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .trim();
}

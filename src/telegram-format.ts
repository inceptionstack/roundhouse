/**
 * telegram-format.ts — Convert markdown to Telegram-compatible HTML
 *
 * Telegram's Bot API supports a subset of HTML:
 *   <b>, <i>, <u>, <s>, <code>, <pre>, <a href="...">, <blockquote>
 *
 * This converter handles common agent output patterns:
 *   - Headers (#, ##, ###) → bold text
 *   - ***bold italic*** → <b><i>text</i></b>
 *   - **bold** / __bold__ → <b>
 *   - *italic* / _italic_ → <i>
 *   - ~~strikethrough~~ → <s>
 *   - `inline code` → <code>
 *   - ```code blocks``` → <pre>
 *   - [text](url) → <a href="url">text</a>  (supports parens in URLs)
 *   - Bullet/numbered lists preserved as-is
 *   - HTML entities escaped (&, <, >)
 */

import { randomBytes } from "node:crypto";

/** Escape HTML special characters */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape HTML attribute value (quotes + entities) */
function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

/**
 * Match a markdown link with balanced parentheses in the URL.
 * Returns [fullMatch, text, url, endIndex] or null.
 */
function matchLink(str: string, startIdx: number): { full: string; text: string; url: string; end: number } | null {
  if (str[startIdx] !== "[") return null;
  // Find closing ]
  const closeBracket = str.indexOf("]", startIdx + 1);
  if (closeBracket === -1 || str[closeBracket + 1] !== "(") return null;
  const text = str.slice(startIdx + 1, closeBracket);
  // Match balanced parens for URL
  let depth = 1;
  let i = closeBracket + 2;
  while (i < str.length && depth > 0) {
    if (str[i] === "(") depth++;
    else if (str[i] === ")") depth--;
    if (depth > 0) i++;
  }
  if (depth !== 0) return null;
  const url = str.slice(closeBracket + 2, i);
  return { full: str.slice(startIdx, i + 1), text, url, end: i + 1 };
}

/** Extract all markdown links with balanced-paren URL support */
function extractLinks(str: string, cb: (text: string, url: string) => string): string {
  let result = "";
  let i = 0;
  while (i < str.length) {
    if (str[i] === "[") {
      const link = matchLink(str, i);
      if (link) {
        result += cb(link.text, link.url);
        i = link.end;
        continue;
      }
    }
    result += str[i];
    i++;
  }
  return result;
}

/**
 * Truncate HTML safely — avoids cutting inside tags.
 * Finds the last '>' before the limit, or falls back to the limit itself.
 */
export function truncateHtmlSafe(html: string, limit: number): string {
  if (html.length <= limit) return html;
  const cutoff = limit - 3; // room for "..."
  // Find the last '>' at or before cutoff to avoid splitting a tag
  let safeEnd = cutoff;
  for (let i = cutoff; i >= Math.max(0, cutoff - 200); i--) {
    if (html[i] === ">") {
      safeEnd = i + 1;
      break;
    }
  }
  return html.slice(0, safeEnd) + "...";
}

/**
 * Convert markdown text to Telegram-compatible HTML.
 * Handles code blocks first (to avoid processing markdown inside them),
 * then processes inline formatting.
 */
export function markdownToTelegramHtml(md: string): string {
  // Generate unique sentinel per call to prevent spoofing
  const sentinel = randomBytes(8).toString("hex");
  const S = (kind: string, idx: number) => `\x00${sentinel}_${kind}_${idx}\x00`;
  const RE = (kind: string) => new RegExp(`\\x00${sentinel}_${kind}_(\\d+)\\x00`, "g");

  // Extract fenced code blocks first to protect their contents
  const codeBlocks: string[] = [];
  let processed = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, _lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre>${escapeHtml(code.replace(/\n$/, ""))}</pre>`);
    return S("CB", idx);
  });

  // Extract inline code to protect contents
  const inlineCodes: string[] = [];
  processed = processed.replace(/`([^`\n]+)`/g, (_match, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return S("IC", idx);
  });

  // Extract links before HTML-escaping (URLs contain &, = etc. that must be escaped once)
  const links: string[] = [];
  processed = extractLinks(processed, (text, url) => {
    const trimmedUrl = url.trim();
    if (/^https?:\/\//i.test(trimmedUrl) || /^mailto:/i.test(trimmedUrl)) {
      const idx = links.length;
      links.push(`<a href="${escapeAttr(trimmedUrl)}">${escapeHtml(text)}</a>`);
      return S("LK", idx);
    }
    // Unsafe or relative URL — render as text (will be escaped below)
    return `${text} (${trimmedUrl})`;
  });

  // Now escape HTML in the rest
  processed = escapeHtml(processed);

  // Headers: # text → <b>text</b> (Telegram has no header tags)
  processed = processed.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // Bold+italic: ***text*** → <b><i>text</i></b> (must come before ** and *)
  processed = processed.replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>");

  // Bold: **text** or __text__
  processed = processed.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  processed = processed.replace(/__(.+?)__/g, "<b>$1</b>");

  // Italic: *text* (not part of **)
  processed = processed.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
  // _text_ only at word boundaries (avoid matching snake_case)
  processed = processed.replace(/(?<!\w)_(?!_)(.+?)(?<!_)_(?!\w)/g, "<i>$1</i>");

  // Strikethrough: ~~text~~
  processed = processed.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Blockquotes: > text (after HTML escaping, > becomes &gt;)
  processed = processed.replace(/^&gt;\s?(.+)$/gm, "<blockquote>$1</blockquote>");
  // Merge adjacent blockquotes
  processed = processed.replace(/<\/blockquote>\n<blockquote>/g, "\n");

  // Horizontal rules: --- or *** or ___
  processed = processed.replace(/^[-*]{3,}$/gm, "───────────────");

  // Restore placeholders
  processed = processed.replace(RE("LK"), (_match, idx) => links[parseInt(idx, 10)]);
  processed = processed.replace(RE("IC"), (_match, idx) => inlineCodes[parseInt(idx, 10)]);
  processed = processed.replace(RE("CB"), (_match, idx) => codeBlocks[parseInt(idx, 10)]);

  return processed;
}

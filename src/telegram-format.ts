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
  if (limit <= 3) return "...";
  const cutoff = limit - 3; // room for "..."
  // Find the last '>' at or before cutoff to avoid splitting a tag
  let safeEnd = cutoff;
  for (let i = cutoff - 1; i >= Math.max(0, cutoff - 200); i--) {
    if (html[i] === ">") {
      safeEnd = i + 1;
      break;
    }
  }
  return html.slice(0, safeEnd) + "...";
}

/**
 * Convert a markdown table into a <pre>-wrapped, column-aligned monospace table.
 * Parses the header row, skips the separator row, and pads all columns to uniform width.
 */
function formatTable(tableMd: string): string {
  const lines = tableMd.trim().split("\n");
  if (lines.length < 2) return `<pre>${escapeHtml(tableMd)}</pre>`;

  // Parse rows: split by | and trim each cell
  const parseRow = (line: string): string[] =>
    line.replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());

  const headerCells = parseRow(lines[0]);
  // lines[1] is the separator row (|---|---|) — skip it
  const dataRows = lines.slice(2).map(parseRow);
  const colCount = headerCells.length;

  // Normalize rows to exactly colCount columns
  const normalize = (cells: string[]): string[] =>
    Array.from({ length: colCount }, (_, i) => cells[i] ?? "");

  const rawHeader = normalize(headerCells);
  const rawDataRows = dataRows.map(normalize);
  const allRows = [rawHeader, ...rawDataRows];

  // Display width of a single Unicode code point in a monospace font.
  // Emoji and CJK characters typically occupy 2 columns.
  const codePointWidth = (cp: number): number => {
    // Zero-width characters
    if (cp === 0x200B || cp === 0x200C || cp === 0x200D || cp === 0xFEFF) return 0;
    // Combining marks (zero-width modifiers)
    if (cp >= 0x0300 && cp <= 0x036F) return 0;  // Combining Diacritical Marks
    if (cp >= 0x1AB0 && cp <= 0x1AFF) return 0;  // Combining Diacritical Marks Extended
    if (cp >= 0x1DC0 && cp <= 0x1DFF) return 0;  // Combining Diacritical Marks Supplement
    if (cp >= 0x20D0 && cp <= 0x20FF) return 0;  // Combining Diacritical Marks for Symbols (includes U+20E3 keycap)
    if (cp >= 0xFE20 && cp <= 0xFE2F) return 0;  // Combining Half Marks
    // Variation selectors
    if (cp >= 0xFE00 && cp <= 0xFE0F) return 0;
    // Tags block (used in flag sequences etc)
    if (cp >= 0xE0001 && cp <= 0xE007F) return 0;
    // Emoji — Telegram renders these ~3 monospace columns wide in <pre> blocks
    if (cp >= 0x1F100 && cp <= 0x1FAFF) return 3;
    if (cp >= 0x231A && cp <= 0x23FF) return 3;
    if (cp >= 0x2600 && cp <= 0x27BF) return 3;
    if (cp >= 0x2B50 && cp <= 0x2B55) return 3;
    // CJK Unified Ideographs
    if (cp >= 0x3400 && cp <= 0x4DBF) return 2;
    if (cp >= 0x4E00 && cp <= 0x9FFF) return 2;
    if (cp >= 0xF900 && cp <= 0xFAFF) return 2;
    if (cp >= 0x20000 && cp <= 0x2FA1F) return 2;
    // Fullwidth forms
    if (cp >= 0xFF01 && cp <= 0xFF60) return 2;
    if (cp >= 0xFFE0 && cp <= 0xFFE6) return 2;
    // Hangul
    if (cp >= 0xAC00 && cp <= 0xD7AF) return 2;
    return 1;
  };

  // Display width of a grapheme cluster (accounts for ZWJ sequences, emoji, CJK)
  const segmenter = new Intl.Segmenter();
  const graphemeDisplayWidth = (grapheme: string): number => {
    // ZWJ emoji sequences: multiple code points but render as a single wide emoji
    if (grapheme.includes('\u200D')) return 3;
    // Single code point: use lookup
    const cps = Array.from(grapheme);
    if (cps.length === 1) return codePointWidth(cps[0].codePointAt(0)!);
    // Multi-codepoint grapheme (e.g. emoji + variation selector): width of the base
    let width = 0;
    for (const cp of cps) {
      width = Math.max(width, codePointWidth(cp.codePointAt(0)!));
    }
    return width || 1;
  };

  // Display width of a full string (sum of grapheme display widths)
  const displayWidth = (s: string): number => {
    let w = 0;
    for (const { segment } of segmenter.segment(s)) {
      w += graphemeDisplayWidth(segment);
    }
    return w;
  };

  // Calculate max *display* width for each column (on unescaped text,
  // since Telegram renders entities back to their visual form in <pre>)
  const colWidths: number[] = [];
  for (let c = 0; c < colCount; c++) {
    let max = 0;
    for (const row of allRows) {
      max = Math.max(max, displayWidth(row[c]));
    }
    colWidths.push(max);
  }

  // Pad an escaped cell so it visually aligns to `width` display columns.
  // Spaces are 1 display column each, so we add (target - actual) spaces.
  const padCell = (rawText: string, width: number): string => {
    const escaped = escapeHtml(rawText);
    const dw = displayWidth(rawText);
    return escaped + " ".repeat(Math.max(0, width - dw));
  };

  // Build formatted rows
  const formatRow = (cells: string[]): string =>
    "│ " + cells.map((cell, i) => padCell(cell, colWidths[i])).join(" │ ") + " │";

  const separator = "├─" + colWidths.map(w => "─".repeat(w)).join("─┼─") + "─┤";
  const topBorder = "┌─" + colWidths.map(w => "─".repeat(w)).join("─┬─") + "─┐";
  const bottomBorder = "└─" + colWidths.map(w => "─".repeat(w)).join("─┴─") + "─┘";

  // Cells are escaped inside padCell; box-drawing chars are HTML-safe.
  const result = [
    topBorder,
    formatRow(rawHeader),
    separator,
    ...rawDataRows.map(formatRow),
    bottomBorder,
  ].join("\n");

  return `<pre>${result}</pre>`;
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
  // (must happen before table extraction to avoid nested <pre> tags)
  const codeBlocks: string[] = [];
  let processed = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, _lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre>${escapeHtml(code.replace(/\n$/, ""))}</pre>`);
    return S("CB", idx);
  });

  // Extract markdown tables (now safe — code blocks are already sentinelled out)
  const tables: string[] = [];
  processed = processed.replace(
    /(?:^|\n)(\|.+\|\n\|[-| :]+\|\n(?:\|.+\|(?:\n|$))+)/g,
    (match) => {
      const idx = tables.length;
      const leadingNewline = match.startsWith("\n") ? "\n" : "";
      const trailingNewline = match.endsWith("\n") ? "\n" : "";
      const tableContent = match.replace(/^\n/, "").replace(/\n$/, "");
      tables.push(formatTable(tableContent));
      return leadingNewline + S("TB", idx) + trailingNewline;
    },
  );

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

  // Horizontal rules: --- or ***
  processed = processed.replace(/^[-*]{3,}$/gm, "───────────────");

  // Restore placeholders
  processed = processed.replace(RE("LK"), (_match, idx) => links[parseInt(idx, 10)]);
  processed = processed.replace(RE("IC"), (_match, idx) => inlineCodes[parseInt(idx, 10)]);
  processed = processed.replace(RE("CB"), (_match, idx) => codeBlocks[parseInt(idx, 10)]);
  processed = processed.replace(RE("TB"), (_match, idx) => tables[parseInt(idx, 10)]);

  return processed;
}

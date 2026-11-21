/**
 * telegram-format.ts — Convert markdown to Telegram-compatible HTML, and split
 * markdown into pieces whose HTML fits one Telegram message.
 *
 * Telegram's Bot API supports a subset of HTML:
 *   <b>, <i>, <u>, <s>, <code>, <pre>, <a href="...">, <blockquote>
 *
 * This converter handles common agent output patterns:
 *   - Headers (#, ##, ###) → bold text
 *   - ***bold italic*** → <b><i>text</i></b>
 *   - **bold** / __bold phrase__ → <b>
 *   - *italic* / _italic_ → <i>
 *   - ~~strikethrough~~ → <s>
 *   - `inline code` → <code>
 *   - ```code blocks``` → <pre>
 *   - [text](url) → <a href="url">text</a>  (supports parens in URLs)
 *   - Tables → a <pre> box with aligned columns
 *   - Bullet/numbered lists preserved as-is
 *   - HTML entities escaped (&, <, >)
 *
 * Emphasis follows the CommonMark delimiter rules, so `2 * 3 * 4`, `* item`
 * bullets, `snake_case` and mis-nested markers stay literal instead of
 * turning into tags. Whatever comes out is well-formed: every tag is closed
 * in the order it was opened.
 */

/** The longest text Telegram accepts in one message, in UTF-16 code units */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

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

/**
 * Truncate HTML safely — avoids cutting inside tags.
 * Finds the last '>' before the limit, or falls back to the limit itself.
 *
 * Message delivery does not use this: it drops text. Long answers are split
 * with `splitMarkdownForTelegram` instead.
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

// ── Inline formatting ─────────────────────────────────

/** A run of `*`, `_` or `~~` that may open or close emphasis */
interface Delimiter {
  type: "delim";
  ch: "*" | "_" | "~";
  /** Characters of the run not yet used by a match */
  count: number;
  /** Length of the run as written */
  length: number;
  canOpen: boolean;
  canClose: boolean;
}

type InlineNode =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: InlineNode[] }
  | { type: "tag"; tag: "b" | "i" | "s"; children: InlineNode[] }
  | Delimiter;

/** ASCII punctuation: the characters a backslash can escape */
const ESCAPABLE = /[!-/:-@[-`{-~]/;
const PUNCTUATION = /[\p{P}\p{S}]/u;
const WORD_CHAR = /[\p{L}\p{N}_]/u;
const ASCII_DIGIT = /[0-9]/;
const SAFE_URL = /^(?:https?:\/\/|mailto:)/i;
/**
 * A name wrapped in double underscores, like `__init__` or `__FILE__`.
 * Models write these far more often than they write `__bold__`, so a single
 * word in double underscores stays literal. `__two words__` is still bold.
 */
const DUNDER_NAME = /__[\p{L}\p{N}]+(?:_+[\p{L}\p{N}]+)*__(?![\p{L}\p{N}_])/uy;

/** The character before index `i`, or a space at the start of the line */
function charBefore(s: string, i: number): string {
  if (i <= 0) return " ";
  const low = s.charCodeAt(i - 1);
  if (low >= 0xdc00 && low <= 0xdfff && i >= 2) {
    const high = s.charCodeAt(i - 2);
    if (high >= 0xd800 && high <= 0xdbff) return s.slice(i - 2, i);
  }
  return s[i - 1];
}

/** The character at index `i`, or a space at the end of the line */
function charAt(s: string, i: number): string {
  return i >= s.length ? " " : String.fromCodePoint(s.codePointAt(i)!);
}

function runLength(s: string, i: number, ch: string): number {
  let n = 0;
  while (s[i + n] === ch) n++;
  return n;
}

/** Index of the next run of exactly `n` backticks at or after `from`, or -1 */
function findBacktickRun(s: string, from: number, n: number): number {
  let i = s.indexOf("`", from);
  while (i !== -1) {
    const len = runLength(s, i, "`");
    if (len === n) return i;
    i = s.indexOf("`", i + len);
  }
  return -1;
}

/**
 * Decide whether a delimiter run can open or close emphasis (CommonMark's
 * flanking rules). A delimiter needs a non-space character on its inside
 * edge, and `_` also needs a word boundary on its outside edge. Returns null
 * for a run that can do neither: it is plain text.
 */
function delimiterAt(src: string, i: number, n: number, ch: "*" | "_" | "~"): Delimiter | null {
  const prev = charBefore(src, i);
  const next = charAt(src, i + n);
  const prevSpace = /\s/.test(prev);
  const nextSpace = /\s/.test(next);
  let canOpen: boolean;
  let canClose: boolean;
  if (ch === "~") {
    canOpen = !nextSpace;
    canClose = !prevSpace;
  } else {
    const prevPunct = PUNCTUATION.test(prev);
    const nextPunct = PUNCTUATION.test(next);
    const leftFlanking = !nextSpace && (!nextPunct || prevSpace || prevPunct);
    const rightFlanking = !prevSpace && (!prevPunct || nextSpace || nextPunct);
    if (ch === "_") {
      canOpen = leftFlanking && (!rightFlanking || prevPunct);
      canClose = rightFlanking && (!leftFlanking || nextPunct);
    } else {
      // `2*3*4` and `2**10` are arithmetic, not emphasis.
      const arithmetic = ASCII_DIGIT.test(prev) && ASCII_DIGIT.test(next);
      canOpen = leftFlanking && !arithmetic;
      canClose = rightFlanking && !arithmetic;
    }
  }
  return canOpen || canClose ? { type: "delim", ch, count: n, length: n, canOpen, canClose } : null;
}

/** Text of a code span: one space of padding on each side is not part of it */
function codeSpanText(raw: string): string {
  return raw.length > 2 && raw.startsWith(" ") && raw.endsWith(" ") && raw.trim() !== "" ? raw.slice(1, -1) : raw;
}

/**
 * Parse one line of markdown into inline nodes. Code spans and links are
 * taken out first, so nothing inside them is read as formatting.
 */
function parseInline(src: string, allowLinks = true): InlineNode[] {
  const nodes: InlineNode[] = [];
  let text = "";
  const flush = () => {
    if (text) nodes.push({ type: "text", text });
    text = "";
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i];

    if (c === "\\" && i + 1 < src.length && ESCAPABLE.test(src[i + 1])) {
      text += src[i + 1];
      i += 2;
      continue;
    }

    if (c === "`") {
      const n = runLength(src, i, "`");
      const close = findBacktickRun(src, i + n, n);
      if (close === -1) {
        text += src.slice(i, i + n);
      } else {
        flush();
        nodes.push({ type: "code", text: codeSpanText(src.slice(i + n, close)) });
      }
      i = close === -1 ? i + n : close + n;
      continue;
    }

    if (c === "[" && allowLinks) {
      const link = matchLink(src, i);
      if (link) {
        flush();
        const url = link.url.trim();
        const children = parseInline(link.text, false);
        if (SAFE_URL.test(url)) {
          nodes.push({ type: "link", href: url, children });
        } else {
          // Unsafe or relative URL — render as text
          nodes.push(...children, { type: "text", text: ` (${url})` });
        }
        i = link.end;
        continue;
      }
    }

    if (c === "*" || c === "_" || c === "~") {
      const n = runLength(src, i, c);
      if (c === "_" && n === 2 && !WORD_CHAR.test(charBefore(src, i))) {
        DUNDER_NAME.lastIndex = i;
        const name = DUNDER_NAME.exec(src);
        if (name) {
          text += name[0];
          i += name[0].length;
          continue;
        }
      }
      const delimiter = c === "~" && n !== 2 ? null : delimiterAt(src, i, n, c);
      if (delimiter) {
        flush();
        nodes.push(delimiter);
      } else {
        text += src.slice(i, i + n);
      }
      i += n;
      continue;
    }

    text += c;
    i++;
  }
  flush();
  return resolveEmphasis(nodes);
}

/**
 * Pair delimiter runs into <b>, <i> and <s> nodes (CommonMark's "process
 * emphasis"). A closer takes the nearest opener of its kind; delimiters left
 * between the two stay literal, so the result is always properly nested.
 */
function resolveEmphasis(nodes: InlineNode[]): InlineNode[] {
  /** Indexes into `nodes` of delimiters that can still open */
  const openers: number[] = [];
  let k = 0;
  while (k < nodes.length) {
    const closer = nodes[k];
    if (closer.type !== "delim") {
      k++;
      continue;
    }
    let matched = false;
    if (closer.canClose) {
      for (let s = openers.length - 1; s >= 0; s--) {
        const at = openers[s];
        const opener = nodes[at] as Delimiter;
        if (opener.ch !== closer.ch) continue;
        // CommonMark's rule of three: `*a**b*` does not pair the `**` with a `*`.
        if (
          closer.ch !== "~" &&
          (opener.canClose || closer.canOpen) &&
          (opener.length + closer.length) % 3 === 0 &&
          !(opener.length % 3 === 0 && closer.length % 3 === 0)
        ) {
          continue;
        }
        // Two characters make bold, one makes italic. Odd runs on both sides
        // (`***x***`) spend one first, so italic ends up inside bold.
        const bothOdd = opener.count % 2 === 1 && closer.count % 2 === 1;
        const use = closer.ch === "~" || (opener.count >= 2 && closer.count >= 2 && !bothOdd) ? 2 : 1;
        const tag = closer.ch === "~" ? "s" : use === 2 ? "b" : "i";
        const children = nodes.slice(at + 1, k);
        opener.count -= use;
        closer.count -= use;
        const keepOpener = opener.count > 0;
        const keepCloser = closer.count > 0;
        const from = keepOpener ? at + 1 : at;
        nodes.splice(from, k - from + (keepCloser ? 0 : 1), { type: "tag", tag, children });
        openers.length = keepOpener ? s + 1 : s;
        // A closer with characters left is looked at again; it now sits right after the new tag.
        k = from + 1;
        matched = true;
        break;
      }
    }
    if (!matched) {
      if (closer.canOpen) openers.push(k);
      k++;
    }
  }
  return nodes;
}

/**
 * Render inline nodes as Telegram HTML.
 *
 * `open` holds the tags already open around these nodes, so `# **Title**`
 * does not nest <b> in <b>. With `footnotes`, a link renders as its text only
 * and its <a> tag is collected there: Telegram ignores links inside <pre>.
 */
function renderInlineNodes(nodes: InlineNode[], open: ReadonlySet<string>, footnotes?: string[]): string {
  let html = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        html += escapeHtml(node.text);
        break;
      case "delim":
        html += escapeHtml(node.ch.repeat(node.count));
        break;
      case "code":
        html += `<code>${escapeHtml(node.text)}</code>`;
        break;
      case "link": {
        const inner = renderInlineNodes(node.children, open) || escapeHtml(node.href);
        const anchor = `<a href="${escapeAttr(node.href)}">${inner}</a>`;
        if (footnotes) {
          if (!footnotes.includes(anchor)) footnotes.push(anchor);
          html += inner;
        } else {
          html += anchor;
        }
        break;
      }
      case "tag": {
        if (open.has(node.tag)) {
          html += renderInlineNodes(node.children, open, footnotes);
        } else {
          const inner = renderInlineNodes(node.children, new Set(open).add(node.tag), footnotes);
          html += `<${node.tag}>${inner}</${node.tag}>`;
        }
        break;
      }
    }
  }
  return html;
}

/** The text a reader sees for these nodes, without any markup */
function inlineText(nodes: InlineNode[]): string {
  let text = "";
  for (const node of nodes) {
    if (node.type === "text" || node.type === "code") text += node.text;
    else if (node.type === "delim") text += node.ch.repeat(node.count);
    else text += inlineText(node.children);
  }
  return text;
}

const NO_OPEN_TAGS: ReadonlySet<string> = new Set();
const INSIDE_BOLD: ReadonlySet<string> = new Set(["b"]);

/** Render one line that is not part of a code block or a table */
function renderTextLine(line: string): string {
  // Horizontal rules: --- or ***
  if (/^[-*]{3,}$/.test(line)) return "───────────────";

  // Headers: # text → <b>text</b> (Telegram has no header tags)
  const header = /^#{1,6}\s+(.+)$/.exec(line);
  if (header) return `<b>${renderInlineNodes(parseInline(header[1]), INSIDE_BOLD)}</b>`;

  // Blockquotes: > text
  const quote = /^>\s?(.+)$/.exec(line);
  if (quote) return `<blockquote>${renderInlineNodes(parseInline(quote[1]), NO_OPEN_TAGS)}</blockquote>`;

  return renderInlineNodes(parseInline(line), NO_OPEN_TAGS);
}

// ── Tables ────────────────────────────────────────────

/**
 * Split a table row into trimmed cells. A `|` inside inline code or after a
 * backslash belongs to the cell.
 */
function splitTableRow(line: string): string[] {
  const row = line.replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let start = 0;
  let i = 0;
  while (i < row.length) {
    const c = row[i];
    if (c === "\\" && i + 1 < row.length) {
      i += 2;
    } else if (c === "`") {
      const n = runLength(row, i, "`");
      const close = findBacktickRun(row, i + n, n);
      i = close === -1 ? i + n : close + n;
    } else if (c === "|") {
      cells.push(row.slice(start, i).trim());
      start = ++i;
    } else {
      i++;
    }
  }
  cells.push(row.slice(start).trim());
  return cells;
}

/**
 * Convert a markdown table into a <pre>-wrapped, column-aligned monospace table.
 * `lines` are the header row, the separator row and the data rows. All columns
 * are padded to a uniform width.
 *
 * Cells get inline formatting: the markers are gone and the text is tagged.
 * Telegram does not show bold, italics or links inside <pre>, so a cell reads
 * as clean text, and each link is repeated under the table where it works.
 */
function formatTable(lines: string[]): string {
  const headerCells = splitTableRow(lines[0]);
  // lines[1] is the separator row (|---|---|) — skip it
  const dataRows = lines.slice(2).map(splitTableRow);
  const colCount = headerCells.length;

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
    // Emoji — standard 2-column width (Telegram renders slightly wider but
    // fractional widths can't be fixed with integer padding; 2 is closest)
    if (cp >= 0x1F100 && cp <= 0x1FAFF) return 2;
    if (cp >= 0x231A && cp <= 0x23FF) return 2;
    if (cp >= 0x2600 && cp <= 0x27BF) return 2;
    if (cp >= 0x2B50 && cp <= 0x2B55) return 2;
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
    if (grapheme.includes('\u200D')) return 2;
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

  /** Links found in cells, as <a> tags, in order of appearance */
  const links: string[] = [];

  // A cell as it is emitted, with the display width of what the reader sees
  // (Telegram renders entities back to their visual form in <pre>).
  const toCell = (raw: string): { html: string; width: number } => {
    const nodes = parseInline(raw);
    return { html: renderInlineNodes(nodes, NO_OPEN_TAGS, links), width: displayWidth(inlineText(nodes)) };
  };

  // Normalize rows to exactly colCount columns
  const normalize = (cells: string[]) =>
    Array.from({ length: colCount }, (_, i) => toCell(cells[i] ?? ""));

  const header = normalize(headerCells);
  const body = dataRows.map(normalize);
  const allRows = [header, ...body];

  // Calculate max *display* width for each column
  const colWidths: number[] = [];
  for (let c = 0; c < colCount; c++) {
    let max = 0;
    for (const row of allRows) {
      max = Math.max(max, row[c].width);
    }
    colWidths.push(max);
  }

  // Pad a cell so it visually aligns to `width` display columns.
  // Spaces are 1 display column each, so we add (target - actual) spaces.
  const padCell = (cell: { html: string; width: number }, width: number): string =>
    cell.html + " ".repeat(Math.max(0, width - cell.width));

  // Build formatted rows
  const formatRow = (cells: Array<{ html: string; width: number }>): string =>
    "│ " + cells.map((cell, i) => padCell(cell, colWidths[i])).join(" │ ") + " │";

  const separator = "├─" + colWidths.map(w => "─".repeat(w)).join("─┼─") + "─┤";
  const topBorder = "┌─" + colWidths.map(w => "─".repeat(w)).join("─┬─") + "─┐";
  const bottomBorder = "└─" + colWidths.map(w => "─".repeat(w)).join("─┴─") + "─┘";

  // Cells are escaped when rendered; box-drawing chars are HTML-safe.
  const result = [
    topBorder,
    formatRow(header),
    separator,
    ...body.map(formatRow),
    bottomBorder,
  ].join("\n");

  return [`<pre>${result}</pre>`, ...links].join("\n");
}

// ── Block structure ───────────────────────────────────

/** An opening code fence */
interface Fence {
  /** The opening line as written, e.g. "```ts" */
  line: string;
  indent: string;
  /** Number of backticks */
  ticks: number;
}

interface TableHead {
  head: string;
  sep: string;
}

type LineKind = "text" | "fence-open" | "fence-body" | "fence-close" | "table-head" | "table-sep" | "table-row";

interface Line {
  /** Offset of the first character */
  start: number;
  /** Offset of the line's newline, or the end of the text */
  end: number;
  text: string;
  kind: LineKind;
  /** The fence this line opens, sits in or closes */
  fence?: Fence;
  /** The table this line belongs to */
  table?: TableHead;
}

/**
 * A fence line longer than this is ordinary text. It keeps the line that
 * reopens a split code block short next to the message limit.
 */
const MAX_FENCE_LINE = 200;
const FENCE_OPEN = /^([ \t]*)(`{3,})[^`]*$/;
const FENCE_CLOSE = /^[ \t]*(`{3,})\s*$/;
const TABLE_ROW = /^\|.+\|$/;
const TABLE_SEPARATOR = /^\|[-| :]+\|$/;

function matchFenceOpen(line: string): Fence | null {
  if (line.length > MAX_FENCE_LINE) return null;
  const m = FENCE_OPEN.exec(line);
  return m ? { line, indent: m[1], ticks: m[2].length } : null;
}

function isFenceClose(line: string, fence: Fence): boolean {
  if (line.length > MAX_FENCE_LINE) return false;
  const m = FENCE_CLOSE.exec(line);
  return m !== null && m[1].length >= fence.ticks;
}

/**
 * Split markdown into lines and say what each one is. This is the one place
 * that decides where code blocks and tables start and end; the converter and
 * the splitter both read it, so they cannot disagree.
 *
 * A code block opens on a line of three or more backticks (after optional
 * indentation, followed by an optional info string) and closes on a line of
 * at least as many backticks and nothing else. One that is never closed runs
 * to the end of the text.
 */
function scanLines(md: string): Line[] {
  const lines: Line[] = [];
  for (let start = 0; ; ) {
    const newline = md.indexOf("\n", start);
    const end = newline === -1 ? md.length : newline;
    lines.push({ start, end, text: md.slice(start, end), kind: "text" });
    if (newline === -1) break;
    start = newline + 1;
  }

  let fence: Fence | null = null;
  let table: TableHead | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      line.fence = fence;
      line.kind = isFenceClose(line.text, fence) ? "fence-close" : "fence-body";
      if (line.kind === "fence-close") fence = null;
      continue;
    }
    fence = matchFenceOpen(line.text);
    if (fence) {
      line.kind = "fence-open";
      line.fence = fence;
      table = null;
      continue;
    }
    if (table && TABLE_ROW.test(line.text)) {
      line.kind = "table-row";
      line.table = table;
      continue;
    }
    table = null;
    // A table is a header row, a separator row and at least one data row.
    if (
      i + 2 < lines.length &&
      TABLE_ROW.test(line.text) &&
      TABLE_SEPARATOR.test(lines[i + 1].text) &&
      TABLE_ROW.test(lines[i + 2].text)
    ) {
      table = { head: line.text, sep: lines[i + 1].text };
      line.kind = "table-head";
      line.table = table;
      lines[i + 1].kind = "table-sep";
      lines[i + 1].table = table;
      i++;
    }
  }
  return lines;
}

/**
 * Convert markdown text to Telegram-compatible HTML.
 * Code blocks and tables are handled as blocks, so markdown inside them is
 * never processed; every other line gets inline formatting.
 */
export function markdownToTelegramHtml(md: string): string {
  const lines = scanLines(md);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.kind === "fence-open") {
      const code: string[] = [];
      let j = i + 1;
      while (j < lines.length && lines[j].kind === "fence-body") {
        code.push(lines[j].text);
        j++;
      }
      const closed = j < lines.length;
      // An open block that ends with a newline has no last empty line yet.
      if (!closed && code.length > 0 && code[code.length - 1] === "") code.pop();
      out.push(`<pre>${escapeHtml(code.join("\n"))}</pre>`);
      i = closed ? j + 1 : j;
      continue;
    }

    if (line.kind === "table-head") {
      let j = i;
      while (j < lines.length && lines[j].table === line.table) j++;
      out.push(formatTable(lines.slice(i, j).map((l) => l.text)));
      i = j;
      continue;
    }

    out.push(renderTextLine(line.text));
    i++;
  }

  // Merge adjacent blockquotes
  return out.join("\n").replace(/<\/blockquote>\n<blockquote>/g, "\n");
}

// ── Splitting ─────────────────────────────────────────

/** One message's worth of markdown */
export interface MarkdownChunk {
  /** Where this chunk's source starts in the text given to the splitter */
  start: number;
  /** Where it ends. Chunks follow each other without gaps or overlaps. */
  end: number;
  /**
   * Lines the splitter put before the source: the fence that reopens a code
   * block, or the header of a table, that the previous chunk ended inside.
   * Empty when the chunk starts outside both. The first chunk has the prefix
   * the caller passed in.
   */
  prefix: string;
  /** The fence the splitter put after the source to close a code block, or "" */
  suffix: string;
  /** `prefix + source + suffix`: the markdown `html` was rendered from */
  text: string;
  /** `text` as Telegram HTML, no longer than the limit */
  html: string;
}

/** The first chunk of a text, as returned by `takeMarkdownChunk` */
export interface TakenChunk {
  /** How many characters of the body this chunk covers */
  length: number;
  prefix: string;
  suffix: string;
  text: string;
  html: string;
  /** The prefix the text after this chunk needs */
  nextPrefix: string;
}

/** What surrounds a position: the code block or table it is inside, if any */
interface BlockContext {
  fence?: Fence;
  table?: TableHead;
}

/** The line that contains `offset` (the later one, at a line start) */
function lineIndexAt(lines: Line[], offset: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lines[mid].start <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The block a cut at `offset` would fall inside */
function contextAt(lines: Line[], offset: number): BlockContext {
  const line = lines[lineIndexAt(lines, offset)];
  if (offset === line.start) {
    if (line.kind === "fence-body" || line.kind === "fence-close") return { fence: line.fence };
    if (line.kind === "table-row") return { table: line.table };
    return {};
  }
  if (line.kind === "fence-open" || line.kind === "fence-body") return { fence: line.fence };
  return {};
}

function contextPrefix(context: BlockContext): string {
  if (context.fence) return `${context.fence.line}\n`;
  if (context.table) return `${context.table.head}\n${context.table.sep}\n`;
  return "";
}

/**
 * True for a line start that makes a poor place to cut: it would leave an
 * empty code block or a table header without rows on one side.
 */
function isAwkwardCut(lines: Line[], index: number, base: number): boolean {
  const line = lines[index];
  const before = lines[index - 1];
  if (line.kind === "fence-close" || line.kind === "table-sep") return true;
  if (before.start < base) return false;
  return before.kind === "fence-open" || before.kind === "table-sep";
}

/** A line start that the converter reads as a quote, a header or a rule */
const BLOCK_MARKER = /^(?:>|#{1,6}\s|[-*]{3,}$)/;

/** How far a cut inside a line may move back to avoid changing what the rest means */
const MAX_CUT_BACKOFF = 64;

function isSurrogatePairAt(s: string, i: number): boolean {
  if (i <= 0 || i >= s.length) return false;
  const high = s.charCodeAt(i - 1);
  const low = s.charCodeAt(i);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

/**
 * Take the first message's worth of `body`.
 *
 * `prefix` is what the body continues from: "" at the start of a text,
 * otherwise the `nextPrefix` of the chunk before it (or the prefix from
 * `resumeMarkdownAt`). It is rendered in front of the body and counts
 * towards the limit. The chunk ends at the
 * last line break whose rendered HTML still fits `limit`, so nothing is
 * truncated and the rest starts on a new line. Its markdown source fits the
 * limit too, since that is what is sent when Telegram refuses the HTML.
 *
 * A chunk that ends inside a code block gets a closing fence, and the rest
 * reopens the block with the same opening line. A chunk that ends inside a
 * table makes the rest repeat the table's header.
 *
 * A single line too long for one message is cut inside the line, at a space
 * if there is one, and never between the halves of a surrogate pair.
 */
export function takeMarkdownChunk(prefix: string, body: string, limit = TELEGRAM_MESSAGE_LIMIT): TakenChunk {
  // Look no further than one message can reach, plus the lines needed to
  // tell what the last line in reach is.
  let reach = body.length;
  if (body.length > limit) {
    reach = limit;
    for (let n = 0; n < 3 && reach < body.length; n++) {
      const newline = body.indexOf("\n", reach);
      reach = newline === -1 ? body.length : newline + 1;
    }
  }
  const doc = prefix + body.slice(0, reach);
  const base = prefix.length;
  const lines = scanLines(doc);

  /** The chunk that ends at `end`, or null if it does not fit (unless forced) */
  const chunkTo = (end: number, force = false): TakenChunk | null => {
    const context = contextAt(lines, end);
    const fence = context.fence;
    const suffix = fence ? (doc[end - 1] === "\n" ? "" : "\n") + fence.indent + "`".repeat(fence.ticks) : "";
    const text = doc.slice(0, end) + suffix;
    if (text.length > limit && !force) return null;
    const html = markdownToTelegramHtml(text);
    if (html.length > limit && !force) return null;
    return { length: end - base, prefix, suffix, text, html, nextPrefix: contextPrefix(context) };
  };

  if (reach === body.length) {
    const whole = chunkTo(doc.length);
    if (whole) return whole;
  }

  // Cut at a line break: the last one that fits.
  const first = lineIndexAt(lines, base);
  let lo = first + 1;
  let hi = lines.length - 1;
  let best = -1;
  let bestChunk: TakenChunk | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const chunk = chunkTo(lines[mid].start);
    if (chunk) {
      best = mid;
      bestChunk = chunk;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (bestChunk) {
    for (let index = best; index > first && index > best - 4; index--) {
      if (isAwkwardCut(lines, index, base)) continue;
      const chunk = index === best ? bestChunk : chunkTo(lines[index].start);
      if (chunk) return chunk;
    }
    return bestChunk;
  }

  // The first line alone is too long: cut inside it.
  const line = lines[first];
  let cut = -1;
  lo = base + 1;
  hi = Math.min(line.end, base + limit);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (chunkTo(mid)) {
      cut = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (cut === -1) {
    // Not even one character fits beside the prefix. Move forward anyway.
    cut = base + 1;
  } else if (cut < line.end) {
    for (let at = cut; at > base + ((cut - base) >> 1); at--) {
      if (doc[at - 1] === " " || doc[at - 1] === "\t") {
        cut = at;
        break;
      }
    }
  }

  // The rest of the line starts the next message. Back off a little if it
  // would mean something there that it does not mean here: a fence, or a
  // block marker that would swallow its first characters.
  const fence = line.kind === "fence-body" ? line.fence! : null;
  const changesMeaning = (at: number): boolean => {
    if (line.kind === "fence-open" || line.kind === "fence-close") return false;
    const head = doc.slice(line.start, at);
    const tail = doc.slice(at, line.end);
    if (fence) return isFenceClose(head, fence) || isFenceClose(tail, fence);
    return matchFenceOpen(head) !== null || matchFenceOpen(tail) !== null || BLOCK_MARKER.test(tail);
  };
  const unsafe = (at: number) => isSurrogatePairAt(doc, at) || changesMeaning(at);
  const preferred = cut;
  for (let n = 0; n < MAX_CUT_BACKOFF && cut > base + 1 && unsafe(cut); n++) cut--;
  if (unsafe(cut)) {
    cut = preferred;
    if (isSurrogatePairAt(doc, cut)) cut += cut > base + 1 ? -1 : 1;
  }

  return chunkTo(cut, true)!;
}

/**
 * Split markdown into chunks that each render to at most `limit` characters
 * of Telegram HTML. Nothing is dropped: the chunks' source ranges cover the
 * text exactly, and a code block or table that spans chunks is reopened in
 * each one (see `MarkdownChunk.prefix` and `suffix`).
 *
 * `prefix` is for text that continues from something already delivered: the
 * `nextPrefix` of an earlier chunk, or what `resumeMarkdownAt` returned.
 */
export function splitMarkdownForTelegram(
  markdown: string,
  limit = TELEGRAM_MESSAGE_LIMIT,
  prefix = "",
): MarkdownChunk[] {
  const chunks: MarkdownChunk[] = [];
  let pos = 0;
  while (pos < markdown.length) {
    const taken = takeMarkdownChunk(prefix, markdown.slice(pos), limit);
    chunks.push({
      start: pos,
      end: pos + taken.length,
      prefix: taken.prefix,
      suffix: taken.suffix,
      text: taken.text,
      html: taken.html,
    });
    pos += taken.length;
    prefix = taken.nextPrefix;
  }
  return chunks;
}

/**
 * Find where to continue a text that was delivered only up to `offset`.
 *
 * `prefix` and `body` are as in `takeMarkdownChunk`. Returns the offset to
 * continue from and the prefix that text needs, for `splitMarkdownForTelegram`.
 * Usually that is `offset` itself, with the fence or table header of the
 * block it is in. The exceptions keep the rest from being misread:
 *   - Inside an opening fence line: continue after the line; the prefix
 *     reopens the block.
 *   - At or inside a closing fence line: continue after the line.
 *   - Inside a line whose remainder would read as a quote, a header, a rule
 *     or a fence: the prefix is a backslash, which keeps it literal.
 *   - Inside a code line whose remainder would read as the closing fence:
 *     continue a few characters earlier, repeating them.
 */
export function resumeMarkdownAt(prefix: string, body: string, offset: number): { offset: number; prefix: string } {
  const doc = prefix + body;
  const lines = scanLines(doc);
  const at = prefix.length + offset;
  const line = lines[lineIndexAt(lines, at)];
  const afterLine = Math.min(line.end + 1, doc.length) - prefix.length;
  if (line.kind === "fence-close") return { offset: afterLine, prefix: "" };
  if (line.kind === "fence-open" && at > line.start) return { offset: afterLine, prefix: `${line.fence!.line}\n` };
  const context = contextAt(lines, at);
  if (at > line.start) {
    if (context.fence) {
      // The whole line is not a closing fence, so this stops at its start at the latest.
      let from = at;
      while (isFenceClose(doc.slice(from, line.end), context.fence)) from--;
      return { offset: from - prefix.length, prefix: contextPrefix(context) };
    }
    const rest = doc.slice(at, line.end);
    if (matchFenceOpen(rest) !== null || BLOCK_MARKER.test(rest)) return { offset, prefix: "\\" };
  }
  return { offset, prefix: contextPrefix(context) };
}

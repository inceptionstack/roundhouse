/**
 * telegram-format.ts — Convert markdown to Telegram-compatible HTML
 *
 * Telegram's Bot API supports a subset of HTML:
 *   <b>, <i>, <u>, <s>, <code>, <pre>, <a href="...">, <blockquote>
 *
 * This converter handles common agent output patterns:
 *   - Headers (#, ##, ###) → bold text
 *   - **bold** / __bold__ → <b>
 *   - *italic* / _italic_ → <i>
 *   - ~~strikethrough~~ → <s>
 *   - `inline code` → <code>
 *   - ```code blocks``` → <pre>
 *   - [text](url) → <a href="url">text</a>
 *   - Bullet/numbered lists preserved as-is (Telegram renders them fine as text)
 *   - HTML entities escaped (&, <, >)
 */

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
 * Convert markdown text to Telegram-compatible HTML.
 * Handles code blocks first (to avoid processing markdown inside them),
 * then processes inline formatting.
 */
export function markdownToTelegramHtml(md: string): string {
  // Extract fenced code blocks first to protect their contents
  const codeBlocks: string[] = [];
  let processed = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, _lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre>${escapeHtml(code.replace(/\n$/, ""))}</pre>`);
    return `\x00CODEBLOCK_${idx}\x00`;
  });

  // Extract inline code to protect contents
  const inlineCodes: string[] = [];
  processed = processed.replace(/`([^`\n]+)`/g, (_match, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00INLINE_${idx}\x00`;
  });

  // Extract links before HTML-escaping (URLs contain &, = etc. that must be escaped once)
  const links: string[] = [];
  processed = processed.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, url) => {
    const idx = links.length;
    const trimmedUrl = url.trim();
    if (/^https?:\/\//i.test(trimmedUrl) || /^mailto:/i.test(trimmedUrl)) {
      links.push(`<a href="${escapeAttr(trimmedUrl)}">${escapeHtml(text)}</a>`);
    } else {
      // Unsafe or relative URL — render as text (will be escaped below)
      links.push(`LINKTEXT_${idx}`);
      return `${text} (${trimmedUrl})`;
    }
    return `\x00LINK_${idx}\x00`;
  });

  // Now escape HTML in the rest
  processed = escapeHtml(processed);

  // Headers: # text → <b>text</b> (Telegram has no header tags)
  processed = processed.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

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

  // Horizontal rules: --- or *** or ___ (after escaping, underscores may be in tags)
  processed = processed.replace(/^[-*]{3,}$/gm, "───────────────");

  // Restore links
  processed = processed.replace(/\x00LINK_(\d+)\x00/g, (_match, idx) => links[parseInt(idx, 10)]);

  // Restore inline code
  processed = processed.replace(/\x00INLINE_(\d+)\x00/g, (_match, idx) => inlineCodes[parseInt(idx, 10)]);

  // Restore code blocks
  processed = processed.replace(/\x00CODEBLOCK_(\d+)\x00/g, (_match, idx) => codeBlocks[parseInt(idx, 10)]);

  return processed;
}

import { describe, it, expect } from "vitest";
import { markdownToTelegramHtml, truncateHtmlSafe } from "../src/telegram-format";

describe("markdownToTelegramHtml", () => {
  it("escapes HTML entities", () => {
    expect(markdownToTelegramHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });

  it("converts headers to bold", () => {
    expect(markdownToTelegramHtml("# Title")).toBe("<b>Title</b>");
    expect(markdownToTelegramHtml("## Subtitle")).toBe("<b>Subtitle</b>");
    expect(markdownToTelegramHtml("### H3")).toBe("<b>H3</b>");
  });

  it("converts **bold**", () => {
    expect(markdownToTelegramHtml("hello **world**")).toBe("hello <b>world</b>");
  });

  it("converts __bold__", () => {
    expect(markdownToTelegramHtml("hello __world__")).toBe("hello <b>world</b>");
  });

  it("converts *italic*", () => {
    expect(markdownToTelegramHtml("hello *world*")).toBe("hello <i>world</i>");
  });

  it("converts ***bold italic*** with proper nesting", () => {
    expect(markdownToTelegramHtml("***Important***")).toBe("<b><i>Important</i></b>");
  });

  it("converts ~~strikethrough~~", () => {
    expect(markdownToTelegramHtml("hello ~~world~~")).toBe("hello <s>world</s>");
  });

  it("converts inline code", () => {
    expect(markdownToTelegramHtml("use `foo()`")).toBe("use <code>foo()</code>");
  });

  it("escapes HTML inside inline code", () => {
    expect(markdownToTelegramHtml("use `a<b>c`")).toBe("use <code>a&lt;b&gt;c</code>");
  });

  it("converts fenced code blocks", () => {
    const md = "```js\nconst x = 1;\n```";
    expect(markdownToTelegramHtml(md)).toBe("<pre>const x = 1;</pre>");
  });

  it("escapes HTML inside code blocks", () => {
    const md = "```\n<div>hello</div>\n```";
    expect(markdownToTelegramHtml(md)).toBe("<pre>&lt;div&gt;hello&lt;/div&gt;</pre>");
  });

  it("converts safe links", () => {
    expect(markdownToTelegramHtml("[click](https://example.com)"))
      .toBe('<a href="https://example.com">click</a>');
  });

  it("escapes link URL attributes", () => {
    expect(markdownToTelegramHtml('[click](https://example.com/a?b=1&c="2")'))
      .toBe('<a href="https://example.com/a?b=1&amp;c=&quot;2&quot;">click</a>');
  });

  it("rejects unsafe link schemes", () => {
    expect(markdownToTelegramHtml("[click](javascript:alert(1))"))
      .toBe("click (javascript:alert(1))");
  });

  it("allows mailto links", () => {
    expect(markdownToTelegramHtml("[email](mailto:a@b.com)"))
      .toBe('<a href="mailto:a@b.com">email</a>');
  });

  it("handles URLs with balanced parentheses (Wikipedia)", () => {
    const md = "[Test](https://en.wikipedia.org/wiki/Test_(page))";
    expect(markdownToTelegramHtml(md))
      .toBe('<a href="https://en.wikipedia.org/wiki/Test_(page)">Test</a>');
  });

  it("handles URLs with nested parentheses", () => {
    const md = "[link](https://example.com/a(b(c)))";
    expect(markdownToTelegramHtml(md))
      .toBe('<a href="https://example.com/a(b(c))">link</a>');
  });

  it("converts blockquotes", () => {
    expect(markdownToTelegramHtml("> quoted text"))
      .toBe("<blockquote>quoted text</blockquote>");
  });

  it("merges adjacent blockquotes", () => {
    const md = "> line1\n> line2";
    const html = markdownToTelegramHtml(md);
    expect(html).toBe("<blockquote>line1\nline2</blockquote>");
  });

  it("converts horizontal rules", () => {
    expect(markdownToTelegramHtml("---")).toBe("───────────────");
    expect(markdownToTelegramHtml("***")).toBe("───────────────");
  });

  it("does not convert snake_case to italic", () => {
    expect(markdownToTelegramHtml("file_name_here")).toBe("file_name_here");
  });

  it("handles mixed formatting", () => {
    const md = "# Report\n\n**Status**: _running_\n\n- item 1\n- item 2\n\n```\ncode\n```";
    const html = markdownToTelegramHtml(md);
    expect(html).toContain("<b>Report</b>");
    expect(html).toContain("<b>Status</b>");
    expect(html).toContain("<i>running</i>");
    expect(html).toContain("- item 1");
    expect(html).toContain("<pre>code</pre>");
  });

  it("preserves bullet lists as-is", () => {
    const md = "- one\n- two\n- three";
    const html = markdownToTelegramHtml(md);
    expect(html).toContain("- one");
    expect(html).toContain("- two");
  });

  it("preserves numbered lists as-is", () => {
    const md = "1. one\n2. two";
    const html = markdownToTelegramHtml(md);
    expect(html).toContain("1. one");
    expect(html).toContain("2. two");
  });

  it("converts simple markdown table to aligned monospace", () => {
    const md = "| Feature | Status |\n|---------|--------|\n| Bold | ✅ |\n| Code | ✅ |";
    const html = markdownToTelegramHtml(md);
    // Should be wrapped in <pre> for monospace alignment
    expect(html).toContain("<pre>");
    expect(html).toContain("</pre>");
    // Should contain the data rows
    expect(html).toContain("Feature");
    expect(html).toContain("Bold");
    expect(html).toContain("✅");
    // Should NOT contain the raw separator row (---|---)
    expect(html).not.toMatch(/\|-+\|/);
  });

  it("converts table with header and alignment row into formatted output", () => {
    const md = "| Name | Value | Notes |\n|------|-------|-------|\n| a | 1 | good |\n| bb | 22 | ok |";
    const html = markdownToTelegramHtml(md);
    expect(html).toContain("<pre>");
    // Columns should be padded/aligned
    expect(html).toContain("Name");
    expect(html).toContain("Value");
    expect(html).toContain("Notes");
  });

  it("pads table columns to uniform width", () => {
    const md = "| A | BB |\n|---|---|\n| x | yy |";
    const html = markdownToTelegramHtml(md);
    // Extract the text inside <pre>...</pre>
    const preMatch = html.match(/<pre>([\s\S]*?)<\/pre>/);
    expect(preMatch).not.toBeNull();
    const preContent = preMatch![1];
    // Lines: top border, header, separator, data row, bottom border
    const lines = preContent.split("\n").filter(l => l.trim());
    expect(lines.length).toBe(5);
    // The header (line 1) and data row (line 3) should have the same length (padded)
    expect(lines[1].length).toBe(lines[3].length);
  });

  it("aligns columns correctly when cells contain HTML special characters", () => {
    const md = "| Name | Value |\n|------|-------|\n| a&b | ok |\n| x | <y> |";
    const html = markdownToTelegramHtml(md);
    const preMatch = html.match(/<pre>([\s\S]*?)<\/pre>/);
    expect(preMatch).not.toBeNull();
    const preContent = preMatch![1];
    // Entities should be present in raw HTML
    expect(preContent).toContain("&amp;");
    expect(preContent).toContain("&lt;");
    // Decode entities to get visual text, then check visual alignment
    const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
    const lines = preContent.split("\n").filter(l => l.trim());
    const visualLines = lines.map(decode);
    // All data/header rows (lines 1, 3, 4) should have the same *visual* length
    expect(visualLines[1].length).toBe(visualLines[3].length);
    expect(visualLines[1].length).toBe(visualLines[4].length);
    // Borders should also match
    expect(visualLines[0].length).toBe(visualLines[1].length);
  });

  it("handles data rows with fewer columns than header", () => {
    const md = "| A | B | C |\n|---|---|---|\n| 1 |\n| x | y | z |";
    const html = markdownToTelegramHtml(md);
    const preMatch = html.match(/<pre>([\s\S]*?)<\/pre>/);
    expect(preMatch).not.toBeNull();
    const preContent = preMatch![1];
    const lines = preContent.split("\n").filter(l => l.trim());
    // All rows (header + 2 data + borders) should have the same length
    expect(lines[1].length).toBe(lines[3].length); // header vs short row
    expect(lines[1].length).toBe(lines[4].length); // header vs full row
  });

  it("handles data rows with more columns than header", () => {
    const md = "| A | B |\n|---|---|\n| 1 | 2 | 3 | extra |";
    const html = markdownToTelegramHtml(md);
    const preMatch = html.match(/<pre>([\s\S]*?)<\/pre>/);
    expect(preMatch).not.toBeNull();
    const preContent = preMatch![1];
    const lines = preContent.split("\n").filter(l => l.trim());
    // All rows should have the same length (extra columns dropped)
    expect(lines[1].length).toBe(lines[3].length);
  });

  it("aligns columns correctly with ZWJ emoji sequences", () => {
    const md = "| Name | Icon |\n|------|------|\n| fam | \u{1F468}\u200D\u{1F469}\u200D\u{1F467} |\n| hi | x |";
    const html = markdownToTelegramHtml(md);
    const preMatch = html.match(/<pre>([\s\S]*?)<\/pre>/);
    expect(preMatch).not.toBeNull();
    const preContent = preMatch![1];
    // Decode entities for visual check
    const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    const lines = preContent.split("\n").filter(l => l.trim());
    const visualLines = lines.map(decode);
    // Use Intl.Segmenter to count what we expect
    const seg = new Intl.Segmenter();
    const graphemeLen = (s: string) => [...seg.segment(s)].length;
    // Header and both data rows should have the same visual (grapheme) length
    expect(graphemeLen(visualLines[1])).toBe(graphemeLen(visualLines[3]));
    expect(graphemeLen(visualLines[1])).toBe(graphemeLen(visualLines[4]));
  });

  it("preserves newline between table and following text when no blank line", () => {
    const md = "before\n| A | B |\n|---|---|\n| 1 | 2 |\nafter";
    const html = markdownToTelegramHtml(md);
    // The table and "after" should be separated by a newline, not jammed together
    expect(html).toContain("</pre>\nafter");
    expect(html).not.toContain("</pre>after");
  });

  it("preserves table surrounded by other content", () => {
    const md = "Some text\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nMore text";
    const html = markdownToTelegramHtml(md);
    expect(html).toContain("Some text");
    expect(html).toContain("More text");
    expect(html).toContain("<pre>");
  });

  it("does not convert tables inside fenced code blocks", () => {
    const md = "```\n| A | B |\n|---|---|\n| 1 | 2 |\n```";
    const html = markdownToTelegramHtml(md);
    // Should be a single <pre> block with raw pipe characters, not nested <pre><pre>
    expect(html).not.toContain("<pre><pre>");
    expect(html).not.toContain("</pre></pre>");
    // The table should remain as raw text inside the code block
    expect(html).toContain("| A | B |");
    const preCount = (html.match(/<pre>/g) || []).length;
    expect(preCount).toBe(1);
  });

  it("converts table outside code block but not table inside", () => {
    const md = "| X | Y |\n|---|---|\n| 1 | 2 |\n\n```\n| A | B |\n|---|---|\n| 3 | 4 |\n```";
    const html = markdownToTelegramHtml(md);
    // Two <pre> blocks: one for the rendered table, one for the code block
    const preCount = (html.match(/<pre>/g) || []).length;
    expect(preCount).toBe(2);
    // The code block should have raw pipes
    expect(html).toContain("| A | B |");
    // The real table should have box-drawing chars
    expect(html).toContain("\u2502 X");
    // No nesting
    expect(html).not.toContain("<pre><pre>");
  });

  it("does not confuse sentinel-like input with real placeholders", () => {
    // Input that looks like our internal placeholder format should not be replaced
    const md = "text with \\x00 bytes";
    const html = markdownToTelegramHtml(md);
    expect(html).not.toContain("undefined");
  });
});

describe("truncateHtmlSafe", () => {
  it("returns short html unchanged", () => {
    expect(truncateHtmlSafe("<b>hello</b>", 100)).toBe("<b>hello</b>");
  });

  it("truncates at last > before limit", () => {
    const html = "<b>hello</b> <i>world</i> more text here that is very long";
    const result = truncateHtmlSafe(html, 30);
    expect(result.endsWith("...")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(30);
    // Should not cut inside a tag
    expect(result).not.toMatch(/<[^>]*$/);
  });

  it("does not produce broken tags", () => {
    const html = '<a href="https://example.com">click here</a> and some more text padding';
    const result = truncateHtmlSafe(html, 40);
    expect(result.endsWith("...")).toBe(true);
    // The > in the opening tag should be a valid cut point
    expect(result).not.toContain('href="https://example.com">click here</a> and some more text pa...');
  });
});

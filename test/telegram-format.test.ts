import { describe, it, expect } from "vitest";
import { markdownToTelegramHtml, truncateHtmlSafe } from "../src/transports/telegram/format";
import { telegramHtmlProblem, htmlToVisible } from "./telegram-test-helpers";

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

  it("converts a __bold phrase__", () => {
    expect(markdownToTelegramHtml("hello __big world__")).toBe("hello <b>big world</b>");
  });

  it("leaves a single __word__ literal", () => {
    // This used to be bold. It cannot be told apart from `__init__` or
    // `__main__`, which models write far more often and which must stay literal.
    expect(markdownToTelegramHtml("hello __world__")).toBe("hello __world__");
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

  it("aligns columns correctly with wide emoji", () => {
    // ✅ is a wide emoji (2 display columns in monospace) but 1 codepoint
    const md = "| Name | Status |\n|------|--------|\n| Bold | ✅ |\n| Code | ok |";
    const html = markdownToTelegramHtml(md);
    const preMatch = html.match(/<pre>([\s\S]*?)<\/pre>/);
    expect(preMatch).not.toBeNull();
    const preContent = preMatch![1];
    const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    const lines = preContent.split("\n").filter(l => l.trim()).map(decode);
    // ✅ row should have 1 fewer space than "ok" row to compensate for the wider emoji
    // Telegram renders emoji at ~2 monospace columns (fractional, can't be exact)
    const emojiRow = lines[3];
    const plainRow = lines[4];
    expect(emojiRow.length).toBe(plainRow.length - 1); // 1 fewer char for 2-col emoji
    // Both should end with " │"
    expect(emojiRow.endsWith(" │")).toBe(true);
    expect(plainRow.endsWith(" │")).toBe(true);
  });

  it("aligns columns correctly with ZWJ emoji sequences", () => {
    // 👨‍👩‍👧 is a ZWJ sequence: 5 codepoints, 1 grapheme, 3 display columns in Telegram
    // Use short header "Ic" (2 cols) so ZWJ width (3) drives the column width
    const md = "| Name | Ic |\n|------|----|\n| fam | 👨\u200D👩\u200D👧 |\n| hi | x |";
    const html = markdownToTelegramHtml(md);
    const preMatch = html.match(/<pre>([\s\S]*?)<\/pre>/);
    expect(preMatch).not.toBeNull();
    const preContent = preMatch![1];
    const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    const lines = preContent.split("\n").filter(l => l.trim()).map(decode);
    // Column width should be max("Ic"=2, ZWJ=2, "x"=1) = 2
    const headerRow = lines[1];
    const plainRow = lines[4];
    expect(plainRow.length).toBe(headerRow.length);
    expect(lines[3].endsWith(" │")).toBe(true);
    expect(lines[4].endsWith(" │")).toBe(true);
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

// Model output the converter used to mangle. Each case was seen in a real answer.
describe("markdownToTelegramHtml — emphasis and tables in model output", () => {
  it("leaves arithmetic with spaced asterisks alone", () => {
    expect(markdownToTelegramHtml("2 * 3 * 4")).toBe("2 * 3 * 4");
    expect(markdownToTelegramHtml("so a * b = c * d here")).toBe("so a * b = c * d here");
  });

  it("leaves unspaced arithmetic between numbers alone", () => {
    expect(markdownToTelegramHtml("2*3*4 and 2**10")).toBe("2*3*4 and 2**10");
  });

  it("renders a `* ` bullet with emphasis inside as a bullet with italics", () => {
    expect(markdownToTelegramHtml("* a *b* c")).toBe("* a <i>b</i> c");
  });

  it("renders a whole `* ` list", () => {
    const md = "* one\n* two *em* x\n* **three**\n  * nested `code`";
    expect(markdownToTelegramHtml(md)).toBe("* one\n* two <i>em</i> x\n* <b>three</b>\n  * nested <code>code</code>");
  });

  it("keeps __init__ and other double-underscore names literal", () => {
    expect(markdownToTelegramHtml("__init__")).toBe("__init__");
    expect(markdownToTelegramHtml("call __init__ first")).toBe("call __init__ first");
    expect(markdownToTelegramHtml("see __init__.py and obj.__class__.__name__")).toBe("see __init__.py and obj.__class__.__name__");
    expect(markdownToTelegramHtml('if __name__ == "__main__":')).toBe('if __name__ == "__main__":');
  });

  it("keeps snake_case_name literal in prose", () => {
    expect(markdownToTelegramHtml("set snake_case_name and _private_field_name here")).toBe(
      "set snake_case_name and _private_field_name here",
    );
  });

  it("still renders a multi-word __bold phrase__ and _italic_", () => {
    expect(markdownToTelegramHtml("a __bold phrase__ and _italic_ word")).toBe("a <b>bold phrase</b> and <i>italic</i> word");
  });

  it("degrades mis-nested emphasis to valid HTML", () => {
    const html = markdownToTelegramHtml("**bold _both** tail_");
    expect(telegramHtmlProblem(html)).toBeNull();
    expect(html).toBe("<b>bold _both</b> tail_");
  });

  it("renders backslash-escaped asterisks literally", () => {
    expect(markdownToTelegramHtml("\\*not emphasis\\*")).toBe("*not emphasis*");
    expect(markdownToTelegramHtml("snake\\_case and \\_x\\_")).toBe("snake_case and _x_");
    expect(markdownToTelegramHtml("a \\`not code\\` b")).toBe("a `not code` b");
  });

  it("does not open emphasis on a delimiter followed by a space", () => {
    expect(markdownToTelegramHtml("a ** b ** c")).toBe("a ** b ** c");
    expect(markdownToTelegramHtml("use *args and **kwargs")).toBe("use *args and **kwargs");
    expect(markdownToTelegramHtml("match *.ts and *.js")).toBe("match *.ts and *.js");
  });

  it("keeps bold working next to punctuation and code", () => {
    expect(markdownToTelegramHtml("**Note**: done.")).toBe("<b>Note</b>: done.");
    expect(markdownToTelegramHtml("(**x**)")).toBe("(<b>x</b>)");
    expect(markdownToTelegramHtml("**`code`** and *`it`*")).toBe("<b><code>code</code></b> and <i><code>it</code></i>");
    expect(markdownToTelegramHtml("**a *b* c**")).toBe("<b>a <i>b</i> c</b>");
  });

  it("does not treat markdown inside inline code as formatting", () => {
    expect(markdownToTelegramHtml("`**x** _y_ [z](https://e.com)`")).toBe("<code>**x** _y_ [z](https://e.com)</code>");
  });

  it("reads table cells as inline markdown, emits them as plain text, and keeps the box layout", () => {
    const md = [
      "| Name | Notes |",
      "|------|-------|",
      "| **x** | `a|b` |",
      "| [link](https://example.com/p?a=1&b=2) | *it* and ~~old~~ |",
    ].join("\n");
    const html = markdownToTelegramHtml(md);

    expect(telegramHtmlProblem(html)).toBeNull();
    // The link works under the table; inside the box there is text only,
    // because Telegram's <pre> may not contain other entities.
    expect(html).toContain('<a href="https://example.com/p?a=1&amp;b=2">link</a>');
    const inside = html.match(/<pre>([\s\S]*?)<\/pre>/)![1];
    expect(inside).not.toMatch(/<\/?(b|i|s|u|code|a)\b/);
    expect(inside).toContain("x");
    expect(inside).toContain("a|b");
    expect(inside).toContain("it and old");
    // No markdown markers are left in the cells.
    expect(html).not.toContain("**");
    expect(html).not.toContain("`");
    expect(html).not.toContain("](");

    // Still one box: 6 lines, every row with two cells, all rows the same visible width.
    const box = html.match(/<pre>([\s\S]*?)<\/pre>/)![1];
    const rows = htmlToVisible(box).split("\n");
    expect(rows.length).toBe(6);
    for (const row of [rows[1], rows[3], rows[4]]) {
      expect(row.split("│").length - 1).toBe(3);
      expect(row.length).toBe(rows[0].length);
    }
    expect(rows[3]).toBe("│ x    │ a|b        │");
    expect(rows[4]).toBe("│ link │ it and old │");
  });

  it("repeats a table cell's link under the table, where Telegram makes it clickable", () => {
    const md = "| Doc | Where |\n|---|---|\n| guide | [here](https://example.com/guide) |\n| api | [here](https://example.com/api) |\nafter";
    const html = markdownToTelegramHtml(md);
    expect(html.endsWith(
      '</pre>\n<a href="https://example.com/guide">here</a>\n<a href="https://example.com/api">here</a>\nafter',
    )).toBe(true);
    // Inside the box the cell shows the link text only.
    expect(html.match(/<pre>([\s\S]*?)<\/pre>/)![1]).not.toContain("<a ");
  });

  it("does not split a table cell on an escaped pipe", () => {
    const html = markdownToTelegramHtml("| A | B |\n|---|---|\n| x \\| y | z |");
    const rows = htmlToVisible(html.match(/<pre>([\s\S]*?)<\/pre>/)![1]).split("\n");
    expect(rows[3]).toContain("x | y");
    expect(rows[3].split("│").length - 1).toBe(3);
  });

  it("emits well-formed HTML for awkward emphasis", () => {
    const cases = [
      "**bold _both** tail_",
      "*a **b* c**",
      "~~s **b~~ c**",
      "_a *b_ c*",
      "**unclosed",
      "*a* **b** ***c*** ****d****",
      "# **Title** with `code` and [l](https://e.com)",
      "> quote with **bold _mix** tail_",
      "[**bold** link](https://e.com) and [bad](ftp://x) <tag> & more",
      "a < b **c > d** & e",
      "***",
      "* * *",
      "_ _ _",
      "** **",
    ];
    for (const md of cases) {
      expect(telegramHtmlProblem(markdownToTelegramHtml(md)), md).toBeNull();
    }
  });
});

describe("markdownToTelegramHtml — fenced code", () => {
  it("renders a fence that is still open as a code block", () => {
    expect(markdownToTelegramHtml("```ts\nconst a = __x__;")).toBe("<pre>const a = __x__;</pre>");
  });

  it("does not end a block on backticks inside a code line", () => {
    const md = "```js\nconst fence = \"```\";\nconst b = 2;\n```\nafter";
    expect(markdownToTelegramHtml(md)).toBe('<pre>const fence = "```";\nconst b = 2;</pre>\nafter');
  });

  it("lets a longer fence hold a shorter one", () => {
    const md = "````md\n```js\nx\n```\n````";
    expect(markdownToTelegramHtml(md)).toBe("<pre>```js\nx\n```</pre>");
  });

  it("renders a fence indented under a list item, keeping the code as written", () => {
    const md = "1. Run:\n   ```bash\n   npm test\n   ```\n2. Done";
    expect(markdownToTelegramHtml(md)).toBe("1. Run:\n<pre>   npm test</pre>\n2. Done");
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

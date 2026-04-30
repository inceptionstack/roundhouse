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

/**
 * test/telegram-split.test.ts — splitting markdown into Telegram messages.
 *
 * The splitter must never lose a character, never produce a message longer
 * than Telegram accepts, and keep a code block a code block in every message
 * it spans. The last block checks those properties on a few hundred generated
 * documents; the generator (telegram-doc-generator.ts) is seeded, so a
 * failure names the seed that reproduces it.
 */

import { describe, it, expect } from "vitest";
import {
  TELEGRAM_MESSAGE_LIMIT,
  markdownToTelegramHtml,
  resumeMarkdownAt,
  splitMarkdownForTelegram,
  takeMarkdownChunk,
  type MarkdownChunk,
  hasVisibleText,
} from "../src/transports/telegram/format";
import { htmlToVisible, outsidePre, telegramHtmlProblem } from "./telegram-test-helpers";
import { CODE_MARK, PROSE_MARK, genDocument } from "./telegram-doc-generator";

const LIMIT = TELEGRAM_MESSAGE_LIMIT;

/**
 * The tests that loop over generated documents take a few seconds on a fast
 * machine and several times that on a loaded CI runner. Vitest's default of
 * 5 s made them fail there for speed alone, so they get their own timeout.
 */
const GENERATED_DOCS_TIMEOUT_MS = 60_000;

/** The source each chunk covers, in order */
function sources(md: string, chunks: MarkdownChunk[]): string[] {
  return chunks.map((c) => md.slice(c.start, c.end));
}

describe("splitMarkdownForTelegram", () => {
  it("returns one chunk for a short text, with nothing added", () => {
    const chunks = splitMarkdownForTelegram("**hello** world");
    expect(chunks).toEqual([
      { start: 0, end: 15, prefix: "", suffix: "", text: "**hello** world", html: "<b>hello</b> world" },
    ]);
  });

  it("returns no chunks for an empty text", () => {
    expect(splitMarkdownForTelegram("")).toEqual([]);
  });

  it("measures the rendered HTML, not the source", () => {
    // 3,900 source characters that render to 15,600.
    const md = Array.from({ length: 100 }, () => "<".repeat(39)).join("\n");
    const chunks = splitMarkdownForTelegram(md);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    for (const c of chunks) expect(c.html.length).toBeLessThanOrEqual(LIMIT);
    expect(sources(md, chunks).join("")).toBe(md);
  });

  it("keeps the markdown source within the limit too, for the plain-text fallback", () => {
    // 6,000 source characters that render to 3,000.
    const md = "\\*".repeat(3000);
    const chunks = splitMarkdownForTelegram(md);
    expect(chunks.length).toBe(2);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(LIMIT);
    expect(sources(md, chunks).join("")).toBe(md);
  });

  it("cuts at a line break and keeps the newline with the earlier chunk", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(40)}`);
    const md = lines.join("\n");
    const chunks = splitMarkdownForTelegram(md);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks.slice(0, -1)) expect(md[c.end - 1]).toBe("\n");
    for (const c of chunks.slice(1)) expect(md.slice(c.start).startsWith("line ")).toBe(true);
    expect(sources(md, chunks).join("")).toBe(md);
  });

  it("closes a code block at the end of a chunk and reopens it with the same info string", () => {
    const code = Array.from({ length: 200 }, (_, i) => `const v${i} = compute(${i}); // ${"y".repeat(20)}`);
    const md = "Intro\n\n```ts\n" + code.join("\n") + "\n```\n\nOutro";
    const chunks = splitMarkdownForTelegram(md);

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0].prefix).toBe("");
    expect(chunks[0].suffix).toBe("```");
    for (const c of chunks.slice(1, -1)) {
      expect(c.prefix).toBe("```ts\n");
      expect(c.suffix).toBe("```");
      expect(c.html.startsWith("<pre>const v")).toBe(true);
      expect(c.html.endsWith("</pre>")).toBe(true);
    }
    const last = chunks[chunks.length - 1];
    expect(last.prefix).toBe("```ts\n");
    expect(last.suffix).toBe("");
    expect(last.html.endsWith("</pre>\n\nOutro")).toBe(true);
    expect(sources(md, chunks).join("")).toBe(md);
  });

  it("reopens an indented or longer fence exactly as it was written", () => {
    const code = Array.from({ length: 150 }, (_, i) => `   row ${i} ${"z".repeat(40)}`);
    const md = "1. Step\n   ````yaml title\n" + code.join("\n") + "\n   ````\n2. Next";
    const chunks = splitMarkdownForTelegram(md);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].suffix).toBe("   ````");
    expect(chunks[1].prefix).toBe("   ````yaml title\n");
    for (const c of chunks) {
      expect(outsidePre(c.html)).not.toContain("row ");
      expect(c.html).not.toContain("`");
    }
  });

  it("does not leave an empty code block on either side of a cut", () => {
    // The block's opening line is the last line that fits the first message.
    const before = Array.from({ length: 45 }, (_, i) => `para ${i} ${"p".repeat(80)}`).join("\n");
    const code = Array.from({ length: 60 }, (_, i) => `code ${i} ${"c".repeat(80)}`).join("\n");
    const md = before + "\n```js\n" + code + "\n```\nend";
    const chunks = splitMarkdownForTelegram(md);

    for (const c of chunks) {
      expect(c.html).not.toContain("<pre></pre>");
      expect(c.html).not.toContain("<pre>\n</pre>");
    }
    expect(sources(md, chunks).join("")).toBe(md);
  });

  it("repeats a table's header when the table spans chunks", () => {
    const rows = Array.from({ length: 120 }, (_, i) => `| item ${i} | ${"v".repeat(30)} |`);
    const md = "| Name | Value |\n|------|-------|\n" + rows.join("\n");
    const chunks = splitMarkdownForTelegram(md);

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks.slice(1)) {
      expect(c.prefix).toBe("| Name | Value |\n|------|-------|\n");
    }
    for (const c of chunks) {
      expect(c.html.startsWith("<pre>┌")).toBe(true);
      expect(c.html).toContain("│ Name ");
      expect(c.html).not.toContain("|");
    }
    expect(sources(md, chunks).join("")).toBe(md);
  });

  it("cuts a line that is too long at a space", () => {
    const md = Array.from({ length: 1200 }, (_, i) => `word${i}`).join(" ");
    const chunks = splitMarkdownForTelegram(md);

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks.slice(0, -1)) expect(md[c.end - 1]).toBe(" ");
    expect(sources(md, chunks).join("")).toBe(md);
  });

  it("cuts a line without spaces wherever it has to, but never inside a surrogate pair", () => {
    const md = "😀".repeat(3000) + "a" + "😀".repeat(3000);
    const chunks = splitMarkdownForTelegram(md);

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const source of sources(md, chunks)) {
      expect(source.isWellFormed()).toBe(true);
    }
    expect(sources(md, chunks).join("")).toBe(md);
  });

  it("never cuts an HTML entity", () => {
    const md = "&<>".repeat(3000);
    const chunks = splitMarkdownForTelegram(md);

    for (const c of chunks) {
      expect(c.html.length).toBeLessThanOrEqual(LIMIT);
      expect(telegramHtmlProblem(c.html)).toBeNull();
    }
    expect(chunks.map((c) => htmlToVisible(c.html)).join("")).toBe(md);
  });

  it("does not let a piece of a long code line read as the closing fence", () => {
    // Cut at a space, the tail of this line would be "```".
    const line = "x".repeat(4050) + " ```";
    const md = "```\n" + line + "\nstill code\n```\nprose";
    const chunks = splitMarkdownForTelegram(md);

    for (const c of chunks) expect(outsidePre(c.html)).not.toContain("still code");
    expect(chunks[chunks.length - 1].html.endsWith("</pre>\nprose")).toBe(true);
    expect(sources(md, chunks).join("")).toBe(md);
  });

  it("does not let a piece of a long prose line read as an opening fence", () => {
    const line = "x".repeat(4050) + " ```js";
    const md = line + "\nstill prose";
    const chunks = splitMarkdownForTelegram(md);

    for (const c of chunks) expect(c.html).not.toContain("<pre>");
    expect(sources(md, chunks).join("")).toBe(md);
  });

  it("continues inside a code block when given the block's opening line as prefix", () => {
    const chunks = splitMarkdownForTelegram("b = 2\n```\nafter", LIMIT, "```py\n");
    expect(chunks.length).toBe(1);
    expect(chunks[0].html).toBe("<pre>b = 2</pre>\nafter");
  });

  it("works with a small limit", () => {
    const md = "Intro line\n```sh\n" + Array.from({ length: 30 }, (_, i) => `echo ${i}`).join("\n") + "\n```\nDone";
    const chunks = splitMarkdownForTelegram(md, 80);
    for (const c of chunks) {
      expect(c.html.length).toBeLessThanOrEqual(80);
      expect(outsidePre(c.html)).not.toContain("echo");
    }
    expect(sources(md, chunks).join("")).toBe(md);
  });
});

describe("takeMarkdownChunk", () => {
  it("takes the whole body when it fits", () => {
    const taken = takeMarkdownChunk("", "hello");
    expect(taken).toEqual({ length: 5, prefix: "", suffix: "", text: "hello", html: "hello", nextPrefix: "" });
  });

  it("closes a code block the body leaves open", () => {
    const taken = takeMarkdownChunk("", "```ts\nconst a = 1;");
    expect(taken.suffix).toBe("\n```");
    expect(taken.html).toBe("<pre>const a = 1;</pre>");
    expect(taken.nextPrefix).toBe("```ts\n");
  });

  it("says what the rest of the text needs in front of it", () => {
    const body = "```ts\n" + Array.from({ length: 200 }, (_, i) => `line ${i} ${"q".repeat(30)}`).join("\n");
    const taken = takeMarkdownChunk("", body);
    expect(taken.length).toBeLessThan(body.length);
    expect(body[taken.length - 1]).toBe("\n");
    expect(taken.nextPrefix).toBe("```ts\n");

    const next = takeMarkdownChunk(taken.nextPrefix, body.slice(taken.length));
    expect(next.html.startsWith("<pre>line ")).toBe(true);
  });
});

describe("resumeMarkdownAt", () => {
  const body = "intro\n```ts\nconst a = 1;\nconst b = 2;\n```\nend";

  it("continues prose where it stopped", () => {
    expect(resumeMarkdownAt("", body, 3)).toEqual({ offset: 3, prefix: "" });
  });

  it("reopens the code block when it stopped inside one", () => {
    const at = body.indexOf("const b");
    expect(resumeMarkdownAt("", body, at)).toEqual({ offset: at, prefix: "```ts\n" });
    expect(resumeMarkdownAt("", body, at + 4)).toEqual({ offset: at + 4, prefix: "```ts\n" });
  });

  it("starts after an opening fence it stopped inside", () => {
    const at = body.indexOf("```ts") + 2;
    expect(resumeMarkdownAt("", body, at)).toEqual({ offset: body.indexOf("const a"), prefix: "```ts\n" });
  });

  it("skips the closing fence it stopped at", () => {
    const at = body.indexOf("```\nend");
    expect(resumeMarkdownAt("", body, at)).toEqual({ offset: body.indexOf("end"), prefix: "" });
  });

  it("takes the prefix into account", () => {
    expect(resumeMarkdownAt("```py\n", "x = 1\ny = 2\n```\nz", 6)).toEqual({ offset: 6, prefix: "```py\n" });
  });

  it("keeps the rest of a line literal when it would read as a quote, header, rule or fence", () => {
    for (const rest of ["> b", "# b", "---", "```js"]) {
      const text = `a ${rest}\nnext`;
      const resume = resumeMarkdownAt("", text, 2);
      expect(resume).toEqual({ offset: 2, prefix: "\\" });
      const [chunk] = splitMarkdownForTelegram(text.slice(resume.offset), LIMIT, resume.prefix);
      expect(htmlToVisible(chunk.html)).toBe(`${rest}\nnext`);
    }
  });

  it("steps back inside a code line whose rest would read as the closing fence", () => {
    const code = "```\nx = 1 ```\ny = 2\n```";
    const at = code.indexOf(" ```") + 1;
    const resume = resumeMarkdownAt("", code, at);
    expect(resume).toEqual({ offset: code.indexOf("1 ```"), prefix: "```\n" });
    const [chunk] = splitMarkdownForTelegram(code.slice(resume.offset), LIMIT, resume.prefix);
    expect(chunk.html).toBe("<pre>1 ```\ny = 2</pre>");
  });
});

// ── Generated documents ───────────────────────────────

/** True if every code fence in `md` that opens also closes (checked independently of the converter) */
function fencesBalanced(md: string): boolean {
  let open: number | null = null;
  for (const line of md.split("\n")) {
    if (open === null) {
      const m = /^[ \t]*(`{3,})[^`]*$/.exec(line);
      if (m) open = m[1].length;
    } else {
      const m = /^[ \t]*(`{3,})\s*$/.exec(line);
      if (m && m[1].length >= open) open = null;
    }
  }
  return open === null;
}

/** Check one split against the properties. Returns the first problem, or null. */
function splitProblem(md: string, chunks: MarkdownChunk[], limit: number): string | null {
  let pos = 0;
  for (const [i, c] of chunks.entries()) {
    const at = `chunk ${i} of ${chunks.length}`;
    if (c.start !== pos) return `${at} starts at ${c.start}, expected ${pos}`;
    if (c.end <= c.start) return `${at} is empty`;
    pos = c.end;
    const source = md.slice(c.start, c.end);
    if (c.text !== c.prefix + source + c.suffix) return `${at}: text is not prefix + source + suffix`;
    if (c.html !== markdownToTelegramHtml(c.text)) return `${at}: html is not the rendering of text`;
    if (c.html.length > limit) return `${at}: html is ${c.html.length} long`;
    if (c.text.length > limit) return `${at}: text is ${c.text.length} long`;
    if (!source.isWellFormed()) return `${at}: source cuts a surrogate pair`;
    if (!fencesBalanced(c.text)) return `${at}: unbalanced fences`;
    const problem = telegramHtmlProblem(c.html);
    if (problem) return `${at}: ${problem}`;
    if (outsidePre(c.html).includes(CODE_MARK)) return `${at}: code outside a code block`;
    const blocks = c.html.match(/<pre>[\s\S]*?<\/pre>/g) ?? [];
    if (blocks.some((block) => block.includes(PROSE_MARK))) return `${at}: prose inside a code block`;
  }
  if (pos !== md.length) return `chunks end at ${pos}, text is ${md.length} long`;
  if (sources(md, chunks).join("") !== md) return "concatenated sources differ from the text";
  return null;
}

describe("splitMarkdownForTelegram — generated documents", () => {
  it("holds its properties for 400 documents at Telegram's limit", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const md = genDocument(seed, "full");
      const chunks = splitMarkdownForTelegram(md);
      expect(splitProblem(md, chunks, LIMIT), `seed ${seed}`).toBeNull();
    }
  }, GENERATED_DOCS_TIMEOUT_MS);

  it("holds its properties for 150 documents at smaller limits", () => {
    for (let seed = 1001; seed <= 1150; seed++) {
      const limit = [600, 1000, 2500][seed % 3];
      const md = genDocument(seed, "full");
      const chunks = splitMarkdownForTelegram(md, limit);
      expect(splitProblem(md, chunks, limit), `seed ${seed}, limit ${limit}`).toBeNull();
    }
  }, GENERATED_DOCS_TIMEOUT_MS);

  it("covers what it claims to: long documents, split code blocks, split tables, hard cuts", () => {
    let split = 0, reopenedFence = 0, repeatedTable = 0, hardCut = 0, longest = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const md = genDocument(seed, "full");
      const chunks = splitMarkdownForTelegram(md);
      longest = Math.max(longest, md.length);
      if (chunks.length > 1) split++;
      if (chunks.some((c) => c.prefix.startsWith("```") || c.prefix.startsWith("   ```"))) reopenedFence++;
      if (chunks.some((c) => c.prefix.startsWith("|"))) repeatedTable++;
      if (chunks.slice(0, -1).some((c) => md[c.end - 1] !== "\n")) hardCut++;
    }
    expect(split).toBeGreaterThan(250);
    expect(reopenedFence).toBeGreaterThan(100);
    expect(repeatedTable).toBeGreaterThan(20);
    expect(hardCut).toBeGreaterThan(100);
    expect(longest).toBeGreaterThan(30_000);
  }, GENERATED_DOCS_TIMEOUT_MS);
});

describe("splitMarkdownForTelegram — found in review", () => {
  const shows = (md: string) => splitMarkdownForTelegram(md).map((c) => hasVisibleText(c.html));

  it("never makes a message of a code fence alone when the block's first line is too long", () => {
    const md = "Here is the file:\n\n```json\n" + '{"k":"' + "x".repeat(5000) + '"}' + "\n```\nDone.";
    const chunks = splitMarkdownForTelegram(md);
    expect(chunks.map((c) => hasVisibleText(c.html))).toEqual([true, true, true]);
    expect(chunks.map((c) => md.slice(c.start, c.end)).join("")).toBe(md);
    for (const c of chunks) expect(c.html.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
  });

  it("never makes a message of blank lines alone before a line that is too long", () => {
    expect(shows("\n" + "x".repeat(5000))).toEqual([true, true]);
    expect(shows("intro\n\n\n" + "x".repeat(9000)).every(Boolean)).toBe(true);
  });

  it("still splits a table that is too wide to box in one message", () => {
    const cells = (text: (i: number) => string) => "| " + Array.from({ length: 30 }, (_, i) => text(i)).join(" | ") + " |";
    const md = [
      cells((i) => `Column number ${i} with a long title`),
      "|" + "---|".repeat(30),
      ...[1, 2, 3].map((n) => cells((i) => `value ${n}-${i}`)),
    ].join("\n");

    const chunks = splitMarkdownForTelegram(md);

    // A handful of messages, not one per character.
    expect(chunks.length).toBeLessThanOrEqual(6);
    expect(chunks.map((c) => md.slice(c.start, c.end)).join("")).toBe(md);
    for (const c of chunks) {
      expect(c.html.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
      expect(hasVisibleText(c.html)).toBe(true);
    }
  });

  it("knows a cut before a half-written row is inside the table", () => {
    const prose = Array.from({ length: 60 }, (_, i) => `Line ${i} of prose with some words to fill the line up nicely.`).join("\n");
    const head = "| Name | Value |\n|------|-------|\n";
    const rows = "| item 0 | 0 |\n| item 1 | 7 |\n";
    // The text so far ends in the middle of a row, as it does while streaming,
    // and that row is what no longer fits.
    const halfRow = "| item 2 | " + "y".repeat(400);
    const body = `${prose}\n\n${head}${rows}${halfRow}`;

    const taken = takeMarkdownChunk("", body);

    expect(body.slice(taken.length)).toBe(halfRow);
    expect(taken.nextPrefix).toBe(head);
  });
});

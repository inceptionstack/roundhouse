/**
 * Seeded generator of markdown documents for the Telegram splitting and
 * delivery tests: prose, lists, quotes, code blocks with and without info
 * strings, tables, lines too long for one message, HTML-special characters
 * and emoji. The same seed always gives the same document.
 */

/** Small seeded generator (mulberry32) */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)];
  return { next, int, pick, chance: (p: number) => next() < p };
}
export type Rng = ReturnType<typeof rng>;

const PROSE_WORDS = [
  "the", "cache", "is", "rebuilt", "when", "a < b", "x > y", "R&D", "<T>", "&amp;", "Map<string, number>",
  "**bold**", "*italic*", "_also italic_", "`inline <code>`", "~~gone~~", "[link](https://example.com/a?b=1&c=2)",
  "snake_case_name", "__init__", "2 * 3", "\\*escaped\\*", "😀", "👨‍👩‍👧", "日本語", "naïve", "é", "—", "100%",
  "path/to/file.ts", "(see below)", "\"quoted\"", "it's", "a|b", "`a|b`", "#hash", "> not a quote", "...",
];
/** Prose without inline markup, but with everything else that needs care */
const PLAIN_WORDS = [
  "the", "cache", "is", "rebuilt", "when", "a < b", "x > y", "R&D", "<T>", "&amp;", "Map<string, number>",
  "snake_case_name", "😀", "👨‍👩‍👧", "日本語", "naïve", "—", "100%", "path/to/file.ts", "(see below)",
  "\"quoted\"", "it's", "a|b", "#hash", "> not a quote", "# not a header", "...",
];
const CODE_WORDS = [
  "const", "x", "=", "<div>", "&&", "||", "a < b", "=>", "`tpl`", "\"```\"", "__x__", "**kw", "*args", "😀",
  "Map<string, Array<number>>", "// comment & more", "|", "# not a header", "[i](j)", "\\n", "    ",
];
const FENCE_INFO = ["", "ts", "python", "bash", "json", "diff", "c++", "ts title=\"a.ts\""];

/** Each code line carries this, so a test can tell code from prose in the output */
export const CODE_MARK = "ⓒ";
/** Each prose line carries this */
export const PROSE_MARK = "ⓟ";

function words(r: Rng, pool: readonly string[], count: number): string {
  return Array.from({ length: count }, () => r.pick(pool)).join(" ");
}

function genProse(r: Rng, pool: readonly string[]): string {
  const lines = Array.from({ length: r.int(1, 4) }, () => `${PROSE_MARK} ${words(r, pool, r.int(3, 40))}`);
  return lines.join(r.chance(0.5) ? "\n" : "\n\n");
}

function genList(r: Rng, pool: readonly string[]): string {
  const bullet = r.pick(["- ", "* ", "1. ", "  * "]);
  return Array.from({ length: r.int(2, 12) }, () => `${bullet}${PROSE_MARK} ${words(r, pool, r.int(1, 10))}`).join("\n");
}

function genHeaderOrQuote(r: Rng, pool: readonly string[]): string {
  const lead = r.pick(["# ", "## ", "### ", "> ", "> "]);
  return `${lead}${PROSE_MARK} ${words(r, pool, r.int(1, 8))}`;
}

function genFence(r: Rng, lineCount: number): string {
  const ticks = r.chance(0.15) ? "````" : "```";
  const indent = r.chance(0.15) ? "   " : "";
  const lines: string[] = [];
  for (let i = 0; i < lineCount; i++) {
    if (r.chance(0.06)) lines.push("");
    else if (ticks === "````" && r.chance(0.05)) lines.push(`${indent}\`\`\``);
    else lines.push(`${indent}${CODE_MARK} ${words(r, CODE_WORDS, r.int(1, 14))}`);
  }
  return `${indent}${ticks}${r.pick(FENCE_INFO)}\n${lines.join("\n")}\n${indent}${ticks}`;
}

function genTable(r: Rng, rowCount: number): string {
  const cols = r.int(2, 4);
  const cell = () => r.pick(["ok", "a & b", "<T>", "**x**", "`a|b`", "😀", "日本", "value " + r.int(0, 9999), "[l](https://e.com/x)"]);
  const row = () => `| ${Array.from({ length: cols }, cell).join(" | ")} |`;
  const head = `| ${Array.from({ length: cols }, (_, i) => `H${i}`).join(" | ")} |`;
  const sep = `|${Array.from({ length: cols }, () => "---").join("|")}|`;
  return [head, sep, ...Array.from({ length: rowCount }, row)].join("\n");
}

/** One line too long for a message */
function genLongLine(r: Rng): string {
  const unit = r.pick(["word ", "x", "<&>", "😀", "ab😀 ", "日本語", "a&b ", "long_snake_name "]);
  const target = r.int(3000, 9000);
  return `${PROSE_MARK} ` + unit.repeat(Math.ceil(target / unit.length));
}

function genLongCodeLine(r: Rng, withFenceLookalikes: boolean): string {
  const unit = r.pick(["x", "<&>", "😀", "ab cd ", "a && b || ", withFenceLookalikes ? "``` " : "`` "]);
  const target = r.int(3000, 9000);
  const line = `${CODE_MARK} ` + unit.repeat(Math.ceil(target / unit.length));
  return "```" + r.pick(FENCE_INFO) + "\n" + line + "\nafter the long line " + CODE_MARK + "\n```";
}

/**
 * What a generated document contains:
 *   - "full": everything.
 *   - "no-tables": no tables. A table split in two repeats its header, so
 *     what the reader sees is not simply the whole document cut in pieces.
 *   - "plain-prose": no tables, rules or inline markup either. For tests
 *     where a message stops in the middle of a line: half an emphasis shows
 *     its markers, which the whole document would not, and a code line that
 *     ends like a closing fence has a few characters sent twice.
 */
export type DocumentKind = "full" | "no-tables" | "plain-prose";

export function genDocument(seed: number, kind: DocumentKind): string {
  const r = rng(seed);
  const pool = kind === "plain-prose" ? PLAIN_WORDS : PROSE_WORDS;
  const blocks: string[] = [];
  const blockCount = r.int(1, 14);
  for (let i = 0; i < blockCount; i++) {
    const roll = r.next();
    if (roll < 0.3) blocks.push(genProse(r, pool));
    else if (roll < 0.4) blocks.push(genList(r, pool));
    else if (roll < 0.5) blocks.push(genHeaderOrQuote(r, pool));
    else if (roll < 0.7) blocks.push(genFence(r, r.int(0, 25)));
    else if (roll < 0.78) blocks.push(genFence(r, r.int(60, 220)));
    else if (roll < 0.84) blocks.push(genLongLine(r));
    else if (roll < 0.88) blocks.push(genLongCodeLine(r, kind !== "plain-prose"));
    else if (roll < 0.9 && kind !== "plain-prose") blocks.push("---");
    else if (kind === "full") blocks.push(genTable(r, r.chance(0.3) ? r.int(40, 150) : r.int(1, 8)));
    else blocks.push(genProse(r, pool));
  }
  let md = "";
  for (const block of blocks) md += block + (r.chance(0.7) ? "\n\n" : "\n");
  return r.chance(0.5) ? md : md.trimEnd();
}

/** Everything a reader sees, without line breaks (a cut may add or remove one) */
export function flat(visible: string[]): string {
  return visible.join("").replace(/\n/g, "");
}

/** Where two strings first differ, with some context, or null if they are equal */
export function firstDifference(got: string, want: string): string | null {
  if (got === want) return null;
  let i = 0;
  while (i < got.length && got[i] === want[i]) i++;
  const show = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 40), i + 40));
  return `at ${i}: got ${show(got)}, want ${show(want)}`;
}

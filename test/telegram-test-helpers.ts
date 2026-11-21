/**
 * Shared doubles for the Telegram rendering and delivery tests.
 *
 * `fakeTelegram` stands in for a Chat SDK thread backed by the Telegram
 * adapter. It records every Bot API call and keeps what each message would
 * show after its edits, so a test can assert on what the reader ends up with.
 */

export const TELEGRAM_LIMIT = 4096;

export interface TelegramCall {
  method: string;
  payload: any;
  /** Clock value when the call was made (0 without a clock) */
  at: number;
  /** True when the fake rejected the call */
  failed: boolean;
}

export interface FakeTelegram {
  id: string;
  adapter: { telegramFetch: (method: string, payload: any) => Promise<any> };
  calls: TelegramCall[];
  /** Final content of each message, in the order the messages were created */
  messages: () => Array<{ id: number; text: string; html: boolean }>;
  /** What a reader sees: every message's visible text, in order */
  visible: () => string[];
}

export interface FakeTelegramOptions {
  chatId?: string;
  /** Return an error to reject the call (after it is recorded) */
  fail?: (call: TelegramCall, index: number) => unknown;
  /** Clock used to stamp calls */
  now?: () => number;
}

export function fakeTelegram(opts: FakeTelegramOptions = {}): FakeTelegram {
  const chatId = opts.chatId ?? "12345";
  const calls: TelegramCall[] = [];
  const state = new Map<number, { text: string; html: boolean }>();
  let nextId = 1;

  const telegramFetch = async (method: string, payload: any) => {
    const call: TelegramCall = { method, payload, at: opts.now?.() ?? 0, failed: false };
    calls.push(call);
    const err = opts.fail?.(call, calls.length - 1);
    if (err) {
      call.failed = true;
      throw err;
    }
    const html = payload.parse_mode === "HTML";
    if (method === "sendMessage") {
      const id = nextId++;
      state.set(id, { text: payload.text, html });
      return { message_id: id, chat: { id: Number(chatId) } };
    }
    if (method === "editMessageText") {
      state.set(payload.message_id, { text: payload.text, html });
      return true;
    }
    return true;
  };

  const messages = () => [...state.entries()].map(([id, m]) => ({ id, ...m }));

  return {
    id: `telegram:${chatId}`,
    adapter: { telegramFetch },
    calls,
    messages,
    visible: () => messages().map((m) => (m.html ? htmlToVisible(m.text) : m.text)),
  };
}

/** The error the Telegram adapter throws on HTTP 429 */
export function rateLimitError(retryAfterSeconds?: number): Error {
  const err = new Error(`Rate limited by telegram, retry after ${retryAfterSeconds}s`) as Error & { retryAfter?: number };
  err.name = "AdapterRateLimitError";
  err.retryAfter = retryAfterSeconds;
  return err;
}

/** A clock and a sleep that only moves that clock */
export function fakeClock(start = 1_000_000) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
    sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
    sleeps,
  };
}

/** Strip Telegram HTML down to the text a reader sees */
export function htmlToVisible(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/** The parts of an HTML message that are not inside a <pre> block */
export function outsidePre(html: string): string {
  return html.replace(/<pre>[\s\S]*?<\/pre>/g, "");
}

/**
 * Check that a string is well-formed for Telegram's HTML subset: only the
 * tags Telegram accepts, properly nested and closed, and no bare `<`, `>`
 * or `&`. Returns a description of the first problem, or null.
 */
export function telegramHtmlProblem(html: string): string | null {
  const allowed = new Set(["b", "i", "u", "s", "code", "pre", "a", "blockquote"]);
  const stack: string[] = [];
  const re = /<(\/?)([a-zA-Z]+)((?:\s+[a-zA-Z-]+="[^"<>]*")*)>|[<>]|&(?!(?:amp|lt|gt|quot);)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[2] === undefined) return `bare "${m[0]}" at ${m.index}`;
    const tag = m[2];
    if (!allowed.has(tag)) return `tag <${tag}> is not in Telegram's subset`;
    if (m[1]) {
      const open = stack.pop();
      if (open !== tag) return `</${tag}> at ${m.index} closes <${open ?? "nothing"}>`;
    } else {
      stack.push(tag);
    }
  }
  return stack.length ? `unclosed <${stack[stack.length - 1]}>` : null;
}

/** Yield the text in pieces of `size` characters, calling `tick` before each */
export async function* inPieces(text: string, size: number, tick?: () => void): AsyncIterable<string> {
  for (let i = 0; i < text.length; i += size) {
    tick?.();
    yield text.slice(i, i + size);
  }
}

/**
 * An answer like the one that lost lines: prose, then a long code block
 * whose lines grow when HTML-escaped, then prose.
 */
export function longAnswerWithCode(codeLines = 140): { markdown: string; code: string[] } {
  const code: string[] = [];
  for (let i = 1; i <= codeLines; i++) {
    code.push(`  const cache${i}: Map<string, Array<number>> = new Map(); // entry ${i} & its <T>`);
  }
  const intro = Array.from({ length: 6 }, (_, i) =>
    `Paragraph ${i + 1}: the registry keeps one cache per tenant and rebuilds it lazily, so a cold start costs a full scan.`,
  ).join("\n\n");
  const outro = "That is the whole change. **Run the migration** before deploying, then check `cache_hits` in the dashboard.";
  const markdown = `${intro}\n\n\`\`\`ts\n${code.join("\n")}\n\`\`\`\n\n${outro}\n`;
  return { markdown, code };
}

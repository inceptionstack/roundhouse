/**
 * agents/pi/turn-transcript.ts — a turn of the pi conversation as plain text
 *
 * `/stop` hands what the agent did in the turn it interrupted to a reviewer.
 * The reviewer needs the owner's request, every step the agent took (what it
 * said, which tool it called with what, what came back) and where it stopped,
 * and it needs them in a size it can read: tool output is cut to its start and
 * end, and when the whole turn is still too long the oldest steps go and the
 * newest stay, because the end is where the turn was stopped.
 *
 * Pure: takes the session's messages, returns text. The pi message shapes are
 * read defensively (an unknown role or block is named, never thrown on).
 */

export interface TurnTranscript {
  /** Markdown for the reviewer. */
  text: string;
  /** The owner's request that began the turn, cleaned of injected blocks. */
  request: string;
  /** Tool calls the agent made in the turn. */
  toolCalls: number;
  /** Steps left out of `text` because the turn was too long (oldest first). */
  stepsOmitted: number;
  /** How the last assistant message ended ("aborted" after /stop), if it says. */
  lastStopReason?: string;
}

export interface TurnTranscriptOptions {
  /** Upper bound for `text`, in characters. Default 80,000. */
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 80_000;
const REQUEST_CAP = 6_000;
const SAY_CAP = 3_000;
const CALL_CAP = 1_500;
const RESULT_HEAD = 1_000;
const RESULT_TAIL = 500;

/** Keep the start and the end of a long text, and say how much was left out. */
export function clip(text: string, head: number, tail = 0): string {
  if (text.length <= head + tail + 40) return text;
  const cut = text.length - head - tail;
  const end = tail > 0 ? text.slice(text.length - tail) : "";
  return `${text.slice(0, head)}\n[… ${cut} characters left out …]\n${end}`.trimEnd();
}

/** What roundhouse adds in front of a message is not the owner's request. */
export function stripInjected(text: string): string {
  return text
    .replace(/<roundhouse_memory\b[^>]*>[\s\S]*?<\/roundhouse_memory>/g, "[memory block left out]")
    .replace(/<persona>[\s\S]*?<\/persona>/g, "[persona left out]")
    .replace(/<tools>[\s\S]*?<\/tools>/g, "[tool notes left out]")
    .trim();
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: unknown };
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b.type === "image") parts.push("[image]");
  }
  return parts.join("\n");
}

function clock(ts: unknown): string {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} `;
}

function argsOf(args: unknown): string {
  let s: string;
  try { s = JSON.stringify(args ?? {}); } catch { s = String(args); }
  return clip(s, CALL_CAP);
}

interface Step { text: string; toolCalls: number }

export function renderTurn(messages: readonly unknown[], opts: TurnTranscriptOptions = {}): TurnTranscript | null {
  const maxChars = Math.max(2_000, opts.maxChars ?? DEFAULT_MAX_CHARS);

  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as { role?: string } | undefined)?.role === "user") { start = i; break; }
  }
  if (start < 0) return null;

  const first = messages[start] as { content?: unknown; timestamp?: unknown };
  const request = clip(stripInjected(textOf(first.content)), REQUEST_CAP);

  const steps: Step[] = [];
  const names = new Map<string, string>();
  let toolCalls = 0;
  let lastStopReason: string | undefined;

  for (let i = start + 1; i < messages.length; i++) {
    const m = messages[i] as {
      role?: string; content?: unknown; timestamp?: unknown; stopReason?: string;
      errorMessage?: string; toolName?: string; toolCallId?: string; isError?: boolean; customType?: string;
    } | undefined;
    if (!m || typeof m !== "object") continue;

    if (m.role === "assistant") {
      if (Array.isArray(m.content)) {
        for (const block of m.content as Array<Record<string, unknown>>) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
            steps.push({ text: `${clock(m.timestamp)}ASSISTANT SAID: ${clip(block.text.trim(), SAY_CAP, 500)}`, toolCalls: 0 });
          } else if (block.type === "toolCall") {
            toolCalls++;
            const id = String(block.id ?? "");
            const name = String(block.name ?? "?");
            if (id) names.set(id, name);
            steps.push({ text: `${clock(m.timestamp)}ASSISTANT CALLED ${name} ${argsOf(block.arguments)}`, toolCalls: 1 });
          }
          // Thinking is the model's own scratch work; the reviewer judges what was done and said.
        }
      }
      if (m.stopReason) lastStopReason = m.stopReason;
      if (m.stopReason === "aborted" || m.stopReason === "error" || m.errorMessage) {
        steps.push({ text: `ASSISTANT MESSAGE ENDED: ${m.stopReason ?? "error"}${m.errorMessage ? ` (${clip(m.errorMessage, 300)})` : ""}`, toolCalls: 0 });
      }
    } else if (m.role === "toolResult") {
      const name = m.toolName ?? names.get(String(m.toolCallId ?? "")) ?? "tool";
      const body = textOf(m.content).trim() || "(no output)";
      steps.push({ text: `${clock(m.timestamp)}RESULT OF ${name}${m.isError ? " (ERROR)" : ""}: ${clip(body, RESULT_HEAD, RESULT_TAIL)}`, toolCalls: 0 });
    } else if (m.role === "user") {
      // A second user message inside the span cannot happen (start is the last one).
      continue;
    } else {
      steps.push({ text: `[${m.role ?? "unknown"}${m.customType ? `:${m.customType}` : ""} message]`, toolCalls: 0 });
    }
  }

  const head = `# The turn the owner stopped\n\n## The owner's request\n${clock(first.timestamp)}${request || "(no text)"}\n\n## What the assistant did, in order\n`;
  const tailNote = (omitted: number) => omitted > 0
    ? `[… the first ${omitted} step${omitted === 1 ? "" : "s"} of the turn left out, it was too long; the newest are below …]\n\n`
    : "";
  const none = "(nothing yet: the turn was stopped before the assistant did anything)\n";

  // Newest steps first until the budget is used, then back into order.
  let budget = maxChars - head.length - 200;
  const kept: Step[] = [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const cost = steps[i].text.length + 2;
    if (cost > budget && kept.length > 0) break;
    kept.unshift(steps[i]);
    budget -= cost;
  }
  const omitted = steps.length - kept.length;
  const body = kept.length ? kept.map((s) => s.text).join("\n\n") + "\n" : none;
  let text = head + tailNote(omitted) + body;
  if (text.length > maxChars) text = text.slice(0, maxChars - 40) + "\n[… cut at the size limit …]\n";

  return { text, request, toolCalls, stepsOmitted: omitted, lastStopReason };
}
